import { nativeSearch } from './export';
import { cloneDiscoveryConfig, validateDiscovery, type DiscoveryConfig } from './workflow';

export interface NativeRun {
  rootPath: string; search: string; folder: string; graphDepth?: number; nodePaths?: Record<string, string>;
  /** Completed explorations connected through shared real vault files. */
  integratedFolders?: string[];
}
export interface RunRecord {
  run: NativeRun; createdAt: string; title: string; nodes: number; relations: number; request?: DiscoveryConfig;
}
export const historyLimit = 20;
const notePath = (value: unknown): value is string => typeof value === 'string' && value.endsWith('.md')
  && !/^(?:\/|[a-z]:)/i.test(value) && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part && !part.startsWith('.'));
export function readHistory(value: unknown): RunRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((record): record is RunRecord => Boolean(record && typeof record === 'object'
    && record.run && notePath(record.run.rootPath) && typeof record.run.search === 'string'
    && typeof record.run.folder === 'string' && !/^(?:\/|[a-z]:)/i.test(record.run.folder) && !/[\\\x00-\x1f]/.test(record.run.folder)
    && record.run.folder.split('/').every((part: string) => part && !part.startsWith('.'))
    && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.title === 'string' && Number.isSafeInteger(record.nodes) && record.nodes >= 0
    && Number.isSafeInteger(record.relations) && record.relations >= 0
    && record.run.nodePaths && typeof record.run.nodePaths === 'object' && !Array.isArray(record.run.nodePaths)
    && Object.values(record.run.nodePaths).every(notePath) && Object.values(record.run.nodePaths).includes(record.run.rootPath)))
    .slice(0, historyLimit).map(record => {
      let request = record.request;
      const oldTarget = request?.options?.maxBodyChars;
      if (Number.isInteger(oldTarget) && oldTarget! >= 80 && oldTarget! < 2000)
        request = {...request!, options:{...request!.options,maxBodyChars:2000}};
      return {...record, run: moveRun(record.run,new Map()), request: request && !validateDiscovery(request.seed,request.options).length ? cloneDiscoveryConfig(request) : undefined};
    });
}
export function rememberRun(history: RunRecord[], record: RunRecord): RunRecord[] {
  return [record, ...history.filter(item => item.run.folder !== record.run.folder)].slice(0, historyLimit);
}
export function moveRun(run: NativeRun, moved: Map<string, string>): NativeRun {
  const nodePaths = run.nodePaths ? Object.fromEntries(Object.entries(run.nodePaths).map(([id, path]) => [id, moved.get(path) ?? path])) : undefined;
  const integratedFolders = Array.isArray(run.integratedFolders) ? [...new Set(run.integratedFolders.filter(folder => typeof folder === 'string'
    && !/^(?:\/|[a-z]:)/i.test(folder) && !/[\\\x00-\x1f]/.test(folder) && folder.split('/').every(part => part && !part.startsWith('.'))))] : undefined;
  return { ...run, rootPath: moved.get(run.rootPath) ?? run.rootPath, ...(nodePaths ? {nodePaths, search: nativeSearch(Object.values(nodePaths))} : {}),
    ...(integratedFolders ? {integratedFolders} : {}) };
}
