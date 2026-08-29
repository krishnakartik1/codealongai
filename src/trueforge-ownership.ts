import { mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const ownershipFilename = 'ownership.json';
const claimFilename = 'recovery.claim';

export interface OwnershipRecord {
  readonly ownerPid: number;
  readonly ownerStartTime: string;
  readonly launchId: string;
  readonly executable: string;
  readonly cli: string;
  readonly port: number;
  readonly dataPath: string;
  readonly childPid?: number;
  readonly childStartTime?: string;
}

/** Atomically creates the directory which represents one sidecar owner. */
export async function createOwnershipLock(lockPath: string, record: OwnershipRecord): Promise<void> {
  await mkdir(lockPath);
  try { await writeOwnership(lockPath, record); } catch (error) { await rmdir(lockPath).catch(() => undefined); throw error; }
}

/** Replaces ownership metadata without exposing a partially-written record. */
export async function writeOwnership(lockPath: string, record: OwnershipRecord): Promise<void> {
  const claimPath = await acquireClaim(lockPath);
  if (!claimPath) throw new Error('TrueForge ownership is changing.');
  const temporaryPath = path.join(lockPath, `.ownership-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, 'wx');
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
    try {
      await rename(temporaryPath, ownershipPath(lockPath));
      const directory = await open(lockPath, 'r');
      try { await directory.sync(); } finally { await directory.close().catch(() => undefined); }
    } finally { await unlink(temporaryPath).catch(() => undefined); }
  } finally { await unlink(claimPath).catch(() => undefined); }
}

/** Releases only a lock directory whose durable metadata still names this launch. */
export async function releaseOwnershipIfCurrent(lockPath: string, launchId: string): Promise<void> {
  const claimPath = await acquireClaim(lockPath);
  if (!claimPath) return;
  let retiredPath: string | undefined;
  try {
    const record = await readOwnership(lockPath);
    if (record?.launchId !== launchId) return;
    retiredPath = await retireLock(lockPath);
    await unlink(ownershipPath(retiredPath));
  } finally {
    const claimedPath = retiredPath ?? lockPath;
    await unlink(path.join(claimedPath, claimFilename)).catch(() => undefined);
    if (retiredPath) await rmdir(retiredPath).catch(() => undefined);
  }
}

/**
 * A stale lock remains a directory while this function owns its claim. That
 * prevents a contender from acquiring a replacement between inspection and
 * removal, and makes concurrent recovery fail closed.
 */
export async function recoverStaleOwnership(lockPath: string): Promise<boolean> {
  const claimPath = await acquireClaim(lockPath);
  if (!claimPath) return false;
  let retiredPath: string | undefined;
  try {
    const ownershipRecord = await readOwnership(lockPath);
    if (!ownershipRecord || await ownerIsAlive(ownershipRecord)) return false;
    const recordedChild = await findRecordedChild(ownershipRecord);
    if (recordedChild === 'unsafe') return false;
    if (recordedChild !== undefined && !await terminateOwnedProcess(recordedChild, ownershipRecord.childPid === undefined ? { ...ownershipRecord, childPid: recordedChild } : ownershipRecord)) return false;
    retiredPath = await retireLock(lockPath);
    await unlink(ownershipPath(retiredPath));
    return true;
  } catch { return false; } finally {
    const claimedPath = retiredPath ?? lockPath;
    await unlink(path.join(claimedPath, claimFilename)).catch(() => undefined);
    if (retiredPath) await rmdir(retiredPath).catch(() => undefined);
  }
}

export async function ownsRecordedChild(record: OwnershipRecord): Promise<boolean> { return record.childPid !== undefined && await verifyChild(record.childPid, record) === true; }

function ownershipPath(lockPath: string): string { return path.join(lockPath, ownershipFilename); }

async function retireLock(lockPath: string): Promise<string> {
  const retiredPath = `${lockPath}.${randomUUID()}.retired`;
  await rename(lockPath, retiredPath);
  return retiredPath;
}

async function acquireClaim(lockPath: string): Promise<string | undefined> {
  const claimPath = path.join(lockPath, claimFilename);
  try {
    const handle = await open(claimPath, 'wx');
    try { await handle.writeFile(process.pid.toString()); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
    return claimPath;
  } catch { return undefined; }
}

async function readOwnership(lockPath: string): Promise<OwnershipRecord | undefined> {
  try {
    const ownershipRecord = JSON.parse(await readFile(ownershipPath(lockPath), 'utf8')) as OwnershipRecord;
    return Number.isInteger(ownershipRecord.ownerPid) && typeof ownershipRecord.ownerStartTime === 'string' && typeof ownershipRecord.launchId === 'string' && typeof ownershipRecord.executable === 'string' && typeof ownershipRecord.cli === 'string' && Number.isInteger(ownershipRecord.port) && typeof ownershipRecord.dataPath === 'string' ? ownershipRecord : undefined;
  } catch { return undefined; }
}

async function ownerIsAlive(record: OwnershipRecord): Promise<boolean> { if (!processIsAlive(record.ownerPid)) return false; try { return await processStartTime(record.ownerPid) === record.ownerStartTime; } catch { return false; } }

async function findRecordedChild(record: OwnershipRecord): Promise<number | 'unsafe' | undefined> {
  try { await Promise.all([realpath(record.executable), realpath(record.dataPath)]); } catch { return 'unsafe'; }
  if (record.childPid !== undefined) { const verified = await verifyChild(record.childPid, record); return verified === 'missing' ? undefined : verified ? record.childPid : 'unsafe'; }
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number);
  const matches = (await Promise.all(pids.map(async (pid) => await verifyChild(pid, record) === true ? pid : undefined))).filter((pid): pid is number => pid !== undefined);
  return matches.length === 0 ? undefined : matches.length === 1 ? matches[0] : 'unsafe';
}

async function verifyChild(pid: number, record: OwnershipRecord): Promise<boolean | 'missing'> {
  const proc = `/proc/${String(pid)}`;
  try {
    const [executable, command, environment, cwd, startTime] = await Promise.all([realpath(path.join(proc, 'exe')), readFile(path.join(proc, 'cmdline'), 'utf8'), readFile(path.join(proc, 'environ'), 'utf8'), realpath(path.join(proc, 'cwd')), processStartTime(pid)]);
    const expectedExecutable = await realpath(record.executable); const expectedDataPath = await realpath(record.dataPath);
    const arguments_ = command.split('\0').filter(Boolean); const expectedArguments = [expectedExecutable, record.cli, '--port', String(record.port)];
    return executable === expectedExecutable && cwd === expectedDataPath && arguments_.length === expectedArguments.length && arguments_.every((value, index) => value === expectedArguments[index]) && environment.split('\0').includes(`CODEALONGAI_TRUEFORGE_LAUNCH_ID=${record.launchId}`) && environment.split('\0').includes(`XDG_DATA_HOME=${expectedDataPath}`) && (record.childStartTime === undefined || startTime === record.childStartTime);
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && !processIsAlive(pid) ? 'missing' : false; }
}

export async function processStartTime(pid: number): Promise<string> { const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8'); const closingParenthesis = stat.lastIndexOf(')'); const startTime = stat.slice(closingParenthesis + 2).split(' ')[19]; if (!startTime) throw new Error('Could not read the TrueForge process start time.'); return startTime; }

function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return pid > 0; } catch { return false; } }
async function terminateOwnedProcess(pid: number, record: OwnershipRecord): Promise<boolean> { if (!await ownsRecordedChild(record)) return false; process.kill(pid, 'SIGTERM'); if (await waitForPidExit(pid, 5_000)) return true; if (processIsAlive(pid) && await ownsRecordedChild(record)) process.kill(pid, 'SIGKILL'); return waitForPidExit(pid, 5_000); }
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (!processIsAlive(pid)) return true; await new Promise<void>((resolve) => setTimeout(resolve, 50)); } return !processIsAlive(pid); }
