// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/coverage/**',
      '**/.next/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Fastify handlers and plugins are conventionally async even without awaits.
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Architecture boundary: domain modules never import the HTTP or job layers.
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/http/**'], message: 'modules must not depend on the http layer' },
            { group: ['**/jobs/**'], message: 'modules must not depend on the jobs layer' },
          ],
        },
      ],
    },
  },
  // Architecture boundary: provider adapters see only the publishing contract.
  {
    files: ['packages/publishing-core/src/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/**', '**/jobs/**', '**/infra/**'],
              message: 'providers are pure I/O adapters',
            },
            {
              group: ['../../../**'],
              message:
                'providers may only import from the publishing-core package root (provider.ts, render.ts)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
