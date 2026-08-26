import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: './demo-workspace',
  mocha: {
    timeout: 20_000
  }
});
