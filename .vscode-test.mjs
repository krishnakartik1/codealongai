import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/walkthrough.test.js',
  workspaceFolder: './demo-workspace',
  mocha: {
    timeout: 20_000
  }
});
