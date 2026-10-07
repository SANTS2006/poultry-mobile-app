const expo = require('eslint-config-expo/flat');
module.exports = [
  ...expo,
  { ignores: ['node_modules', 'dist', '.expo'] },
  { rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] } },
  { files: ['scripts/**'], rules: { 'no-console': 'off' } },
  { files: ['jest.setup.js', 'jest.config.js'], languageOptions: { globals: { jest: 'readonly', require: 'readonly', module: 'readonly' } } },
];
