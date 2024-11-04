const { execSync, exec } = require('child_process');
const inquirer = require('inquirer');
const fs = require('fs').promises;
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const awsCredentials = require('./utils/awsCredentials');
const loadEnv = require('./utils/loadEnv');

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
        
        return devices.map(device => ({
            name: `${device.label || device.name} (${device.size})`,
            value: device.name,
            mountpoint: device.mountpoint
        }));
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
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    
    // Copy the file
    await fs.promises.copyFile(sourcePath, cachePath);
    
    // Get file size for manifest
    const stats = await fs.promises.stat(cachePath);
    
    return {
        url: targetKey,  // This matches the S3 path structure
        key: targetKey,
        lastModified: new Date().toISOString(),
        size: stats.size
    };
}

async function main() {
    try {
        // Load environment variables
        if (!loadEnv()) {
            throw new Error('Failed to load environment variables');
        }

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
        let mountPoint = devices.find(d => d.value === device).mountpoint;
        if (!mountPoint) {
            mountPoint = `/media/${device}`;
            // Create mount point directory if it doesn't exist
            await execPromise(`sudo mkdir -p ${mountPoint}`);
            await execPromise(`sudo mount /dev/${device}1 ${mountPoint}`);
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
                    filesToProcess.push({
                        sourcePath: path.join(folderPath, file),
                        s3Key: path.join(folder, file),
                        destPath: path.join('cache', file)
                    });
                }
            }
        }

        // Copy to cache
        console.log('\nCopying files to cache...');
        for (const file of filesToProcess) {
            await fs.copyFile(file.sourcePath, file.destPath);
            console.log(`Cached: ${path.basename(file.destPath)}`);
        }

        // Upload to S3
        console.log('\nUploading files to S3...');
        await awsCredentials.withCredentials(async () => {
            await uploadToS3(filesToProcess, process.env.BUCKET_NAME);
        });

        // Safely unmount and eject device
        console.log('\nEjecting device...');
        await execPromise(`sudo umount ${mountPoint}`);
        await execPromise(`sudo eject /dev/${device}`);
        // Clean up mount point directory
        await execPromise(`sudo rmdir ${mountPoint}`);

        console.log('\nUpload complete! You can now safely remove your USB device.');

        // Process each photo
        const newPhotos = [];
        for (const file of selectedFiles) {
            const sourcePath = path.join(mountPoint, file);
            const targetKey = path.join(targetFolder, path.basename(file));
            
            // Copy to cache with proper folder structure
            const photoEntry = await copyPhotoToCache(sourcePath, targetKey);
            newPhotos.push(photoEntry);
            
            // Upload to S3
            await uploadToS3(sourcePath, targetKey);
        }

        // Send notification to MagicMirror
        const payload = {
            newPhotos: newPhotos
        };

        const mm = require('../../../js/electron.js');
        mm.sendSocketNotification('USB_PHOTOS_UPLOADED', payload);

    } catch (error) {
        console.error('Error:', error);
    }
}

main(); 