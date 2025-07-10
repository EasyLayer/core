import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/rate-limiter.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
