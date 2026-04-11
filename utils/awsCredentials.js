const fs = require('fs');
const path = require('path');

const BACKUP_FILE = path.join(__dirname, '..', 'mmm-s3photos-backup.json');

class AWSCredentialsManager {
    constructor() {
        this.credentialsPath = path.join(__dirname, '..', 'local_aws-credentials');
    }

    loadCredentials() {
        try {
            // ── Preferred: backup file ───────────────────────────────────────
            if (fs.existsSync(BACKUP_FILE)) {
                try {
                    const { credentials } = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
                    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
                    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
                    process.env.AWS_REGION = credentials.region;
                    process.env.AWS_ACCOUNT_ID = credentials.accountId;
                    return true;
                } catch (err) {
                    console.warn('Failed to load credentials from backup file, falling back to legacy file:', err.message);
                }
            }

            // ── Legacy fallback: local_aws-credentials ───────────────────────
            if (!fs.existsSync(this.credentialsPath)) {
                console.error('AWS credentials file not found at:', this.credentialsPath);
                return false;
            }

            const credentials = {};
            fs.readFileSync(this.credentialsPath, 'utf8')
                .split('\n')
                .forEach(line => {
                    const [key, value] = line.split('=').map(part => part.trim());
                    if (key && value) {
                        credentials[key.replace('aws_', 'AWS_').toUpperCase()] = value;
                    }
                });

            process.env.AWS_ACCESS_KEY_ID = credentials.AWS_ACCESS_KEY_ID;
            process.env.AWS_SECRET_ACCESS_KEY = credentials.AWS_SECRET_ACCESS_KEY;
            process.env.AWS_REGION = credentials.REGION;
            process.env.AWS_ACCOUNT_ID = credentials.ACCOUNT_ID;
            return true;
        } catch (error) {
            console.error('Error loading AWS credentials:', error);
            return false;
        }
    }

    clearCredentials() {
        ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_ACCOUNT_ID']
            .forEach(v => delete process.env[v]);
    }

    async withCredentials(operation) {
        try {
            if (!this.loadCredentials()) {
                throw new Error('Failed to load AWS credentials');
            }
            return await operation();
        } finally {
            this.clearCredentials();
        }
    }
}

module.exports = new AWSCredentialsManager();
