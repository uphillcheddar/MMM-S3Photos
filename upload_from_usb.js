const { execSync, exec } = require('child_process');
const inquirer = require('inquirer');
const fs = require('fs').promises;
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const awsCredentials = require('./utils/awsCredentials');
const loadEnv = require('./utils/loadEnv');
const moduleDir = path.resolve(__dirname);
const cacheDir = path.join(moduleDir, 'cache');

async function checkSudo() {
    try {
        // Check if sudo is installed
        await execPromise('which sudo');
        
        // Check if we have sudo privileges
        const sudoTest = await execPromise('sudo -n true');
        return true;
    } catch (error) {
        if (error.message.includes('sudo: a password is required')) {
            console.log('\nThis script requires sudo privileges to mount USB devices.');
            console.log('Please run the script with sudo: sudo node upload_from_usb.js\n');
        } else if (error.message.includes('which: no sudo')) {
            console.log('\nError: sudo is not installed on this system.');
            console.log('Please install sudo first: apt-get install sudo\n');
        } else {
            console.error('\nError checking sudo privileges:', error.message);
        }
        return false;
    }
}

async function ensureCacheDir() {
    try {
        await fs.mkdir(cacheDir, { recursive: true });
    } catch (error) {
        console.error('Error creating cache directory:', error);
        throw error;
    }
}

// Helper function to execute shell commands with promises
const execPromise = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            resolve(stdout.trim());
        });
    });
};

// Get list of USB storage devices
async function getUsbDevices() {
    try {
        // Get list of USB devices using lsblk with proper JSON formatting
        const output = await execPromise('lsblk -J -o NAME,LABEL,SIZE,MOUNTPOINT,TYPE');
        const devices = JSON.parse(output).blockdevices
            .filter(device => device.type === 'disk' && !device.name.startsWith('mmcblk'));
        
        // For each device, get its first partition's mountpoint if it exists
        const enrichedDevices = await Promise.all(devices.map(async device => {
            const partitionOutput = await execPromise(`lsblk -J -o NAME,MOUNTPOINT /dev/${device.name}`);
            const partitions = JSON.parse(partitionOutput).blockdevices[0].children || [];
            const firstPartition = partitions[0] || {};
            
            return {
                name: `${device.label || device.name} (${device.size})`,
                value: device.name,
                mountpoint: firstPartition.mountpoint || null,
                partition: `${device.name}1` // Assuming first partition
            };
        }));
        
        return enrichedDevices;
    } catch (error) {
        console.error('Error getting USB devices:', error);
        return [];
    }
}

// Get all image folders from the mounted device
async function getImageFolders(mountPoint) {
    const folders = new Map();
    
    async function scanDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                await scanDir(fullPath);
            } else if (entry.isFile() && /\.(jpg|jpeg|png|gif)$/i.test(entry.name)) {
                const relativePath = path.relative(mountPoint, path.dirname(fullPath));
                const count = folders.get(relativePath) || 0;
                folders.set(relativePath, count + 1);
            }
        }
    }
    
    await scanDir(mountPoint);
    return folders;
}

// Upload files to S3
async function uploadToS3(files, bucketName) {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    
    for (const file of files) {
        const fileContent = await fs.readFile(file.sourcePath);
        
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: file.s3Key,
            Body: fileContent,
            ContentType: `image/${path.extname(file.sourcePath).slice(1)}`
        }));
        
        console.log(`Uploaded: ${file.s3Key}`);
    }
}

async function copyPhotoToCache(sourcePath, targetKey) {
    // Create full cache path including subdirectories
    const cachePath = path.join(cacheDir, targetKey);
    
    // Create subdirectories if they don't exist
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    
    // Copy the file
    await fs.copyFile(sourcePath, cachePath);
    
    // Get file size for manifest
    const stats = await fs.stat(cachePath);
    
    return {
        url: targetKey,  // This matches the S3 path structure
        key: targetKey,
        lastModified: new Date().toISOString(),
        size: stats.size
    };
}

// Add new function to notify MagicMirror
async function notifyMagicMirror(newPhotos) {
    try {
        // Write to the module's cache directory
        const notificationPath = path.join(__dirname, 'cache', 'last_upload.json');
        await fs.writeFile(
            notificationPath,
            JSON.stringify({
                timestamp: new Date().toISOString(),
                newPhotos
            }, null, 2)
        );
    } catch (error) {
        console.error('Error writing notification:', error);
    }
}

async function main() {
    try {
        // Check sudo privileges first
        const hasSudo = await checkSudo();
        if (!hasSudo) {
            process.exit(1);
        }

        // Load environment variables
        if (!loadEnv()) {
            throw new Error('Failed to load environment variables');
        }

        // Ensure cache directory exists
        await ensureCacheDir();

        // Get USB devices
        const devices = await getUsbDevices();
        if (devices.length === 0) {
            console.log('No USB storage devices found.');
            return;
        }

        // Let user select device
        const { device } = await inquirer.prompt([{
            type: 'list',
            name: 'device',
            message: 'Select USB device:',
            choices: devices
        }]);

        // Get mount point or mount if needed
        const selectedDevice = devices.find(d => d.value === device);
        let mountPoint = selectedDevice.mountpoint;

        if (!mountPoint) {
            // Device isn't mounted, so let's mount it
            mountPoint = `/media/${device}`;
            console.log(`Mounting device to ${mountPoint}...`);
            
            // Create mount point directory if it doesn't exist
            await execPromise(`sudo mkdir -p ${mountPoint}`);
            
            try {
                await execPromise(`sudo mount /dev/${selectedDevice.partition} ${mountPoint}`);
                console.log('Device mounted successfully');
            } catch (error) {
                // Check if the error is because it's already mounted elsewhere
                const mountInfo = await execPromise(`findmnt -n -o TARGET /dev/${selectedDevice.partition}`);
                if (mountInfo) {
                    console.log(`Device already mounted at ${mountInfo}`);
                    mountPoint = mountInfo.trim();
                } else {
                    throw error; // Re-throw if it's a different error
                }
            }
        } else {
            console.log(`Device already mounted at ${mountPoint}`);
        }

        // Get folders with image counts
        const imageFolders = await getImageFolders(mountPoint);
        const folderChoices = Array.from(imageFolders.entries()).map(([folder, count]) => ({
            name: `${folder || '(root)'} (${count} images)`,
            value: folder
        }));
        folderChoices.unshift({ name: 'All folders', value: '*' });

        // Let user select folders
        const { selectedFolders } = await inquirer.prompt([{
            type: 'checkbox',
            name: 'selectedFolders',
            message: 'Select folders to upload (space to select, enter to confirm):',
            choices: folderChoices
        }]);

        // Add check for empty selection
        if (!selectedFolders || selectedFolders.length === 0) {
            console.log('\nNo folders selected. Exiting now.');
            
            // Clean up mount point if we created it
            if (selectedDevice.mountpoint === null) {
                console.log('Cleaning up mount point...');
                await execPromise(`sudo umount ${mountPoint}`);
                await execPromise(`sudo eject /dev/${device}`);
                await execPromise(`sudo rmdir ${mountPoint}`);
            }
            
            process.exit(0);
        }

        // Process selected folders
        const filesToProcess = [];
        const processAllFolders = selectedFolders.includes('*');
        const foldersToProcess = processAllFolders ? 
            Array.from(imageFolders.keys()) : 
            selectedFolders;

        for (const folder of foldersToProcess) {
            const folderPath = path.join(mountPoint, folder);
            const files = await fs.readdir(folderPath);
            
            for (const file of files) {
                if (/\.(jpg|jpeg|png|gif)$/i.test(file)) {
                    const targetKey = path.join(folder, file);
                    filesToProcess.push({
                        sourcePath: path.join(folderPath, file),
                        s3Key: targetKey,
                        destPath: path.join('cache', file)
                    });
                }
            }
        }

        // Process each photo and prepare notification
        const newPhotos = [];
        console.log('\nCopying files to cache...');
        for (const file of filesToProcess) {
            // Copy to cache with proper folder structure
            const photoEntry = await copyPhotoToCache(file.sourcePath, file.s3Key);
            newPhotos.push(photoEntry);
            console.log(`Cached: ${path.basename(file.destPath)}`);
        }

        // Upload to S3
        console.log('\nUploading files to S3...');
        await awsCredentials.withCredentials(async () => {
            await uploadToS3(filesToProcess, process.env.BUCKET_NAME);
        });

        // Safely unmount and eject device
        console.log('\nEjecting device...');
        try {
            // Unmount first
            await execPromise(`sudo umount ${mountPoint}`);
            console.log('Device unmounted successfully');

            // Try to eject
            try {
                await execPromise(`sudo eject /dev/${device}`);
                console.log('Device ejected successfully');
            } catch (ejectError) {
                console.log('Note: Device eject command failed, but unmount was successful');
            }

        } catch (unmountError) {
            console.error('Warning: Error during device cleanup:', unmountError.message);
            console.log('Please ensure the device is unmounted manually before removing');
        }

        const payload = { newPhotos };

        // Notify MagicMirror about the new photos
        await notifyMagicMirror(newPhotos);
        
        console.log('\nUpload complete! You can now safely remove your USB device.');

        // Send notification to MagicMirror


    } catch (error) {
        console.error('Error:', error);
    }
}

main(); 