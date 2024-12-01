const fs = require('fs');
const path = require('path');

class AWSCredentialsManager {
    constructor() {
        this.credentialsPath = path.join(__dirname, '..', 'local_aws-credentials');
    }

    loadCredentials() {
        try {
            
            if (!fs.existsSync(this.credentialsPath)) {
                console.error('AWS credentials file not found at:', this.credentialsPath);
                return false;
            }

            const credentialsContent = fs.readFileSync(this.credentialsPath, 'utf8');
            
            
            const credentials = {};
            
            credentialsContent.split('\n').forEach(line => {
                const [key, value] = line.split('=').map(part => part.trim());
                if (key && value) {
                    credentials[key.replace('aws_', 'AWS_').toUpperCase()] = value;
                }
            });

            // Set environment variables
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
        // Remove AWS-related environment variables
        const awsVars = [
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_REGION',
            'AWS_ACCOUNT_ID'
        ];

        awsVars.forEach(varName => {
            delete process.env[varName];
        });
    }

    async withCredentials(operation) {
        try {
            const credentialsLoaded = this.loadCredentials();
            if (!credentialsLoaded) {
                throw new Error('Failed to load AWS credentials');
            }

            const result = await operation();
            return result;
        } finally {
            this.clearCredentials();
        }
    }
}

module.exports = new AWSCredentialsManager(); 