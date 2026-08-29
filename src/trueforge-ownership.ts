import { readdir, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import * as path from 'node:path';

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

export async function recoverStaleOwnership(lockPath: string): Promise<boolean> {
  const record = await readOwnership(lockPath);
  if (!record) { await unlink(lockPath).catch(() => undefined); return true; }
  if (await ownerIsAlive(record)) return false;
  const recordedChild = await findRecordedChild(record);
  if (recordedChild === 'unsafe') return false;
  if (recordedChild !== undefined && !await terminateOwnedProcess(recordedChild, record)) return false;
  await unlink(lockPath).catch(() => undefined);
  return true;
}

export async function ownsRecordedChild(record: OwnershipRecord): Promise<boolean> {
  return record.childPid !== undefined && await verifyChild(record.childPid, record) === true;
}

async function readOwnership(lockPath: string): Promise<OwnershipRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as OwnershipRecord;
    return Number.isInteger(record.ownerPid) && typeof record.ownerStartTime === 'string' && typeof record.launchId === 'string' && typeof record.executable === 'string' && typeof record.cli === 'string' && Number.isInteger(record.port) && typeof record.dataPath === 'string' ? record : undefined;
  } catch { return undefined; }
}

async function ownerIsAlive(record: OwnershipRecord): Promise<boolean> {
  if (!processIsAlive(record.ownerPid)) return false;
  try { return await processStartTime(record.ownerPid) === record.ownerStartTime; } catch { return false; }
}

async function findRecordedChild(record: OwnershipRecord): Promise<number | 'unsafe' | undefined> {
  try {
    await Promise.all([realpath(record.executable), realpath(record.dataPath)]);
  } catch { return 'unsafe'; }
  if (record.childPid !== undefined) {
    const verified = await verifyChild(record.childPid, record);
    return verified === 'missing' ? undefined : verified ? record.childPid : 'unsafe';
  }
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number);
  const matches = (await Promise.all(pids.map(async (pid) => await verifyChild(pid, record) ? pid : undefined))).filter((pid): pid is number => pid !== undefined);
  return matches.length === 0 ? undefined : matches.length === 1 ? matches[0] : 'unsafe';
}

async function verifyChild(pid: number, record: OwnershipRecord): Promise<boolean | 'missing'> {
  const proc = `/proc/${String(pid)}`;
  try {
    const [executable, command, environment, cwd, startTime] = await Promise.all([
      realpath(path.join(proc, 'exe')), readFile(path.join(proc, 'cmdline'), 'utf8'), readFile(path.join(proc, 'environ'), 'utf8'), realpath(path.join(proc, 'cwd')), processStartTime(pid)
    ]);
    const expectedExecutable = await realpath(record.executable);
    const expectedDataPath = await realpath(record.dataPath);
    const arguments_ = command.split('\0').filter(Boolean);
    const expectedArguments = [expectedExecutable, record.cli, '--port', String(record.port)];
    return executable === expectedExecutable && cwd === expectedDataPath && arguments_.length === expectedArguments.length && arguments_.every((value, index) => value === expectedArguments[index]) && environment.split('\0').includes(`CODEALONGAI_TRUEFORGE_LAUNCH_ID=${record.launchId}`) && environment.split('\0').includes(`XDG_DATA_HOME=${expectedDataPath}`) && (record.childStartTime === undefined || startTime === record.childStartTime);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !processIsAlive(pid) ? 'missing' : false;
  }
}

export async function processStartTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const closingParenthesis = stat.lastIndexOf(')');
  const fields = stat.slice(closingParenthesis + 2).split(' ');
  const startTime = fields[19];
  if (!startTime) throw new Error('Could not read the TrueForge process start time.');
  return startTime;
}

function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return pid > 0; } catch { return false; } }

async function terminateOwnedProcess(pid: number, record: OwnershipRecord): Promise<boolean> {
  if (!await ownsRecordedChild(record)) return false;
  process.kill(pid, 'SIGTERM');
  if (await waitForPidExit(pid, 5_000)) return true;
  if (processIsAlive(pid) && await ownsRecordedChild(record)) process.kill(pid, 'SIGKILL');
  return waitForPidExit(pid, 5_000);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!processIsAlive(pid)) return true; await new Promise<void>((resolve) => setTimeout(resolve, 50)); }
  return !processIsAlive(pid);
}
