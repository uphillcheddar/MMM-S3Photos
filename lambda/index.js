const { S3Client, paginateListObjectsV2 } = require('@aws-sdk/client-s3');

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

        // Scan bucket with Pagination (Handles > 1,000 files)
        const bucketFiles = [];
        const paginatorConfig = {
            client: s3Client,
            pageSize: 1000 // Requests 1,000 items at a time from S3
        };

        const paginator = paginateListObjectsV2(paginatorConfig, { Bucket: bucketName });

        // Iterate through all pages provided by S3
        for await (const page of paginator) {
            if (page.Contents) {
                const mappedPage = page.Contents.map(item => ({
                    key: item.Key,
                    lastModified: item.LastModified.toISOString(),
                    size: item.Size,
                    folder: item.Key.split('/')[0]
                }));
                bucketFiles.push(...mappedPage);
            }
        }

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