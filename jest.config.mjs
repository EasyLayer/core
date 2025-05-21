export default {
  preset: "ts-jest",
  testEnvironment: 'node',
  testPathIgnorePatterns: ['node_modules'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  /* Stop test execution after the first failure */
  bail: true,
  /* Output detailed test execution information */
  verbose: true,
  /* Timeout for each individual test */
  testTimeout: 30000,
  /* Run Jest in watch mode */
  watch: false,
  /* Disable caching */
  cache: false,
  /* Specify cache directory */
  // cacheDirectory: path.resolve(__dirname, 'node_modules/.jest_cache'),
}; 