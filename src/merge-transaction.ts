import { safeFolder } from './export';

export interface MergeEdit { path: string; before: string; after: string }
export interface MergeArchive { path: string; content: string; to: string }
export interface MergeWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  /** Atomically compare the current text with before, and refuse a changed file. */
  process(path: string, before: string, after: string): Promise<void>;
  /** Compare current text before archiving; retain the actual file at retainedPath when provided. */
  trash(path: string, expectedContent: string, retainedPath?: string): Promise<void>;
  /** Update only the journal successfully created by this transaction. */
  journal(path: string, content: string): Promise<void>;
}
export interface MergeCompletion { from: string; to: string }
export class MergeTransactionError extends Error {
  readonly completed: MergeCompletion[];
  readonly folder: string;
  constructor(cause: unknown, completed: MergeCompletion[], folder: string) {
    super(`合并未全部完成：${errorText(cause)}`, { cause });
    this.name = 'MergeTransactionError';
    this.completed = completed.map(item => ({ ...item }));
    this.folder = folder;
  }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const key = (path: string) => path.toLocaleLowerCase();
function notePath(path: string): string {
  if (typeof path !== 'string' || !path || !path.endsWith('.md')
    || /[\\\x00-\x1f<>:"|?*]/.test(path)
    || path.split('/').some(part => !part || part.startsWith('.') || /[. ]$/.test(part)))
    throw new Error(`无效的库内笔记路径：${path}`);
  return path;
}

/** Backups and the initial journal must finish before any vault note is changed.
 * A failure stops immediately; completed contains only successfully archived sources.
 * Original text is retained as .bak, so backups do not become native graph nodes.
 */
export async function executeMergeTransaction(folder: string, edits: MergeEdit[], archives: MergeArchive[], writer: MergeWriter): Promise<{ completed: MergeCompletion[]; folder: string }> {
  let resolvedFolder = folder, folderCreated = false, journalCreated = false;
  const applied: string[] = [], completed: MergeCompletion[] = [];
  const backups: Array<{ path: string; backup: string; kind: 'edit' | 'archive'; to?: string; retained?: string }> = [];
  let status: 'writing' | 'complete' | 'partial' = 'writing';
  let failure: string | undefined;
  const document = () => JSON.stringify({ version: 1, folder: resolvedFolder, status, backups, applied, completed, ...(failure === undefined ? {} : { error: failure }) }, null, 2);
  const journalPath = () => `${resolvedFolder}/journal.json`;
  try {
    resolvedFolder = safeFolder(folder);
    // Freeze the accepted plan before the first await; UI state may change while
    // storage operations are pending, but it must not change this transaction.
    edits = edits.map(item => ({ ...item }));
    archives = archives.map(item => ({ ...item }));
    const edited = new Set<string>(), archived = new Set<string>();
    for (const edit of edits) {
      notePath(edit.path);
      if (typeof edit.before !== 'string' || typeof edit.after !== 'string') throw new Error('改写原文与新正文必须是文本。');
      if (edited.has(key(edit.path))) throw new Error(`重复的改写路径：${edit.path}`);
      edited.add(key(edit.path));
    }
    for (const archive of archives) {
      notePath(archive.path); notePath(archive.to);
      if (typeof archive.content !== 'string' || !archive.content.length) throw new Error(`归档原文为空：${archive.path}`);
      if (archived.has(key(archive.path))) throw new Error(`重复的归档路径：${archive.path}`);
      if (edited.has(key(archive.path))) throw new Error(`待归档来源不能同时改写：${archive.path}`);
      archived.add(key(archive.path));
    }
    for (const archive of archives) {
      if (archived.has(key(archive.to))) throw new Error(`合并目标不能同时归档：${archive.to}`);
    }
    if (await writer.exists(resolvedFolder)) throw new Error('备份目录已存在，请使用新的目录。');
    // Verify every involved file before creating any backup directory. The writer
    // still compares text at each mutation, protecting changes after this check.
    const involved = new Set([...edits.map(item => item.path), ...archives.flatMap(item => [item.path, item.to])]);
    for (const path of involved) if (!await writer.exists(path)) throw new Error(`笔记不存在：${path}`);
    const parts = resolvedFolder.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/');
      if (index === parts.length) {
        // Refuse a concurrently created target rather than mixing transactions.
        if (await writer.exists(path)) throw new Error('备份目录已存在，请使用新的目录。');
        await writer.mkdir(path); folderCreated = true;
      } else if (!await writer.exists(path)) await writer.mkdir(path);
    }
    for (const entry of [...edits.map(item => ({ path: item.path, content: item.before, kind: 'edit' as const })), ...archives.map(item => ({ path: item.path, content: item.content, kind: 'archive' as const, to: item.to }))]) {
      const backup = `${backups.length + 1}.bak`;
      await writer.create(`${resolvedFolder}/${backup}`, entry.content);
      backups.push({ path: entry.path, backup, kind: entry.kind, ...('to' in entry ? { to: entry.to, retained:`source-${backups.length + 1}.bak` } : {}) });
    }
    await writer.create(journalPath(), document()); journalCreated = true;
    for (const edit of edits) {
      await writer.process(edit.path, edit.before, edit.after);
      applied.push(edit.path);
      await writer.journal(journalPath(), document());
    }
    for (const archive of archives) {
      await writer.trash(archive.path, archive.content, `${resolvedFolder}/${backups.find(item=>item.path===archive.path)!.retained}`);
      completed.push({ from: archive.path, to: archive.to });
      await writer.journal(journalPath(), document());
    }
    status = 'complete';
    await writer.journal(journalPath(), document());
    return { completed: completed.map(item => ({ ...item })), folder: resolvedFolder };
  } catch (error) {
    status = 'partial'; failure = errorText(error);
    try {
      if (journalCreated) await writer.journal(journalPath(), document());
      else if (folderCreated && !await writer.exists(journalPath())) await writer.create(journalPath(), document());
    } catch { /* Preserve the original failure and accurately reported progress. */ }
    throw new MergeTransactionError(error, completed, resolvedFolder);
  }
}
