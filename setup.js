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
    if (!isCommandAvailable('cdk')) await promptInstallTool('AWS CDK', installAwsCdk);
};

const installAwsCli = () => {
    console.log('Installing AWS CLI...');
    if (os.platform() === 'linux') {
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

const installAwsCdk = () => {
    console.log('Installing AWS CDK globally...');
    execSync('npm install -g aws-cdk', { stdio: 'inherit' });
};

const checkCdkVersionAndPrompt = async () => {
    let cliVersion = 'unknown';
    let libVersion = 'unknown';

    try {
        cliVersion = execSync('cdk --version').toString().trim().split(' ')[0];
    } catch {
        return;
    }

    try {
        libVersion = require('aws-cdk-lib/package.json').version;
    } catch (e) {
        console.error('Unable to determine CDK library version.');
        throw e;
    }

    const isIncompatible = cliVersion.startsWith('2.') && libVersion.startsWith('2.') && !cliVersion.startsWith('2.100');
    if (isIncompatible) {
        console.log('\x1b[33m⚠️  CDK CLI and library versions are incompatible!\x1b[0m\n');
        console.log(`Detected CLI: ${cliVersion} | Required lib: ${libVersion}`);

        const { cdkVersionChoice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'cdkVersionChoice',
                message: 'Choose how to proceed:',
                choices: [
                    { name: 'Abort install and exit', value: 'abort' },
                    { name: 'Show update command and exit', value: 'show' },
                    { name: 'Automatically update global CDK CLI to match', value: 'auto' }
                ]
            }
        ]);

        if (cdkVersionChoice === 'abort') {
            console.log('Aborting setup.');
            process.exit(1);
        } else if (cdkVersionChoice === 'show') {
            console.log(`Run: \x1b[32msudo npm install -g aws-cdk@${libVersion}\x1b[0m`);
            process.exit(1);
        } else if (cdkVersionChoice === 'auto') {
            try {
                const cliTargetVersion = getCompatibleCdkCliVersion(libVersion);
                execSync(`npm install -g aws-cdk@${cliTargetVersion}`, { stdio: 'inherit' });

            } catch (e) {
                console.error('\x1b[31mCDK CLI upgrade failed. Try manually with sudo.\x1b[0m');
                console.log(`sudo npm install -g aws-cdk@${libVersion}`);
                process.exit(1);
            }
        }
    }
};
const getCompatibleCdkCliVersion = (libVersion) => {
    const [major, minor] = libVersion.split('.').map(Number);
    if (major === 2 && minor >= 179) {
        return 'latest'; // post-split CLI
    }
    return libVersion; // pre-split, still in sync
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

const parseCredentialsFile = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').reduce((acc, line) => {
        const [key, value] = line.split('=').map(s => s.trim());
        if (key && value) {
            const cleanKey = key.replace(/^aws_/, '');
            if (cleanKey === 'account_id') acc.accountId = value;
            else acc[cleanKey] = value;
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

    const bootstrapStackName = 'mmm-s3photos-bootstrap';

    try {
        execSync(`cdk bootstrap aws://${credentials.accountId}/${credentials.region} --toolkit-stack-name ${bootstrapStackName} --qualifier mmm`, {
            stdio: 'inherit',
            env: process.env
        });
    } catch (error) {
        if (!error.message.includes('already bootstrapped')) throw error;
        console.log('Environment already bootstrapped. Proceeding...');
    }

    console.log('Deploying CDK stack...');
    execSync(`cdk deploy S3PhotosStack --toolkit-stack-name ${bootstrapStackName} --require-approval never`, {
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

const updateUserPermissions = async (credentials, username) => {
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
        await checkRequiredTools();
        await checkCdkVersionAndPrompt();

        const answers = await inquirer.prompt(questions);
        if (!answers.hasAwsAccount) {
            console.log('Please create an AWS account and then run this script again.');
            return;
        }

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
            saveCredentialsFile('./local_aws-credentials', credentials);
        }

        setAwsEnvironmentVariables(credentials);
        await deployInfrastructure(credentials);
        await generateConfigFiles(credentials);

        if (answers.lockDownUser) {
            const username = await getCurrentUser();
            console.log(`Detected IAM user: ${username}`);
            await updateUserPermissions(credentials, username);
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
