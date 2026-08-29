/** Package-time identity: absent development metadata cannot authorize a producer skill. */
let testCommit: string | undefined;
export function setBuildCommitForTests(commit: string | undefined): void { testCommit = commit; }
export function extensionBuildCommit(): string | undefined {
  if (testCommit) return testCommit;
  const metadata = require('../package.json') as { codealongai?: { buildCommit?: unknown } };
  const commit = metadata.codealongai?.buildCommit;
  return typeof commit === 'string' && /^[0-9a-f]{40}$/i.test(commit) ? commit : undefined;
}
