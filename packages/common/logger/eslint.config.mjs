import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/bunyan-service.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
