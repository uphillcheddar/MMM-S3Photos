const fs = require('fs');
const path = require('path');

const BACKUP_FILE = path.join(__dirname, '..', 'mmm-s3photos-backup.json');

/**
 * Attempts to load all environment variables from the backup file.
 * Returns true on success, false if the file is absent or unreadable.
 */
const loadFromBackup = (setupMode) => {
    if (!fs.existsSync(BACKUP_FILE)) return false;
    try {
        const { credentials, awsResources } = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));

        process.env.AWS_REGION = credentials.region;
        process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
        process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
        process.env.AWS_ACCOUNT_ID = credentials.accountId;
        process.env.CDK_DEFAULT_ACCOUNT = credentials.accountId;
        process.env.CDK_DEFAULT_REGION = credentials.region;
        process.env.AWS_DEFAULT_REGION = credentials.region;

        if (!setupMode && awsResources) {
            process.env.BUCKET_NAME = awsResources.s3Bucket;
            process.env.LAMBDA_FUNCTION_NAME = awsResources.lambdaFunction;
        }

        const required = setupMode
            ? ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCOUNT_ID']
            : ['AWS_REGION', 'BUCKET_NAME', 'LAMBDA_FUNCTION_NAME', 'AWS_ACCOUNT_ID'];

        const missing = required.filter(k => !process.env[k]);
        if (missing.length > 0) {
            console.warn('Backup file is missing fields:', missing, '— falling back to legacy files');
            return false;
        }
        return true;
    } catch (err) {
        console.warn('Could not read backup file, falling back to legacy files:', err.message);
        return false;
    }
};

/**
 * Loads AWS credentials and resource names into environment variables.
 *
 * Source priority:
 *   1. mmm-s3photos-backup.json (preferred)
 *   2. local_aws-credentials + aws-resources.json (legacy fallback)
 *
 * setupMode = true  → only validates AWS credentials (no bucket/lambda needed yet)
 * setupMode = false → also validates BUCKET_NAME and LAMBDA_FUNCTION_NAME
 */
function loadEnv(setupMode = false) {
    try {
        // If env vars are already populated (e.g. set by setAwsEnvironmentVariables
        // in setup.js before CDK deploy), skip file reads entirely.
        const required = setupMode
            ? ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCOUNT_ID']
            : ['AWS_REGION', 'BUCKET_NAME', 'LAMBDA_FUNCTION_NAME', 'AWS_ACCOUNT_ID'];
        if (required.every(k => process.env[k])) return true;

        if (loadFromBackup(setupMode)) return true;

        // ── Legacy fallback ──────────────────────────────────────────────────
        const credsPath = path.join(__dirname, '..', 'local_aws-credentials');
        if (!fs.existsSync(credsPath)) {
            console.error('No local_aws-credentials file found at:', credsPath);
            return false;
        }

        const credentials = fs.readFileSync(credsPath, 'utf8')
            .split('\n')
            .reduce((acc, line) => {
                const [key, value] = line.split('=').map(s => s.trim());
                if (key && value) {
                    acc[key.replace('aws_', '').toUpperCase()] = value;
                }
                return acc;
            }, {});

        process.env.AWS_REGION = credentials.REGION;
        process.env.AWS_ACCESS_KEY_ID = credentials.ACCESS_KEY_ID;
        process.env.AWS_SECRET_ACCESS_KEY = credentials.SECRET_ACCESS_KEY;
        process.env.AWS_ACCOUNT_ID = credentials.ACCOUNT_ID;
        process.env.CDK_DEFAULT_ACCOUNT = credentials.ACCOUNT_ID;
        process.env.CDK_DEFAULT_REGION = credentials.REGION;
        process.env.AWS_DEFAULT_REGION = credentials.REGION;

        if (!setupMode) {
            const resourcesPath = path.join(__dirname, '..', 'aws-resources.json');
            if (!fs.existsSync(resourcesPath)) {
                console.error('No aws-resources.json file found at:', resourcesPath);
                return false;
            }
            const resources = JSON.parse(fs.readFileSync(resourcesPath, 'utf8'));
            process.env.BUCKET_NAME = resources.s3Bucket;
            process.env.LAMBDA_FUNCTION_NAME = resources.lambdaFunction;

            const required = ['AWS_REGION', 'BUCKET_NAME', 'LAMBDA_FUNCTION_NAME', 'AWS_ACCOUNT_ID'];
            const missing = required.filter(k => !process.env[k]);
            if (missing.length > 0) {
                console.error('Missing required environment variables:', missing);
                return false;
            }
        } else {
            const required = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCOUNT_ID'];
            const missing = required.filter(k => !process.env[k]);
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
