import { readFile, writeFile } from 'node:fs/promises';
const commit = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('Packaging requires the exact GITHUB_SHA build identity.');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
packageJson.codealongai = { ...(packageJson.codealongai ?? {}), buildCommit: commit };
await writeFile(new URL('../package.json', import.meta.url), `${JSON.stringify(packageJson, null, 2)}\n`);
