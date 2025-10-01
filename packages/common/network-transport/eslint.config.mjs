import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/http.service.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
