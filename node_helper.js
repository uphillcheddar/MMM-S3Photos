const NodeHelper = require('node_helper');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const awsCredentials = require('./utils/awsCredentials');
const loadEnv = require('./utils/loadEnv');
const Log = require('logger');

module.exports = NodeHelper.create({
    start: function() {
        Log.info(`Starting node helper for module: ${this.name}`);
        this.initialized = false;
        this.initializationInProgress = false;
        this.s3Client = null;
        this.bucketName = null;
        
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

        // Watch for new uploads
        const uploadFile = path.join(this.cacheDir, 'last_upload.json');
        fs.watch(this.cacheDir, async (eventType, filename) => {
            if (filename === 'last_upload.json' && eventType === 'change') {
                try {
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
        });

        // Watch for sample deletion 
        fs.watch(this.cacheDir, async (eventType, filename) => {
            if (filename === 'last_update.json' && eventType === 'change') {
                try {
                    const data = JSON.parse(await fsp.readFile(path.join(this.cacheDir, filename), 'utf8'));
                    if (data.type === 'FILES_DELETED' && Array.isArray(data.files)) {
                        Log.info(`Processing deletion of ${data.files.length} files`);
                        
                        // Trigger Lambda sync to get updated file list
                        await this.handleGetPhotos();
                        
                        // Clean up notification file
                        await fsp.unlink(path.join(this.cacheDir, filename));
                    }
                } catch (error) {
                    Log.error('Error processing update notification:', error);
                }
            }
        });
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

            // First ensure environment variables are loaded from local files
            const envLoaded = await this.ensureEnvironment();
            if (!envLoaded) {
                throw new Error("Failed to load environment variables from local configuration");
            }

            // Initialize S3 client using your existing method
            await this.initializeS3Client();
            
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
            // Ensure environment is loaded before proceeding
            await this.ensureEnvironment();
            
            Log.info('Requesting photo manifest from Lambda');
            
            Log.info('Environment configuration:', {
                lambdaFunction: process.env.LAMBDA_FUNCTION_NAME,
                region: process.env.AWS_REGION,
                bucket: process.env.BUCKET_NAME
            });

            let currentManifest = [];
            const manifestPath = path.join(this.cacheDir, 'photos.json');
            
            try {
                if (fs.existsSync(manifestPath)) {
                    const manifestData = await fsp.readFile(manifestPath, 'utf8');
                    currentManifest = JSON.parse(manifestData);
                }
            } catch (error) {
                Log.warn('Error reading manifest:', error);
                currentManifest = [];
            }

            const lambda = new LambdaClient({ 
                region: process.env.AWS_REGION,
                maxAttempts: 3 // Add retry logic
            });
            
            const command = new InvokeCommand({
                FunctionName: process.env.LAMBDA_FUNCTION_NAME,
                Payload: JSON.stringify({ 
                    currentManifest,
                    bucket: process.env.BUCKET_NAME 
                }),
                InvocationType: 'RequestResponse'
            });

            Log.info('Invoking Lambda function...');
            const response = await lambda.send(command);
            
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
                    if (fs.existsSync(localPath)) {
                        await fsp.unlink(localPath);
                        Log.info(`Deleted local file: ${localPath}`);
                    }
                    
                    // Also check for the file in the root of cache dir
                    const rootPath = path.join(this.cacheDir, path.basename(fileToDelete.key));
                    if (fs.existsSync(rootPath)) {
                        await fsp.unlink(rootPath);
                        Log.info(`Deleted root cache file: ${rootPath}`);
                    }
                } catch (error) {
                    Log.error(`Error deleting file ${fileToDelete.key}:`, error);
                }
            }

            // Process downloads
            const downloadResults = await Promise.all(
                payload.toDownload.map(async (item) => {
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
                })
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
            
            const chunks = [];
            for await (const chunk of data.Body) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            
            await fsp.writeFile(localPath, buffer);
            Log.info(`Successfully downloaded ${key} to ${localPath}`);
            
            // Return path relative to module root, maintaining folder structure
            return path.join('cache', key);
        } catch (error) {
            Log.error(`Error downloading photo ${key}:`, error);
            throw error;
        }
    },

    async initializeS3Client() {
        try {
            await awsCredentials.withCredentials(async () => {
                Log.info('Initializing S3 client with:', {
                    region: process.env.AWS_REGION,
                    bucket: process.env.BUCKET_NAME
                });

                this.s3Client = new S3Client({ region: process.env.AWS_REGION });
                this.bucketName = process.env.BUCKET_NAME;
                Log.info('S3 client initialized successfully');
            });
        } catch (error) {
            Log.error('Failed to initialize S3 client:', error);
            throw error;
        }
    },

    stop: function() {
        Log.info('Stopping node helper');
        if (this.s3Client) {
            this.s3Client.destroy();
            this.s3Client = null;
        }
    },

    async cleanupCache() {
        if (!this.config.cacheLifeDays) {
            Log.info('Cache cleanup disabled (cacheLifeDays = 0)');
            return;
        }

        try {
            Log.info('Cleaning up cache directory');
            const files = await fsp.readdir(this.cacheDir);
            const now = Date.now();
            
            await Promise.all(files.map(async (file) => {
                const filePath = path.join(this.cacheDir, file);
                const stats = await fsp.stat(filePath);
                const age = now - stats.mtime.getTime();
                
                if (age > this.config.cacheLifeDays * 86400000) {
                    Log.info(`Removing old cache file: ${file}`);
                    await fsp.unlink(filePath);
                }
            }));

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
            let manifest = [];
            
            try {
                const manifestData = await fsp.readFile(manifestPath, 'utf8');
                manifest = JSON.parse(manifestData);
            } catch (error) {
                Log.warn('Error reading manifest, starting fresh:', error);
            }

            // Add new photo to manifest
            manifest.push({
                url: path.join('cache', fileName),
                key: s3Key,
                lastModified: new Date().toISOString(),
                size: fileBuffer.length
            });

            await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
            
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
            let currentManifest = [];
            
            // Read existing manifest if it exists
            try {
                const manifestData = await fsp.readFile(manifestPath, 'utf8');
                currentManifest = JSON.parse(manifestData);
            } catch (error) {
                Log.warn('Starting with empty manifest');
            }

            // Add new photos to manifest
            const updatedManifest = [
                ...currentManifest,
                ...newPhotos.filter(newPhoto => 
                    !currentManifest.some(existing => existing.key === newPhoto.key)
                )
            ];

            // Write updated manifest
            await fsp.writeFile(
                manifestPath,
                JSON.stringify(updatedManifest, null, 2)
            );

            Log.info(`Manifest updated with ${newPhotos.length} new photos`);
        } catch (error) {
            Log.error('Error updating manifest:', error);
            throw error;
        }
    }
});