import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/money.bignumber.ts', '**/money.bn.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
