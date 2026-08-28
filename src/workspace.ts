import * as path from 'node:path';

export const workspaceResultLimit = 200;
const maxFileBytes = 1024 * 1024;

export interface WorkspaceFile {
  readonly path: string;
  readonly text: string;
  readonly dirty: boolean;
  readonly documentVersion?: number;
}

export interface WorkspaceSource {
  readonly workspaceFolderCount: () => number;
  readonly files: () => Promise<readonly WorkspaceFile[]>;
}

export type WorkspaceErrorCode = 'workspace_unavailable' | 'path_invalid' | 'path_outside_workspace' | 'file_unsupported' | 'file_too_large';

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
    return (await this.availableFiles()).map((file) => file.path).sort(utf16Compare);
  }

  public async read(candidate: string, startLine?: number, endLine?: number): Promise<{ path: string; startLine: number; endLine: number; text: string; dirty: boolean; documentVersion?: number }> {
    if ((startLine === undefined) !== (endLine === undefined) || (startLine !== undefined && (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine! < startLine))) throw new WorkspaceError('path_invalid');
    const requested = normalizeWorkspacePath(candidate);
    const file = (await this.availableFiles()).find((item) => item.path === requested);
    if (!file) throw new WorkspaceError('file_unsupported');
    const lines = file.text.split(/\r\n|\n|\r/);
    const actualStart = startLine ?? 0;
    const actualEnd = endLine ?? lines.length;
    if (actualEnd > lines.length) throw new WorkspaceError('path_invalid');
    return { path: file.path, startLine: actualStart, endLine: actualEnd, text: lines.slice(actualStart, actualEnd).join('\n'), dirty: file.dirty, ...(file.documentVersion === undefined ? {} : { documentVersion: file.documentVersion }) };
  }

  public async search(query: string): Promise<WorkspaceMatch[]> {
    if (!query) throw new WorkspaceError('path_invalid');
    const matches: WorkspaceMatch[] = [];
    for (const file of await this.availableFiles()) {
      const lines = file.text.split(/\r\n|\n|\r/);
      for (let line = 0; line < lines.length; line += 1) {
        let character = lines[line].indexOf(query);
        while (character !== -1) {
          matches.push({ path: file.path, range: { start: { line, character }, end: { line, character: character + query.length } }, preview: preview(lines[line], character, query.length) });
          character = lines[line].indexOf(query, character + Math.max(query.length, 1));
        }
      }
    }
    return matches.sort((left, right) => utf16Compare(left.path, right.path) || left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character || left.range.end.line - right.range.end.line || left.range.end.character - right.range.end.character);
  }

  private async availableFiles(): Promise<WorkspaceFile[]> {
    if (this.source.workspaceFolderCount() !== 1) throw new WorkspaceError('workspace_unavailable');
    return (await this.source.files()).map((file) => ({ ...file, path: normalizeWorkspacePath(file.path) })).filter((file) => {
      if (file.text.includes('\0')) return false;
      if (Buffer.byteLength(file.text, 'utf8') > maxFileBytes) return false;
      return true;
    });
  }
}

export function pageAfter<T>(items: readonly T[], cursor: string | undefined, key: (item: T) => string): { items: T[]; nextCursor?: string } {
  const start = cursor === undefined ? 0 : items.findIndex((item) => key(item) > cursor);
  const page = items.slice(start < 0 ? items.length : start, (start < 0 ? items.length : start) + workspaceResultLimit);
  return { items: page, ...(page.length === workspaceResultLimit && page.length < items.length - (start < 0 ? items.length : start) ? { nextCursor: key(page[page.length - 1]) } : {}) };
}

const utf16Compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function preview(line: string, start: number, length: number): string {
  if (line.length <= 200) return line;
  let windowStart = Math.max(0, start - 80);
  if (windowStart + 200 > line.length) windowStart = line.length - 200;
  const windowEnd = Math.min(line.length, windowStart + 200);
  return `${windowStart > 0 ? '…' : ''}${line.slice(windowStart, windowEnd)}${windowEnd < line.length ? '…' : ''}`;
}
