const path = require('path');
const baseConfig = require('../../../jest.config');

module.exports = {
    ...baseConfig,
    testEnvironment: 'node',
    roots: [
      "<rootDir>/src/"
    ],
    transform: {
      "^.+\\.ts?$": ['ts-jest', {
        tsconfig: path.resolve(__dirname, './tsconfig.json'),
      }]
    },
    testPathIgnorePatterns: baseConfig.testPathIgnorePatterns.concat([
        "<rootDir>/node_modules",
        "<rootDir>/dist",
        // ...(baseConfig.testPathIgnorePatterns || [])
    ]),
};