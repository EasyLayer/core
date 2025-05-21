import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/subscriber.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
