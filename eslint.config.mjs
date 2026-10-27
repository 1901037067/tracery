import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', '.local/**', 'public/vendor/**'] },
  {
    files: ['server/**/*.js', 'electron/**/*.cjs', 'public/js/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }] }
  },
  { files: ['server/**/*.js', 'electron/**/*.cjs'], languageOptions: { globals: globals.node } },
  { files: ['public/js/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['electron/**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  {
    files: ['server/path-guard.js', 'server/user-path.js', 'server/request-guard.js', 'server/history-store.js', 'server/note-store.js', 'server/content-security.js', 'server/directory-watcher.js', 'server/index-cache.js', 'electron/server-process.cjs', 'public/js/wiki-path.js', 'public/js/hotkeys.js', 'public/js/reconnect.js', 'public/js/cm/wiki-completion.js'],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }] }
  }
];
