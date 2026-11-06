import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '**/templates/**', 'examples/**'] },
  ...tseslint.configs.recommended,
);
