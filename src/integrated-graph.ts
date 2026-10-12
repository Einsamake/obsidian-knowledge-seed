import { nativeSearch } from './export';
import { stableId } from './graph';
import type { NativeRun } from './history';

/** A current native view plus the completed explorations whose real files overlap it. */
export type IntegratedNativeRun = NativeRun & { integratedFolders: string[] };

const safePath = (value: unknown, markdown: boolean): value is string => typeof value === 'string' && Boolean(value)
  && (!markdown || value.endsWith('.md')) && !/^(?:\/|[a-z]:)/i.test(value) && !/[\\\x00-\x1f]/.test(value)
  && value.split('/').every(part => Boolean(part) && !part.startsWith('.'));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function liveEntries(run: NativeRun, existingPaths: ReadonlySet<string>): Array<[string, string]> {
  const entries = Object.entries(run.nodePaths ?? {})
    .filter((entry): entry is [string, string] => safePath(entry[1], true) && existingPaths.has(entry[1]));
  if (safePath(run.rootPath, true) && existingPaths.has(run.rootPath) && !entries.some(([, path]) => path === run.rootPath)) {
    const namespace = `root-${stableId(run.rootPath)}`;
    let key = namespace, collision = 2;
    while (entries.some(([id]) => id === key)) key = `${namespace}-${collision++}`;
    entries.push([key, run.rootPath]);
  }
  return entries;
}

/**
 * Expand only the current view's connected component, using exact live vault paths.
 * The caller passes completed runs and its permitted, currently existing file set;
 * this module neither reads files nor modifies any single-run graph or content.
 */
export function integrateNativeRuns(current: NativeRun, completedPast: readonly NativeRun[], existingPaths: ReadonlySet<string>): IntegratedNativeRun {
  if (!safePath(current.rootPath, true) || !existingPaths.has(current.rootPath))
    throw new Error('当前起点笔记不存在或不在可显示范围内，无法整合原生图谱。');
  if (!safePath(current.folder, false)) throw new Error('当前探索目录无效，无法整合原生图谱。');
  const currentEntries = liveEntries(current, existingPaths);
  const connectedPaths = new Set(currentEntries.map(([, path]) => path));
  const candidates = completedPast.filter(run => run.folder !== current.folder && safePath(run.folder, false))
    .map(run => ({ run, entries: liveEntries(run, existingPaths) }))
    .filter(item => item.entries.length > 0)
    .sort((a, b) => compare(a.run.folder, b.run.folder));
  const selected = new Set<typeof candidates[number]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (selected.has(candidate) || !candidate.entries.some(([, path]) => connectedPaths.has(path))) continue;
      selected.add(candidate);
      for (const [, path] of candidate.entries) connectedPaths.add(path);
      changed = true;
    }
  }

  // Current identities take precedence. Historical identity collisions receive
  // stable keys; historical aliases for an already represented file add no nodes.
  const pathsById = new Map<string, string>(currentEntries);
  const represented = new Set(pathsById.values());
  for (const candidate of selected) {
    const ordered = [...candidate.entries].sort((a, b) => compare(a[1], b[1]) || compare(a[0], b[0]));
    for (const [id, path] of ordered) {
      if (represented.has(path)) continue;
      let key = id;
      if (pathsById.has(key)) {
        const namespace = `integrated-${stableId(`${id}|${path}`)}`;
        key = namespace;
        let collision = 2;
        while (pathsById.has(key)) key = `${namespace}-${collision++}`;
      }
      pathsById.set(key, path); represented.add(path);
    }
  }

  const folders = new Set<string>();
  for (const run of [current, ...[...selected].map(item => item.run)]) {
    folders.add(run.folder);
    const prior = (run as NativeRun & { integratedFolders?: unknown }).integratedFolders;
    if (Array.isArray(prior)) for (const folder of prior) if (safePath(folder, false)) folders.add(folder);
  }
  const nodePaths = Object.fromEntries(pathsById);
  const graphDepth = current.graphDepth === undefined ? undefined
    : Number.isFinite(current.graphDepth) ? Math.max(0, Math.min(5, Math.floor(current.graphDepth))) : 3;
  return { ...current, rootPath: current.rootPath, folder: current.folder, nodePaths,
    search: nativeSearch([...new Set(Object.values(nodePaths))].sort(compare)),
    ...(graphDepth === undefined ? {} : { graphDepth }), integratedFolders: [...folders].sort(compare) };
}
