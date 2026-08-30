import Mocha from 'mocha';
import * as path from 'node:path';

/** Entry point required by @vscode/test-electron for the packaged Extension Development Host. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ timeout: 420_000 });
  mocha.addFile(path.join(__dirname, 'native-ubuntu.acceptance.test.js'));
  await new Promise<void>((resolve, reject) => mocha.run((failures) => failures === 0 ? resolve() : reject(new Error('native acceptance assertions failed'))));
}
