import * as path from 'node:path';

export const workspaceResultLimit = 200;
const maxFileBytes = 1024 * 1024;

export interface WorkspaceFile {
  readonly path: string;
  readonly text?: string;
  readonly dirty: boolean;
  readonly documentVersion?: number;
  readonly failure?: 'file_unsupported' | 'file_too_large' | 'path_outside_workspace';
}

export interface WorkspaceSource {
  readonly workspaceFolderCount: () => number;
  readonly listFiles: () => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<WorkspaceFile>;
}

export type WorkspaceErrorCode = 'workspace_unavailable' | 'path_invalid' | 'range_invalid' | 'path_outside_workspace' | 'file_unsupported' | 'file_too_large';

export class WorkspaceError extends Error {
  public constructor(public readonly code: WorkspaceErrorCode) { super(code); }
}

export interface WorkspaceMatch {
  readonly path: string;
  readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
  readonly preview: string;
}

export function normalizeWorkspacePath(candidate: string): string {
  if (!candidate || candidate.includes('\0') || path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) throw new WorkspaceError('path_invalid');
  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new WorkspaceError('path_outside_workspace');
  return normalized;
}

export class WorkspaceReader {
  public constructor(private readonly source: WorkspaceSource) {}

  public async list(): Promise<string[]> {
    this.requireWorkspace();
    return (await this.source.listFiles()).map(normalizeWorkspacePath).sort(utf16Compare);
  }

  public async read(request: { path: string; startLine?: number; endLine?: number }): Promise<{ path: string; startLine: number; endLine: number; text: string; dirty: boolean; documentVersion?: number }> {
    const { path: candidate, startLine, endLine } = request;
    if (typeof candidate !== 'string' || !candidate) throw new WorkspaceError('path_invalid');
    if ((startLine === undefined) !== (endLine === undefined) || (startLine !== undefined && (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine! < startLine))) throw new WorkspaceError('range_invalid');
    const requested = normalizeWorkspacePath(candidate);
    this.requireWorkspace();
    let sourceFile: WorkspaceFile;
    try { sourceFile = await this.source.readFile(requested); }
    catch { throw new WorkspaceError('path_invalid'); }
    const file = this.classify(sourceFile);
    if (file.failure) throw new WorkspaceError(file.failure);
    const lines = file.text!.split(/\r\n|\n|\r/);
    const actualStart = startLine ?? 0;
    const actualEnd = endLine ?? lines.length;
    if (actualStart > lines.length || actualEnd > lines.length) throw new WorkspaceError('range_invalid');
    return { path: file.path, startLine: actualStart, endLine: actualEnd, text: lines.slice(actualStart, actualEnd).join('\n'), dirty: file.dirty, ...(file.documentVersion === undefined ? {} : { documentVersion: file.documentVersion }) };
  }

  /** Validates a UTF-16 anchor against the same current (including dirty)
   * source that MCP exposes.  It grants no wider workspace access. */
  public async validateAnchor(path: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): Promise<void> {
    if (!Number.isInteger(startLine) || !Number.isInteger(startCharacter) || !Number.isInteger(endLine) || !Number.isInteger(endCharacter) || startLine < 0 || startCharacter < 0 || endLine < 0 || endCharacter < 0) throw new WorkspaceError('range_invalid');
    const file = await this.read({ path });
    const lines = file.text.split('\n');
    if (startLine >= lines.length || endLine >= lines.length || startCharacter > lines[startLine].length || endCharacter > lines[endLine].length || endLine < startLine || (endLine === startLine && endCharacter < startCharacter)) throw new WorkspaceError('range_invalid');
  }

  public async search(query: string, after?: string): Promise<WorkspaceMatch[]> {
    if (!query) throw new WorkspaceError('path_invalid');
    const matches: WorkspaceMatch[] = [];
    for (const filePath of await this.list()) {
      const file = this.classify(await this.source.readFile(filePath));
      if (file.failure) continue;
      const lines = file.text!.split(/\r\n|\n|\r/);
      for (let line = 0; line < lines.length; line += 1) {
        let character = lines[line].indexOf(query);
        while (character !== -1) {
          const match = { path: file.path, range: { start: { line, character }, end: { line, character: character + query.length } }, preview: preview(lines[line], character, query.length) };
          const key = `${match.path}\u0000${line}\u0000${character}\u0000${line}\u0000${character + query.length}`;
          if (after === undefined || key > after) matches.push(match);
          if (matches.length > workspaceResultLimit) return matches;
          character = lines[line].indexOf(query, character + Math.max(query.length, 1));
        }
      }
    }
    return matches;
  }

  private requireWorkspace(): void {
    if (this.source.workspaceFolderCount() !== 1) throw new WorkspaceError('workspace_unavailable');
  }

  private classify(file: WorkspaceFile): WorkspaceFile {
    if (!file || typeof file.path !== 'string' || typeof file.dirty !== 'boolean' || (file.failure === undefined && typeof file.text !== 'string')) throw new WorkspaceError('path_invalid');
    const normalized = { ...file, path: normalizeWorkspacePath(file.path) };
    return (() => {
      if (normalized.failure) return normalized;
      if (normalized.text!.includes('\0')) return { ...normalized, failure: 'file_unsupported' as const };
      if (Buffer.byteLength(normalized.text!, 'utf8') > maxFileBytes) return { ...normalized, failure: 'file_too_large' as const };
      return normalized;
    })();
  }
}

const utf16Compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function preview(line: string, start: number, length: number): string {
  if (line.length <= 200) return line;
  const ellipses = 2;
  let windowStart = Math.max(0, start - 80);
  if (windowStart + 200 - ellipses > line.length) windowStart = line.length - (200 - ellipses);
  const windowEnd = Math.min(line.length, windowStart + 200 - ellipses);
  return `${windowStart > 0 ? '…' : ''}${line.slice(windowStart, windowEnd)}${windowEnd < line.length ? '…' : ''}`;
}
