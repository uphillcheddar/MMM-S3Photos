const inquirer = require('inquirer');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const { IAMClient, DetachUserPolicyCommand, AttachUserPolicyCommand, ListAttachedUserPoliciesCommand, CreatePolicyCommand } = require('@aws-sdk/client-iam');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const awsCredentials = require('./utils/awsCredentials');
const { EventEmitter } = require('events');

EventEmitter.defaultMaxListeners = 15;

const BACKUP_FILE = path.join(__dirname, 'mmm-s3photos-backup.json');

const isCommandAvailable = (command) => {
    try {
        execSync(`command -v ${command}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const isRoot = () => process.getuid && process.getuid() === 0;

const checkWorkingDirectory = () => {
    const currentDir = path.basename(process.cwd());
    if (currentDir !== 'MMM-S3Photos') {
        console.error('\x1b[31mError: This script must be run from the MMM-S3Photos module directory\x1b[0m');
        process.exit(1);
    }
};

const checkSudoPrivileges = () => {
    if ((os.platform() === 'linux' || os.platform() === 'darwin') && !isRoot()) {
        console.error('\x1b[31mError: Some operations require sudo privileges\x1b[0m');
        console.log('\x1b[33mPlease run the setup script with sudo:\x1b[0m sudo node setup.js');
        process.exit(1);
    }
};

const promptInstallTool = async (toolName, installFn) => {
    const { install } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'install',
            message: `${toolName} is not installed. Would you like to install it now?`,
            default: true
        }
    ]);
    if (install) installFn();
    else {
        console.error(`\x1b[31m${toolName} is required. Exiting setup.\x1b[0m`);
        process.exit(1);
    }
};

const checkRequiredTools = async () => {
    if (!isCommandAvailable('aws')) await promptInstallTool('AWS CLI', installAwsCli);
};

const installAwsCli = () => {
    console.log('Installing AWS CLI...');
    if (os.platform() === 'linux') {
        if (!isCommandAvailable('unzip')) {
            console.log('Installing unzip...');
            execSync('apt-get install -y unzip', { stdio: 'inherit' });
        }
        execSync('curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"', { stdio: 'inherit' });
        execSync('unzip awscliv2.zip', { stdio: 'inherit' });
        execSync('sudo ./aws/install', { stdio: 'inherit' });
        fs.rmSync('awscliv2.zip', { force: true });
        fs.rmSync('./aws', { recursive: true, force: true });
    } else if (os.platform() === 'darwin') {
        execSync('curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"', { stdio: 'inherit' });
        execSync('sudo installer -pkg AWSCLIV2.pkg -target /', { stdio: 'inherit' });
        fs.rmSync('AWSCLIV2.pkg', { force: true });
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
        type: 'input',
        name: 'accountId',
        message: 'Enter your AWS Account ID:',
        when: (answers) => answers.hasAwsAccount
    },
    {
        type: 'input',
        name: 'accessKeyId',
        message: 'Enter your AWS Access Key ID:',
        when: (answers) => answers.hasAwsAccount
    },
    {
        type: 'input',
        name: 'secretAccessKey',
        message: 'Enter your AWS Secret Access Key:',
        when: (answers) => answers.hasAwsAccount
    },
    {
        type: 'input',
        name: 'region',
        message: 'Enter your AWS Region example: us-east-1:',
        when: (answers) => answers.hasAwsAccount
    },
    {
        type: 'confirm',
        name: 'lockDownUser',
        message: 'Would you like to apply security restrictions to your IAM user? (Highly Recommended)\n' +
                 '  • Will removes admin access from this IAM-user\n' +
                 '  • Limits IAM user access to only the S3 bucket and required Lambda functions\n' +
                 '  • Reduces risk if credentials are exposed\n' +
                 '\n  WARNING: This can only be reversed through the AWS Console',
        default: false,
        when: (answers) => answers.hasAwsAccount
    }
];

const setAwsEnvironmentVariables = (credentials) => {
    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    process.env.AWS_REGION = credentials.region;
    process.env.AWS_ACCOUNT_ID = credentials.accountId;
};




const saveBackupFile = (credentials, awsResources) => {
    const backup = {
        createdAt: new Date().toISOString(),
        credentials,
        awsResources
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    console.log('✔ Installation backup saved to mmm-s3photos-backup.json');
};

const checkForBackupAndRestore = async () => {
    if (!fs.existsSync(BACKUP_FILE)) return false;

    let backup;
    try {
        backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    } catch {
        console.warn('\x1b[33m⚠️  Backup file found but could not be read. Proceeding with fresh install...\x1b[0m\n');
        return false;
    }

    const { restoreFromBackup } = await inquirer.prompt([{
        type: 'confirm',
        name: 'restoreFromBackup',
        message: 'A previous installation backup was found. Would you like to restore from it instead of installing fresh?\n' +
                 '  • Skips CDK deployment (avoids trying to deploy with previously locked down permissions)\n' +
                 '  • Restores credentials and AWS resource configuration from backup',
        default: true
    }]);

    if (!restoreFromBackup) return false;

    setAwsEnvironmentVariables(backup.credentials);

    console.log('\n✔ Restored credentials and AWS resource configuration.');
    console.log(`  S3 Bucket:  ${backup.awsResources.s3Bucket}`);
    console.log(`  Lambda:     ${backup.awsResources.lambdaFunction}`);
    if (backup.createdAt) {
        console.log(`  Backed up:  ${new Date(backup.createdAt).toLocaleString()}`);
    }

    return true;
};

const uploadSampleFile = async (bucketName) => {
    console.log('Uploading sample files to S3...');
    await awsCredentials.withCredentials(async () => {
        const s3Client = new S3Client({ region: process.env.AWS_REGION });
        const sampleFiles = [
            'pexels-dan-mooham.jpg',
            'pexels-matreding.jpg',
            'pexels-pixabay.jpg'
        ];

        for (const file of sampleFiles) {
            const filePath = path.join(__dirname, 'cache', 'samples', file);
            const content = fs.readFileSync(filePath);

            const params = {
                Bucket: bucketName,
                Key: `samples/${file}`,
                Body: content,
                ContentType: 'image/jpeg'
            };

            try {
                await s3Client.send(new PutObjectCommand(params));
                console.log(`Uploaded ${file}`);
            } catch (err) {
                console.error(`Failed to upload ${file}:`, err);
                throw err;
            }
        }
    });
};

const deployInfrastructure = async (credentials) => {
    const loadEnv = require('./utils/loadEnv');
    console.log('Installing project dependencies...');
    execSync('npm install', { stdio: 'inherit' });

    if (!loadEnv(true)) throw new Error('Failed to load environment variables');

    const cdkBin = path.join(__dirname, 'node_modules', '.bin', 'cdk');
    const bootstrapStackName = 'mmm-s3photos-bootstrap';

    try {
        execSync(`"${cdkBin}" bootstrap aws://${credentials.accountId}/${credentials.region} --toolkit-stack-name ${bootstrapStackName} --qualifier mmm`, {
            stdio: 'inherit',
            env: process.env
        });
    } catch (error) {
        if (!error.message.includes('already bootstrapped')) throw error;
        console.log('Environment already bootstrapped. Proceeding...');
    }

    console.log('Deploying CDK stack...');
    execSync(`"${cdkBin}" deploy S3PhotosStack --toolkit-stack-name ${bootstrapStackName} --require-approval never`, {
        stdio: 'inherit',
        env: process.env
    });
};

const generateConfigFiles = async (credentials) => {
    await awsCredentials.withCredentials(async () => {
        const cfClient = new CloudFormationClient({ region: credentials.region });
        const command = new DescribeStacksCommand({ StackName: 'S3PhotosStack' });
        const data = await cfClient.send(command);
        const outputs = data.Stacks[0].Outputs;

        const config = {
            s3Bucket: outputs.find(o => o.OutputKey === 'S3PhotosBucketName').OutputValue,
            lambdaFunction: outputs.find(o => o.OutputKey === 'S3PhotosHandlerName').OutputValue
        };

        fs.writeFileSync(path.join(__dirname, 'aws-resources.json'), JSON.stringify(config, null, 2));
        await uploadSampleFile(config.s3Bucket);

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
                    Resource: `arn:aws:lambda:${credentials.region}:${credentials.accountId}:function:${config.lambdaFunction}`
                }
            ]
        };

        fs.writeFileSync(path.join(__dirname, 'minimal-policy.json'), JSON.stringify(minimalPolicy, null, 2));
    });
};

const updateUserPermissions = async (username) => {
    await awsCredentials.withCredentials(async () => {
        const iamClient = new IAMClient({ region: process.env.AWS_REGION });

        const attached = await iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: username }));
        const adminPolicy = attached.AttachedPolicies.find(p => p.PolicyArn.includes('AdministratorAccess'));

        if (adminPolicy) {
            console.log('Removing AdministratorAccess policy...');
            await iamClient.send(new DetachUserPolicyCommand({
                UserName: username,
                PolicyArn: adminPolicy.PolicyArn
            }));
        }

        console.log('Attaching minimal IAM policy...');
        const policyDoc = fs.readFileSync(path.join(__dirname, 'minimal-policy.json'), 'utf8');

        const { Policy } = await iamClient.send(new CreatePolicyCommand({
            PolicyName: 'MMMS3PhotosMinimalAccess',
            PolicyDocument: policyDoc
        }));

        await iamClient.send(new AttachUserPolicyCommand({
            UserName: username,
            PolicyArn: Policy.Arn
        }));

        console.log('✔ Minimal policy applied.');
    });
};

const getCurrentUser = async () => {
    return awsCredentials.withCredentials(async () => {
        const stsClient = new STSClient({ region: process.env.AWS_REGION });
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        return identity.Arn.split('/').pop();
    });
};

const main = async () => {
    try {
        checkWorkingDirectory();
        checkSudoPrivileges();

        const restored = await checkForBackupAndRestore();
        if (restored) {
            console.log('\n Setup restored from backup!');
            return;
        }

        await checkRequiredTools();

        const answers = await inquirer.prompt(questions);
        if (!answers.hasAwsAccount) {
            console.log('Please create an AWS account and then run this script again.');
            return;
        }

        const credentials = {
            accessKeyId: answers.accessKeyId,
            secretAccessKey: answers.secretAccessKey,
            region: answers.region,
            accountId: answers.accountId
        };

        setAwsEnvironmentVariables(credentials);
        await deployInfrastructure(credentials);
        await generateConfigFiles(credentials);

        const awsResources = JSON.parse(fs.readFileSync(path.join(__dirname, 'aws-resources.json'), 'utf8'));
        saveBackupFile(credentials, awsResources);

        if (answers.lockDownUser) {
            const username = await getCurrentUser();
            console.log(`Detected IAM user: ${username}`);
            await updateUserPermissions(username);
        }

        console.log('\n✅ Setup complete!');
        console.log('Your AWS infrastructure is deployed.');
        console.log('Sample files are uploaded. Run `node delete_samples.js` to remove them.');
    } catch (err) {
        console.error('❌ Setup failed:', err);
        process.exit(1);
    }
};

main();
