import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/bunyan-logger.service.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
