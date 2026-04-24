module.exports = {
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json'],
  testMatch: ['**/test/**/*.spec.js', '**/test/**/*.e2e-spec.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/main.js'],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 75,
      lines: 75,
      statements: 75,
    },
  },
  setupFiles: ['reflect-metadata', '@babel/register'],
  testTimeout: 30000,
  verbose: true,
  // Prevents TypeORM metadata decorator issues in test isolation
  moduleNameMapper: {},
};
