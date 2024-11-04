const fs = require('fs');
const path = require('path');

function loadEnv(setupMode = false) {
    try {
        // Look for credentials file in the module root directory
        const credsPath = path.join(__dirname, '..', 'local_aws-credentials');
        
        if (!fs.existsSync(credsPath)) {
            console.error('No local_aws-credentials file found at:', credsPath);
            return false;
        }

        // Parse the credentials file
        const content = fs.readFileSync(credsPath, 'utf8');
        const credentials = content.split('\n').reduce((acc, line) => {
            const [key, value] = line.split('=').map(s => s.trim());
            if (key && value) {
                // Remove 'aws_' prefix if present
                const cleanKey = key.replace('aws_', '').toUpperCase();
                acc[cleanKey] = value;
            }
            return acc;
        }, {});

        // Set environment variables from credentials
        process.env.AWS_REGION = credentials.REGION;
        process.env.AWS_ACCESS_KEY_ID = credentials.ACCESS_KEY_ID;
        process.env.AWS_SECRET_ACCESS_KEY = credentials.SECRET_ACCESS_KEY;
        process.env.AWS_ACCOUNT_ID = credentials.ACCOUNT_ID;
        process.env.CDK_DEFAULT_ACCOUNT = credentials.ACCOUNT_ID;
        process.env.CDK_DEFAULT_REGION = credentials.REGION;
        process.env.AWS_DEFAULT_REGION = credentials.REGION;
        
        if (!setupMode) {
            // Get bucket and lambda names from aws-resources.json
            const resourcesPath = path.join(__dirname, '..', 'aws-resources.json');
            if (!fs.existsSync(resourcesPath)) {
                console.error('No aws-resources.json file found at:', resourcesPath);
                return false;
            }

            const resources = JSON.parse(fs.readFileSync(resourcesPath, 'utf8'));
            process.env.BUCKET_NAME = resources.s3Bucket;
            process.env.LAMBDA_FUNCTION_NAME = resources.lambdaFunction;

            // Verify required variables including resources
            const required = ['AWS_REGION', 'BUCKET_NAME', 'LAMBDA_FUNCTION_NAME', 'AWS_ACCOUNT_ID'];
            const missing = required.filter(key => !process.env[key]);
            
            if (missing.length > 0) {
                console.error('Missing required environment variables:', missing);
                return false;
            }
        } else {
            // Only verify AWS credentials in setup mode
            const required = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCOUNT_ID'];
            const missing = required.filter(key => !process.env[key]);
            
            if (missing.length > 0) {
                console.error('Missing required AWS credentials:', missing);
                return false;
            }
        }

        return true;
    } catch (error) {
        console.error('Error in loadEnv:', error);
        return false;
    }
}

module.exports = loadEnv; 