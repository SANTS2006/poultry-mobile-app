const base = require('./jest.config.js');
module.exports = { ...base, globalSetup: '<rootDir>/test/global-setup.ts', testTimeout: 30000 };
