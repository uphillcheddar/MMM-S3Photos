const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const awsCredentials = require('./utils/awsCredentials');
const loadEnv = require('./utils/loadEnv');
const path = require('path');
const fs = require('fs').promises;

// Load environment variables
if (!loadEnv()) {
    throw new Error('Failed to load environment variables');
}

const s3Client = new S3Client({
    region: process.env.AWS_REGION
});

const sampleFiles = [
    'samples/pexels-dan-mooham.jpg',
    'samples/pexels-matreding.jpg',
    'samples/pexels-pixabay.jpg'
];

async function notifyMagicMirror() {
    try {
        // Write notification file to trigger module refresh
        const notificationPath = path.join(__dirname, 'cache', 'last_update.json');
        await fs.writeFile(
            notificationPath,
            JSON.stringify({
                timestamp: new Date().toISOString(),
                type: 'FILES_DELETED',
                files: sampleFiles
            }, null, 2)
        );
        console.log('Notification sent to MagicMirror module');
    } catch (error) {
        console.error('Error writing notification:', error);
    }
}

async function deleteSample() {
    try {
        await awsCredentials.withCredentials(async () => {
            for (const file of sampleFiles) {
                try {
                    const deleteResult = await s3Client.send(new DeleteObjectCommand({
                        Bucket: process.env.BUCKET_NAME,
                        Key: file
                    }));
                    
                    if (deleteResult.$metadata.httpStatusCode === 204) {
                        console.log(`Successfully deleted from S3: ${file}`);
                    }
                } catch (err) {
                    console.error(`Error deleting ${file}:`, err);
                }
            }
        });

        // Notify MagicMirror to refresh photos
        await notifyMagicMirror();
        
        console.log("Sample deletion completed.");
        console.log("The module will refresh automatically when it detects the notification.");
    } catch (err) {
        console.error("Error during operation:", err);
    }
}

deleteSample();
