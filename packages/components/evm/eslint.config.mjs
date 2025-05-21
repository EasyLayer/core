import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/quick-node.provider.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
