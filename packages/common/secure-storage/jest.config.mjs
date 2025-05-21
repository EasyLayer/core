import baseConfig from '../../../jest.config.mjs';

export default {
  ...baseConfig,
  roots: [
    "<rootDir>/src/"
  ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: '<rootDir>/tsconfig.json',
    }]
  },
  testPathIgnorePatterns: baseConfig.testPathIgnorePatterns.concat([
    "<rootDir>/node_modules",
    "<rootDir>/dist",
  ]),
}; 