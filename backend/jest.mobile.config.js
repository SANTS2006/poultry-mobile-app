// Runs the mobile app's pure-TypeScript logic (sync engine, token manager…) with the backend's toolchain.
// When the Expo app is scaffolded (Phase 11) it gets its own jest-expo setup and these tests move there unchanged.
module.exports = {
  rootDir: '../mobile',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: '<rootDir>/tsconfig.sync.json' }] },
  moduleDirectories: ['node_modules', '<rootDir>/../backend/node_modules'],
};
