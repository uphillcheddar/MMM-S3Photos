const inquirer = require('inquirer');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const awsCredentials = require('./utils/awsCredentials');
const { EventEmitter } = require('events');

// Set max listeners to 15 to prevent warnings
EventEmitter.defaultMaxListeners = 15;

const isCommandAvailable = (command) => {
    try {
        execSync(`command -v ${command}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const checkWorkingDirectory = () => {
    // Get the directory name of the current working directory
    const currentDir = path.basename(process.cwd());
    
    if (currentDir !== 'MMM-S3Photos') {
        console.error('\x1b[31mError: This script must be run from the MMM-S3Photos module directory\x1b[0m');
        console.log('\nPlease use cd to change to the MMM-S3Photos module directory and then run this script again');
        process.exit(1);
    }
};

const questions = [
    {
        type: 'confirm',
        name: 'hasAwsAccount',
        message: 'Have you set up an AWS account and IAM User?',
        default: true
    },
    {
        type: 'input',
        name: 'awsAccountInstructions',
        message: 'Please follow the instructions in the README to create an AWS account. Press Enter to continue...',
        when: (answers) => !answers.hasAwsAccount
    },
    {
        type: 'confirm',
        name: 'useExistingCreds',
        message: 'An existing AWS credentials file was found. Do you want to use the existing credentials?',
        when: () => fs.existsSync('./local_aws-credentials'),
        default: true
    },
    {
        type: 'input',
        name: 'accountId',
        message: 'Enter your AWS Account ID:',
        when: (answers) => answers.hasAwsAccount && (!answers.useExistingCreds || !fs.existsSync('./local_aws-credentials'))
    },
    {
        type: 'input',
        name: 'accessKeyId',
        message: 'Enter your AWS Access Key ID:',
        when: (answers) => answers.hasAwsAccount && (!answers.useExistingCreds || !fs.existsSync('./local_aws-credentials'))
    },
    {
        type: 'input',
        name: 'secretAccessKey',
        message: 'Enter your AWS Secret Access Key:',
        when: (answers) => answers.hasAwsAccount && (!answers.useExistingCreds || !fs.existsSync('./local_aws-credentials'))
    },
    {
        type: 'input',
        name: 'region',
        message: 'Enter your AWS Region example: us-east-1:',
        when: (answers) => answers.hasAwsAccount && (!answers.useExistingCreds || !fs.existsSync('./local_aws-credentials'))
    }
];


const getBucketName = async (region) => {
    if (!region) {
        console.error('Region not provided to getBucketName');
        return null;
    }

    try {
        const cloudFormationClient = new CloudFormationClient({ region });
        const command = new DescribeStacksCommand({ StackName: 'S3PhotosStack' });
        const data = await cloudFormationClient.send(command);
        const outputs = data.Stacks[0].Outputs;
        const output = outputs.find(output => output.OutputKey === 'S3PhotosBucketName');
        return output ? output.OutputValue : null;
    } catch (err) {
        console.error('Error retrieving stack outputs:', err);
        return null;
    }
};

const installAwsCli = () => {
    console.log('Installing AWS CLI...');
    if (os.platform() === 'linux') {
        execSync('curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"', { stdio: 'inherit' });
        execSync('unzip awscliv2.zip', { stdio: 'inherit' });
        execSync('sudo ./aws/install', { stdio: 'inherit' });
    } else if (os.platform() === 'darwin') {
        execSync('curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"', { stdio: 'inherit' });
        execSync('sudo installer -pkg AWSCLIV2.pkg -target /', { stdio: 'inherit' });
    }
};

const installAwsCdk = () => {
    console.log('Installing AWS CDK...');
    execSync('npm install -g aws-cdk', { stdio: 'inherit' });
};

const uploadSampleFile = async (bucketName) => {
    console.log('Uploading sample file to S3 bucket...');
    
    await awsCredentials.withCredentials(async () => {
        const s3Client = new S3Client({ region: process.env.AWS_REGION });
        const filePath1 = path.join(__dirname, 'cache', 'samples', 'pexels-dan-mooham.jpg');
        const fileContent1 = fs.readFileSync(filePath1);
        const filePath2 = path.join(__dirname, 'cache', 'samples', 'pexels-matreding.jpg');
        const fileContent2 = fs.readFileSync(filePath2);  
        const filePath3 = path.join(__dirname, 'cache', 'samples', 'pexels-pixabay.jpg');
        const fileContent3 = fs.readFileSync(filePath3);    

        const params1 = {
            Bucket: bucketName,
            Key: 'samples/pexels-dan-mooham.jpg',
            Body: fileContent1,
            ContentType: 'image/jpeg'
        };
        const params2 = {
            Bucket: bucketName,
            Key: 'samples/pexels-matreding.jpg',
            Body: fileContent2,
            ContentType: 'image/jpeg'
        };
        const params3 = {
            Bucket: bucketName,
            Key: 'samples/pexels-pixabay.jpg',
            Body: fileContent3,
            ContentType: 'image/jpeg'
        };

        try {
            await s3Client.send(new PutObjectCommand(params1));
            console.log('First Sample file uploaded successfully.');
        } catch (err) {
            console.error('Error uploading sample file:', err);
            throw err;
        }
        try {
            await s3Client.send(new PutObjectCommand(params2));
            console.log('Second Sample file uploaded successfully.');
        } catch (err) {
            console.error('Error uploading sample file:', err);
            throw err;
        }
        try {
            await s3Client.send(new PutObjectCommand(params3));
            console.log('Second Sample file uploaded successfully.');
        } catch (err) {
            console.error('Error uploading sample file:', err);
            throw err;
        }
    });
};

const setupModulePermissions = async () => {
    console.log('Setting up module permissions...');
    
    const modulePath = path.join(__dirname, '..');
    const cachePath = path.join(modulePath, 'cache');
    
    try {
        // Create cache directory if it doesn't exist
        if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(cachePath, { recursive: true });
        }
        
        // Set directory permissions (755 = rwxr-xr-x)
        fs.chmodSync(cachePath, '755');
        
        // Create an empty photos.json file with proper permissions
        const photosJsonPath = path.join(cachePath, 'photos.json');
        if (!fs.existsSync(photosJsonPath)) {
            fs.writeFileSync(photosJsonPath, '[]');
            fs.chmodSync(photosJsonPath, '644');  // 644 = rw-r--r--
        }
        
        console.log('Module permissions set successfully.');
    } catch (error) {
        console.error('Error setting module permissions:', error);
        throw error;
    }
};

// Add after other requires
const isRoot = () => process.getuid && process.getuid() === 0;

const checkSudoPrivileges = () => {
    // Only check for sudo on Linux/Mac systems
    if (os.platform() !== 'linux' && os.platform() !== 'darwin') {
        return;
    }

    // Check if AWS CLI is already installed
    const awsInstalled = isCommandAvailable('aws');
    
    if (!awsInstalled && !isRoot()) {
        console.error('\x1b[31mError: AWS CLI installation requires sudo privileges\x1b[0m');
        console.log('\nPlease run the setup script with sudo:');
        console.log('\x1b[33msudo node setup.js\x1b[0m\n');
        process.exit(1);
    }
};

const main = async () => {
    try {
        checkWorkingDirectory();
        checkSudoPrivileges();
        
        const answers = await inquirer.prompt(questions);
        
        // Early exit if no AWS account
        if (!answers.hasAwsAccount) {
            console.log('Please create an AWS account and then run this script again.');
            return;
        }

        // Handle credentials
        let credentials;
        if (answers.useExistingCreds && fs.existsSync('./local_aws-credentials')) {
            credentials = parseCredentialsFile('./local_aws-credentials');
        } else {
            credentials = {
                accessKeyId: answers.accessKeyId,
                secretAccessKey: answers.secretAccessKey,
                region: answers.region,
                accountId: answers.accountId
            };
            // Save new credentials
            saveCredentialsFile('./local_aws-credentials', credentials);
        }

        // Set environment variables
        setAwsEnvironmentVariables(credentials);

        // Deploy infrastructure
        await deployInfrastructure(credentials);

        // Generate configuration files
        await generateConfigFiles(credentials);

    } catch (error) {
        console.error('Setup failed:', error);
        process.exit(1);
    }
};

// Helper functions
const parseCredentialsFile = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').reduce((acc, line) => {
        const [key, value] = line.split('=').map(s => s.trim());
        if (key && value) {
            acc[key.replace('aws_', '')] = value;
        }
        return acc;
    }, {});
};

const saveCredentialsFile = (filePath, credentials) => {
    const content = `[default]
aws_access_key_id = ${credentials.accessKeyId}
aws_secret_access_key = ${credentials.secretAccessKey}
region = ${credentials.region}
account_id = ${credentials.accountId}
`;
    fs.writeFileSync(filePath, content);
};

const setAwsEnvironmentVariables = (credentials) => {
    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    process.env.AWS_REGION = credentials.region;
    process.env.AWS_ACCOUNT_ID = credentials.accountId;
};

const deployInfrastructure = async (credentials) => {
    // Install dependencies if needed
    if (!isCommandAvailable('aws')) installAwsCli();
    if (!isCommandAvailable('cdk')) installAwsCdk();
    
    console.log('Installing project dependencies...');
    execSync('npm install', { stdio: 'inherit' });

    const bootstrapStackName = 'mmm-s3photos-bootstrap';
    console.log('Bootstrapping environment...');
    
    // Load environment variables in setup mode
    const loadEnv = require('./utils/loadEnv');
    if (!loadEnv(true)) {  // Pass true for setup mode
        throw new Error('Failed to load environment variables');
    }

    try {
        execSync(
            `cdk bootstrap aws://${process.env.AWS_ACCOUNT_ID}/${process.env.AWS_REGION} --toolkit-stack-name ${bootstrapStackName} --qualifier mmm`, 
            { 
                stdio: 'inherit',
                env: process.env
            }
        );
    } catch (error) {
        if (!error.message.includes('already bootstrapped')) {
            throw error;
        }
        console.log('Environment already bootstrapped. Proceeding...');
    }

    console.log('Deploying CDK stack...');
    execSync(
        `cdk deploy S3PhotosStack --toolkit-stack-name ${bootstrapStackName} --require-approval never`, 
        { 
            stdio: 'inherit',
            env: process.env
        }
    );
};

const generateConfigFiles = async (credentials) => {
    await awsCredentials.withCredentials(async () => {
        // Get stack outputs for resources
        const cloudFormationClient = new CloudFormationClient({ region: credentials.region });
        const command = new DescribeStacksCommand({ StackName: 'S3PhotosStack' });
        const data = await cloudFormationClient.send(command);
        const outputs = data.Stacks[0].Outputs;
        
        // Extract values from stack outputs
        const config = {
            s3Bucket: outputs.find(o => o.OutputKey === 'S3PhotosBucketName').OutputValue,
            s3Region: credentials.region,
            accountId: credentials.accountId,
            lambdaFunction: outputs.find(o => o.OutputKey === 'S3PhotosHandlerName').OutputValue
        };
        
        // Save aws-resources.json
        const resourcesPath = path.join(__dirname, 'aws-resources.json');
        fs.writeFileSync(resourcesPath, JSON.stringify(config, null, 2));

        // Upload sample files using the bucket name from config
        await uploadSampleFile(config.s3Bucket);

        // Generate minimal IAM policy using values from config
        const minimalPolicy = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "s3:GetObject",
                        "s3:PutObject",
                        "s3:ListBucket",
                        "s3:DeleteObject"
                    ],
                    Resource: [
                        `arn:aws:s3:::${config.s3Bucket}`,
                        `arn:aws:s3:::${config.s3Bucket}/*`
                    ]
                },
                {
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: `arn:aws:lambda:${config.s3Region}:${config.accountId}:function:${config.lambdaFunction}`
                }
            ]
        };
        
        fs.writeFileSync(
            path.join(__dirname, 'minimal-policy.json'),
            JSON.stringify(minimalPolicy, null, 2)
        );
    });
    console.log('.');
    console.log('.');
    console.log('.');
    console.log('Setup complete! AWS Cloud Formation has been deployed log and outputs here:');
    console.log('- local_aws-credentials (AWS credentials DO NOT DELETE)');
    console.log('- aws-resources.json (AWS resource configuration DO NOT DELETE)');
    console.log('.');
    console.log('.');
    console.log('Sample files have been uploaded to the S3 bucket. To delete them run the below command after uploading your own photos:');
    console.log(' node delete_samples.js');
    console.log('.');
    console.log('.');
    console.log('For your convenience a script has been added to help upload photos to the S3 bucket and copy them to the local cache folder. connect usb stick and run:');
    console.log(' node upload_from_usb.js');
    console.log('.');
    console.log('.');
    console.log('Highly recommend you modify the IAM user that is used by this module to be a more restricted user now that everything is deployed. See readme for more details.');
};

main();