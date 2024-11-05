const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const { s3Bucket, s3Region, accessKeyId, secretAccessKey } = config;

const s3Client = new S3Client({
    credentials: {
        accessKeyId,
        secretAccessKey
    },
    region: s3Region
});

const params1 = {
    Bucket: s3Bucket,
    Key: 'samples/pexels-dan-mooham.jpg'
};
const params2 = {
    Bucket: s3Bucket,
    Key: 'samples/pexels-dan-mooham.jpg'
};
const params3 = {
    Bucket: s3Bucket,
    Key: 'samples/pexels-dan-mooham.jpg'
};
async function deleteSample() {
    try {
        await s3Client.send(new DeleteObjectCommand(params1));
        console.log("Sample picture deleted successfully.");
    } catch (err) {
        console.error("Error deleting sample 1 picture: ", err);
    }
    try {
        await s3Client.send(new DeleteObjectCommand(params2));
        console.log("Sample picture deleted successfully.");
    } catch (err) {
        console.error("Error deleting sample 1 picture: ", err);
    }
    try {
        await s3Client.send(new DeleteObjectCommand(params3));
        console.log("Sample picture deleted successfully.");
    } catch (err) {
        console.error("Error deleting sample 1 picture: ", err);
    }
}

deleteSample();
