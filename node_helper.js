const NodeHelper = require('node_helper');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const awsCredentials = require('./utils/awsCredentials');
const loadEnv = require('./utils/loadEnv');
const Log = require('logger');

/**
 * Executes `fn` over every item in `items` with at most `poolLimit`
 * concurrent invocations, matching the semantics of
 * `Promise.all(items.map(fn))` but bounding the number of in-flight
 * promises.
 */
async function asyncPool(poolLimit, items, fn) {
    const executing = new Set();
    const results = new Array(items.length);

    for (let i = 0; i < items.length; i++) {
        const p = Promise.resolve().then(() => fn(items[i], i));
        results[i] = p;

        if (poolLimit <= items.length) {
            const e = p.then(() => executing.delete(e));
            executing.add(e);
            if (executing.size >= poolLimit) {
                await Promise.race(executing);
            }
        }
    }

    return Promise.all(results);
}

module.exports = NodeHelper.create({
    start: function() {
        Log.info(`Starting node helper for module: ${this.name}`);
        this.initialized = false;
        this.initializationInProgress = false;
        this.s3Client = null;
        this.lambdaClient = null;
        this.bucketName = null;
        this.manifest = null;
        
        // Set up module paths
        this.moduleDir = path.resolve(__dirname);
        this.cacheDir = path.join(this.moduleDir, 'cache');
        
        // Ensure cache directory exists
        try {
            if (!fs.existsSync(this.cacheDir)) {
                Log.info(`Creating cache directory at: ${this.cacheDir}`);
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }
        } catch (error) {
            Log.error('Error creating cache directory:', error);
        }
        
        Log.info('Module directory:', this.moduleDir);
        Log.info('Cache directory:', this.cacheDir);

        // Debounce map for fs.watch events
        const debounceTimers = new Map();

        fs.watch(this.cacheDir, async (eventType, filename) => {
            if (eventType !== 'change') return;

            if (filename !== 'last_upload.json' && filename !== 'last_update.json') return;

            // Clear existing timer for this file to debounce rapid events
            if (debounceTimers.has(filename)) {
                clearTimeout(debounceTimers.get(filename));
            }

            debounceTimers.set(filename, setTimeout(async () => {
                debounceTimers.delete(filename);

                if (filename === 'last_upload.json') {
                    try {
                        const uploadFile = path.join(this.cacheDir, 'last_upload.json');
                        const data = JSON.parse(await fsp.readFile(uploadFile, 'utf8'));
                        if (data.newPhotos) {
                            await this.updateManifestWithNewPhotos(data.newPhotos);
                            this.sendSocketNotification("PHOTOS_UPDATED", await this.getPhotosFromS3());
                            // Clean up the notification file
                            await fsp.unlink(uploadFile);
                        }
                    } catch (error) {
                        Log.error('Error processing upload notification:', error);
                    }
                }

                if (filename === 'last_update.json') {
                    try {
                        const updateFile = path.join(this.cacheDir, 'last_update.json');
                        const data = JSON.parse(await fsp.readFile(updateFile, 'utf8'));
                        if (data.type === 'FILES_DELETED' && Array.isArray(data.files)) {
                            Log.info(`Processing deletion of ${data.files.length} files`);

                            // Trigger Lambda sync to get updated file list
                            await this.handleGetPhotos();

                            // Clean up notification file
                            await fsp.unlink(updateFile);
                        }
                    } catch (error) {
                        Log.error('Error processing update notification:', error);
                    }
                }
            }, 50));
        });
    },

    /**
     * One-time migration for users upgrading from a version that did not
     * create a backup file.  If the legacy credential files exist
     * but no backup has been made yet, we create one now so that future
     * restores and runtime credential loading use the encrypted backup.
     */
    async migrateToBackupIfNeeded() {
        const backupPath = path.join(this.moduleDir, 'mmm-s3photos-backup.json');
        const credsPath  = path.join(this.moduleDir, 'local_aws-credentials');
        const resPath    = path.join(this.moduleDir, 'aws-resources.json');

        if (fs.existsSync(backupPath)) return; // never overwrite
        if (!fs.existsSync(credsPath) || !fs.existsSync(resPath)) return; // nothing to migrate

        try {
            // Parse the legacy credentials file (key=value format)
            const rawCreds = fs.readFileSync(credsPath, 'utf8')
                .split('\n')
                .reduce((acc, line) => {
                    const [key, value] = line.split('=').map(s => s.trim());
                    if (key && value) {
                        const clean = key.replace(/^aws_/, '');
                        acc[clean] = value;
                    }
                    return acc;
                }, {});

            const awsResources = JSON.parse(fs.readFileSync(resPath, 'utf8'));

            const backup = {
                createdAt:   new Date().toISOString(),
                migratedAt:  new Date().toISOString(),
                credentials: {
                    accessKeyId:     rawCreds.access_key_id,
                    secretAccessKey: rawCreds.secret_access_key,
                    region:          rawCreds.region,
                    accountId:       rawCreds.account_id
                },
                awsResources
            };

            fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
            Log.info('MMM-S3Photos: Migrated credentials to encrypted backup file.');
        } catch (err) {
            Log.warn('MMM-S3Photos: Could not migrate credentials to backup file:', err.message);
        }
    },

    /**
     * If aws-resources.json is newer than the backup file (e.g. after a CDK
     * redeploy that ran outside of setup.js), pull the updated resource names
     * into the backup so runtime always reads from one authoritative source.
     */
    refreshBackupIfStale() {
        const backupPath = path.join(this.moduleDir, 'mmm-s3photos-backup.json');
        const resPath    = path.join(this.moduleDir, 'aws-resources.json');

        if (!fs.existsSync(backupPath) || !fs.existsSync(resPath)) return;

        const backupMtime = fs.statSync(backupPath).mtime;
        const resMtime    = fs.statSync(resPath).mtime;

        if (resMtime <= backupMtime) return; // backup is already current

        try {
            const backup       = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            const newResources = JSON.parse(fs.readFileSync(resPath, 'utf8'));

            backup.awsResources = newResources;
            backup.updatedAt    = new Date().toISOString();

            fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
            Log.info('MMM-S3Photos: Backup refreshed from updated aws-resources.json (CDK redeploy detected)');
        } catch (err) {
            Log.warn('MMM-S3Photos: Could not refresh backup from aws-resources.json:', err.message);
        }
    },

    async initializeModule() {
        if (this.initialized) {
            Log.info('Module already initialized');
            return true;
        }

        if (this.initializationInProgress) {
            Log.info('Initialization already in progress');
            return false;
        }

        try {
            this.initializationInProgress = true;
            Log.info('Starting module initialization');

            // Create encrypted backup from legacy files if this is the first
            // run after an upgrade from a version that did not produce one.
            await this.migrateToBackupIfNeeded();

            // If aws-resources.json was refreshed by a CDK redeploy after the
            // backup was created, pull the new resource names into the backup.
            this.refreshBackupIfStale();

            // First ensure environment variables are loaded from local files
            const envLoaded = await this.ensureEnvironment();
            if (!envLoaded) {
                throw new Error("Failed to load environment variables from local configuration");
            }

            // Initialize AWS clients
            await this.initializeAwsClients();
            
            this.initialized = true;
            Log.info('Module initialization completed successfully');
            return true;
        } catch (error) {
            Log.error('Module initialization failed:', error);
            this.initialized = false;
            throw error;
        } finally {
            this.initializationInProgress = false;
        }
    },

    socketNotificationReceived: async function(notification, payload) {
        switch(notification) {
            case "INIT":
                // ... existing init code ...
                break;
                
            case "GET_PHOTOS":
                try {
                    // Ensure module is initialized before proceeding
                    if (!this.initialized) {
                        await this.initializeModule();
                    }
                    await this.handleGetPhotos(payload);
                } catch (error) {
                    console.error("MMM-S3Photos Error:", error);
                    this.sendSocketNotification("PHOTOS_ERROR", error.message || "Failed to fetch photos");
                }
                break;
                
            case "USB_PHOTOS_UPLOADED":
                Log.info("Received USB photos upload notification");
                if (payload && payload.newPhotos) {
                    // Update the manifest with new photos
                    await this.updateManifestWithNewPhotos(payload.newPhotos);
                    // Trigger a refresh of the display
                    this.sendSocketNotification("PHOTOS_UPDATED", await this.getPhotosFromS3());
                }
                break;
                
            case "GPHOTO_UPLOAD":
                Log.info("Received new selfie photo notification");
                if (payload) {
                    await this.handleNewPhoto(payload);
                    // Refresh photos after handling new photo
                    this.sendSocketNotification("PHOTOS_UPDATED", await this.getPhotosFromS3());
                }
                break;
        }
    },

    getPhotos: async function(config) {
        try {
            if (!this.initialized) {
                await this.initializeModule();
            }

            const photos = await this.getPhotosFromS3();
            
            // Add additional validation for photo objects
            const validatedPhotos = photos.map(photo => {
                return {
                    url: photo.url,
                    key: photo.key,
                    lastModified: photo.lastModified,
                    // Add validation flag for frontend
                    isValid: Boolean(photo.url && photo.key)
                };
            });

            return validatedPhotos;

        } catch (error) {
            console.error("MMM-S3Photos getPhotos Error:", error);
            throw error;
        }
    },

    // Add helper method for URL validation if needed
    validatePhotoUrl: function(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    },

    async handleGetPhotos(payload) {
        try {
            Log.info('Starting photo retrieval process');
            const photos = await awsCredentials.withCredentials(async () => {
                return await this.getPhotosFromS3();
            });

            if (!Array.isArray(photos)) {
                throw new Error('Invalid photos data received: expected array');
            }

            Log.info(`Retrieved ${photos.length} photos`);
            this.sendSocketNotification('PHOTOS_UPDATED', photos);
        } catch (error) {
            Log.error('Error getting photos:', error);
            this.sendSocketNotification('PHOTOS_ERROR', error.message);
        }
    },

    async getPhotosFromS3() {
        try {
            Log.info('Requesting photo manifest from Lambda');
            
            Log.info('Environment configuration:', {
                lambdaFunction: process.env.LAMBDA_FUNCTION_NAME,
                region: process.env.AWS_REGION,
                bucket: process.env.BUCKET_NAME
            });

            let currentManifest = this.manifest || [];
            const manifestPath = path.join(this.cacheDir, 'photos.json');
            
            try {
                if (fs.existsSync(manifestPath) && !this.manifest) {
                    const manifestData = await fsp.readFile(manifestPath, 'utf8');
                    currentManifest = JSON.parse(manifestData);
                    this.manifest = currentManifest;
                }
            } catch (error) {
                Log.warn('Error reading manifest:', error);
                currentManifest = [];
                this.manifest = null;
            }
            
            const command = new InvokeCommand({
                FunctionName: process.env.LAMBDA_FUNCTION_NAME,
                Payload: JSON.stringify({ 
                    currentManifest,
                    bucket: process.env.BUCKET_NAME 
                }),
                InvocationType: 'RequestResponse'
            });

            Log.info('Invoking Lambda function...');
            const response = await this.lambdaClient.send(command);
            
            if (response.FunctionError) {
                const errorPayload = JSON.parse(Buffer.from(response.Payload).toString());
                Log.error('Lambda function error:', errorPayload);
                throw new Error(`Lambda error: ${errorPayload.errorMessage || 'Unknown error'}`);
            }

            const payload = JSON.parse(Buffer.from(response.Payload).toString());
            Log.info('Lambda response:', payload);

            if (!payload || typeof payload !== 'object') {
                throw new Error('Invalid response from Lambda');
            }

            if (!Array.isArray(payload.toDownload) || !Array.isArray(payload.toDelete)) {
                throw new Error('Lambda response missing required arrays');
            }

            // Process deletions
            for (const fileToDelete of payload.toDelete) {
                try {
                    // Delete from cache directory
                    const localPath = path.join(this.cacheDir, fileToDelete.key);
                    try {
                        await fsp.unlink(localPath);
                        Log.info(`Deleted local file: ${localPath}`);
                    } catch (unlinkError) {
                        if (unlinkError.code !== 'ENOENT') {
                            throw unlinkError;
                        }
                    }
                    
                    // Also check for the file in the root of cache dir
                    const rootPath = path.join(this.cacheDir, path.basename(fileToDelete.key));
                    try {
                        await fsp.unlink(rootPath);
                        Log.info(`Deleted root cache file: ${rootPath}`);
                    } catch (unlinkError) {
                        if (unlinkError.code !== 'ENOENT') {
                            throw unlinkError;
                        }
                    }
                } catch (error) {
                    Log.error(`Error deleting file ${fileToDelete.key}:`, error);
                }
            }

            // Process downloads with bounded concurrency
            const CONCURRENCY_LIMIT = 6;
            const downloadResults = await asyncPool(
                CONCURRENCY_LIMIT,
                payload.toDownload,
                async (item) => {
                    try {
                        const relativePath = await this.downloadPhoto(item.key);
                        return {
                            url: relativePath,
                            key: item.key,
                            lastModified: item.lastModified,
                            size: item.size
                        };
                    } catch (error) {
                        Log.error(`Failed to download photo ${item.key}:`, error);
                        return null;
                    }
                }
            );

            // Filter out failed downloads
            const successfulDownloads = downloadResults.filter(result => result !== null);

            const updatedManifest = currentManifest
                .filter(photo => !payload.toDelete.some(d =>
                    d.key === photo.key ||
                    path.basename(d.key) === path.basename(photo.key)
                ))
                .concat(successfulDownloads);

            await fsp.writeFile(
                manifestPath,
                JSON.stringify(updatedManifest, null, 2)
            );
            this.manifest = updatedManifest;

            Log.info(`Manifest updated: Removed ${payload.toDelete.length} files, added ${successfulDownloads.length} files`);
            return updatedManifest;

        } catch (error) {
            Log.error('Error in getPhotosFromS3:', error);
            
            // Try to use cached manifest as fallback
            try {
                const manifestPath = path.join(this.cacheDir, 'photos.json');
                if (fs.existsSync(manifestPath)) {
                    const manifestData = await fsp.readFile(manifestPath, 'utf8');
                    const cachedManifest = JSON.parse(manifestData);
                    
                    if (Array.isArray(cachedManifest) && cachedManifest.length > 0) {
                        this.manifest = cachedManifest;
                        Log.info(`Using cached manifest with ${cachedManifest.length} photos`);
                        return cachedManifest;
                    }
                }
            } catch (fallbackError) {
                Log.error('Fallback to cache failed:', fallbackError);
            }
            
            throw error;
        }
    },

    async downloadPhoto(key) {
        try {
            Log.info(`Downloading photo: ${key}`);
            const getObjectParams = {
                Bucket: this.bucketName,
                Key: key
            };

            const data = await this.s3Client.send(new GetObjectCommand(getObjectParams));
            
            // Create full cache path including subdirectories
            const localPath = path.join(this.cacheDir, key);
            
            // Create subdirectories if they don't exist
            await fsp.mkdir(path.dirname(localPath), { recursive: true });
            
            const buffer = Buffer.from(await data.Body.transformToByteArray());
            
            await fsp.writeFile(localPath, buffer);
            Log.info(`Successfully downloaded ${key} to ${localPath}`);
            
            // Return path relative to module root, maintaining folder structure
            return path.join('cache', key);
        } catch (error) {
            Log.error(`Error downloading photo ${key}:`, error);
            throw error;
        }
    },

    async initializeAwsClients() {
        try {
            await awsCredentials.withCredentials(async () => {
                Log.info('Initializing AWS clients with:', {
                    region: process.env.AWS_REGION,
                    bucket: process.env.BUCKET_NAME
                });

                this.s3Client = new S3Client({ region: process.env.AWS_REGION });
                this.lambdaClient = new LambdaClient({ region: process.env.AWS_REGION, maxAttempts: 3 });
                this.bucketName = process.env.BUCKET_NAME;
                Log.info('AWS clients initialized successfully');
            });
        } catch (error) {
            Log.error('Failed to initialize AWS clients:', error);
            throw error;
        }
    },

    stop: function() {
        Log.info('Stopping node helper');
        if (this.s3Client) {
            this.s3Client.destroy();
            this.s3Client = null;
        }
        if (this.lambdaClient) {
            this.lambdaClient.destroy();
            this.lambdaClient = null;
        }
    },

    async cleanupCache() {
        if (!this.config.cacheLifeDays) {
            Log.info('Cache cleanup disabled (cacheLifeDays = 0)');
            return;
        }

        try {
            Log.info('Cleaning up cache directory');
            const now = Date.now();
        
            // Recursive helper to walk directories and delete stale files
            const walkAndClean = async (dir) => {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                await Promise.all(entries.map(async (entry) => {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walkAndClean(entryPath);
                    } else {
                        const stats = await fsp.stat(entryPath);
                        const age = now - stats.mtime.getTime();
                        if (age > this.config.cacheLifeDays * 86400000) {
                            Log.info(`Removing old cache file: ${entryPath}`);
                            await fsp.unlink(entryPath);
                        }
                    }
                }));
            };
        
            await walkAndClean(this.cacheDir);

            Log.info('Cache cleanup complete, triggering photo sync');
            this.sendSocketNotification('GET_PHOTOS', {
                cacheDir: this.cacheDir,
                moduleName: this.name,
                currentManifest: []
            });
        } catch (error) {
            Log.error('Error cleaning cache:', error);
        }
    },

    async handleNewPhoto(payload) {
        try {
            const { path: photoPath, folder } = payload;
            Log.info(`Processing new photo from path: ${photoPath}`);
            
            // Copy file to cache directory
            const fileName = path.basename(photoPath);
            const destPath = path.join(this.cacheDir, fileName);
            
            await fsp.copyFile(photoPath, destPath);
            Log.info(`Copied photo to cache: ${destPath}`);

            // Upload to S3
            if (!this.initialized) {
                await this.initializeModule();
            }

            const fileBuffer = await fsp.readFile(destPath);
            const s3Key = `${folder}/${fileName}`; // Use configured folder

            await awsCredentials.withCredentials(async () => {
                const uploadParams = {
                    Bucket: this.bucketName,
                    Key: s3Key,
                    Body: fileBuffer
                };

                await this.s3Client.send(new PutObjectCommand(uploadParams));
                Log.info(`Uploaded photo to S3: ${s3Key}`);
            });

            // Update the manifest
            const manifestPath = path.join(this.cacheDir, 'photos.json');
            let manifest = this.manifest || [];

            // Add new photo to manifest
            manifest.push({
                url: path.join('cache', fileName),
                key: s3Key,
                lastModified: new Date().toISOString(),
                size: fileBuffer.length
            });

            await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
            this.manifest = manifest;

            // Notify front end of update
            this.sendSocketNotification('PHOTOS_UPDATED', manifest);

        } catch (error) {
            Log.error('Error processing new photo:', error);
            this.sendSocketNotification('PHOTOS_ERROR', error.message);
        }
    },

    async ensureEnvironment() {
        const requiredVars = ['AWS_REGION', 'BUCKET_NAME', 'LAMBDA_FUNCTION_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
        const missingVars = requiredVars.filter(varName => !process.env[varName]);

        if (missingVars.length > 0) {
            Log.info(`Missing environment variables: ${missingVars.join(', ')}. Attempting to load from config...`);
            const loaded = loadEnv();
            if (!loaded) {
                throw new Error('Failed to load required environment variables from config files');
            }
            
            // Verify again after loading
            const stillMissing = requiredVars.filter(varName => !process.env[varName]);
            if (stillMissing.length > 0) {
                throw new Error(`Still missing required environment variables after loading config: ${stillMissing.join(', ')}`);
            }
        }
        return true;
    },

    async updateManifestWithNewPhotos(newPhotos) {
        try {
            const manifestPath = path.join(this.cacheDir, 'photos.json');
            let currentManifest = this.manifest || [];

            // Build a Set of existing keys for O(1) deduplication
            const existingKeys = new Set(currentManifest.map(p => p.key));
            const toAdd = newPhotos.filter(p => !existingKeys.has(p.key));
            const updatedManifest = currentManifest.concat(toAdd);

            // Write updated manifest
            await fsp.writeFile(
                manifestPath,
                JSON.stringify(updatedManifest, null, 2)
            );
            this.manifest = updatedManifest;

            Log.info(`Manifest updated with ${toAdd.length} new photos`);
        } catch (error) {
            Log.error('Error updating manifest:', error);
            throw error;
        }
    }
});
