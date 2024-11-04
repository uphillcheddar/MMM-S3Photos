const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
    try {
        console.log('Lambda function invoked with event:', JSON.stringify(event));
        
        // Extract current manifest from event, ensure it's an array
        const currentManifest = Array.isArray(event.currentManifest) ? event.currentManifest : [];
        const currentKeys = new Set(currentManifest.map(item => item.key));

        // Validate bucket name
        const bucketName = process.env.BUCKET_NAME;
        if (!bucketName) {
            throw new Error('BUCKET_NAME environment variable not set');
        }

        // Scan bucket
        const params = { Bucket: bucketName };
        const data = await s3Client.send(new ListObjectsV2Command(params));
        
        if (!data || !Array.isArray(data.Contents)) {
            return {
                toDownload: [],
                toDelete: []
            };
        }

        // Process bucket contents
        const bucketFiles = data.Contents.map(item => ({
            key: item.Key,
            lastModified: item.LastModified.toISOString(),
            size: item.Size,
            folder: item.Key.split('/')[0]
        }));
        const bucketKeys = new Set(bucketFiles.map(item => item.key));

        // Determine changes
        const changes = {
            toDownload: bucketFiles.filter(file => !currentKeys.has(file.key)),
            toDelete: currentManifest.filter(file => !bucketKeys.has(file.key))
        };

        console.log(`Found ${bucketFiles.length} files in bucket`);
        console.log(`Changes: ${changes.toDownload.length} to download, ${changes.toDelete.length} to delete`);

        return changes;

    } catch (error) {
        console.error('Error processing S3 event:', error);
        throw error;
    }
};
