import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/bn.service.ts', '**/bignumber.service.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
