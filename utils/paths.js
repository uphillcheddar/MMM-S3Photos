const path = require('path');

function getModulePaths(moduleName) {
    const moduleRoot = path.resolve(__dirname, '..');
    return {
        moduleDir: moduleRoot,
        cacheDir: path.join(moduleRoot, 'cache'),
        credentialsPath: path.join(moduleRoot, 'local_aws-credentials'),
        envPath: path.join(moduleRoot, '.env')
    };
}

module.exports = { getModulePaths }; 