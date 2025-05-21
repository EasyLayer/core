import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/secure-storage.module.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
