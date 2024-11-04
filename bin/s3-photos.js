const cdk = require('aws-cdk-lib');
const { S3PhotosStack } = require('../lib/s3-photos-stack.js');

const app = new cdk.App();
new S3PhotosStack(app, 'S3PhotosStack');

app.synth();
