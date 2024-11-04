const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const { Bucket } = require('aws-cdk-lib/aws-s3');
const { Function, Runtime, Code } = require('aws-cdk-lib/aws-lambda');
const { Rule, Schedule } = require('aws-cdk-lib/aws-events');
const { LambdaFunction } = require('aws-cdk-lib/aws-events-targets');

class S3PhotosStack extends Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const bucket = new Bucket(this, 'MMMS3PhotosBucket', {
            versioned: true,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });

        const lambdaFunction = new Function(this, 'S3PhotosHandler', {
            runtime: Runtime.NODEJS_20_X,
            code: Code.fromAsset('lambda'),
            handler: 'index.handler',
            timeout: Duration.seconds(45),
            memorySize: 256,
            environment: {
                BUCKET_NAME: bucket.bucketName
            }
        });

        bucket.grantReadWrite(lambdaFunction);

        const rule = new Rule(this, 'Rule', {
            schedule: Schedule.rate(Duration.hours(1))
        });

        rule.addTarget(new LambdaFunction(lambdaFunction));

        new CfnOutput(this, 'S3PhotosBucketName', {
            value: bucket.bucketName,
            description: 'The name of the S3 bucket created by this stack',
        });

        new CfnOutput(this, 'S3PhotosHandlerName', {
            value: lambdaFunction.functionName,
            description: 'The name of the Lambda function',
        });

        new CfnOutput(this, 'S3PhotosHandlerArn', {
            value: lambdaFunction.functionArn,
            description: 'The ARN of the Lambda function',
        });
    }
}

module.exports = { S3PhotosStack };
