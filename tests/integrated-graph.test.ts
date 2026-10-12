import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSearch } from '../src/export';
import { stableId } from '../src/graph';
import type { NativeRun } from '../src/history';
import { integrateNativeRuns } from '../src/integrated-graph';

const run = (name: string, nodePaths: Record<string, string>, rootPath = Object.values(nodePaths)[0], graphDepth = 3): NativeRun => ({
  folder: `Maps/Runs/${name}`, rootPath, nodePaths, search: nativeSearch(Object.values(nodePaths)), graphDepth,
});
const exists = (...runs: NativeRun[]) => new Set(runs.flatMap(item => [item.rootPath, ...Object.values(item.nodePaths ?? {})]));
const paths = (value: NativeRun) => [...new Set(Object.values(value.nodePaths ?? {}))].sort();
const scope = (value: NativeRun) => new RegExp(value.search.slice('path:/'.length, -1));

test('shared real files integrate a transitive A-B-C component while keeping the current root and folder', () => {
  const current = run('A', { root: 'Maps/A.md', bridge: 'Notes/shared-B.md' }, 'Maps/A.md', 2);
  const earlierB = run('B', { root: 'Maps/B.md', shared: 'Notes/shared-B.md', bridge: 'Notes/shared-C.md' });
  const earlierC = run('C', { root: 'Maps/C.md', shared: 'Notes/shared-C.md' });
  const isolated = run('isolated', { root: 'Elsewhere/unrelated.md' });
  const original = structuredClone([current, earlierB, earlierC, isolated]);
  // C comes first to require propagation rather than a single intersection pass.
  const integrated = integrateNativeRuns(current, [earlierC, isolated, earlierB], exists(current, earlierB, earlierC, isolated));
  assert.deepEqual(paths(integrated), ['Maps/A.md', 'Maps/B.md', 'Maps/C.md', 'Notes/shared-B.md', 'Notes/shared-C.md']);
  assert.equal(integrated.rootPath, current.rootPath); assert.equal(integrated.folder, current.folder);
  assert.equal(integrated.graphDepth, 2);
  assert.deepEqual(integrated.integratedFolders, ['Maps/Runs/A', 'Maps/Runs/B', 'Maps/Runs/C']);
  assert.deepEqual([current, earlierB, earlierC, isolated], original, 'integration must not mutate run audit metadata');
});

test('equal labels and repeated identities at different paths do not connect separate explorations', () => {
  const current = run('current', { 'same-id': 'Maps/current/主成分分析.md' });
  const homonym = run('other', { 'same-id': 'Maps/other/主成分分析.md' });
  const integrated = integrateNativeRuns(current, [homonym], exists(current, homonym));
  assert.deepEqual(integrated.nodePaths, current.nodePaths);
  assert.deepEqual(integrated.integratedFolders, [current.folder]);
});

test('missing or excluded paths cannot bridge components and do not remain in the exact native scope', () => {
  const current = run('current', { root: 'Maps/current.md', live: 'Notes/live (2).md', missing: 'Notes/missing.md' });
  const connected = run('connected', { root: 'Maps/connected.md', shared: 'Notes/live (2).md', deleted: 'Notes/deleted.md' });
  const disconnected = run('disconnected', { root: 'Maps/disconnected.md', shared: 'Notes/missing.md' });
  const existing = new Set(['Maps/current.md', 'Notes/live (2).md', 'Maps/connected.md', 'Maps/disconnected.md']);
  const integrated = integrateNativeRuns(current, [connected, disconnected], existing);
  assert.deepEqual(paths(integrated), ['Maps/connected.md', 'Maps/current.md', 'Notes/live (2).md']);
  const filter = scope(integrated);
  for (const path of paths(integrated)) assert.ok(filter.test(path), path);
  for (const path of ['Notes/missing.md', 'Notes/deleted.md', 'Maps/disconnected.md', 'Notes/live x2x.md', 'Prefix/Maps/current.md'])
    assert.equal(filter.test(path), false, path);
});

test('current identity wins collisions and every different historical path receives a stable namespace', () => {
  const current = run('current', { shared: 'Notes/common.md', root: 'Maps/current.md', repeated: 'Maps/current-detail.md' }, 'Maps/current.md');
  const earlierB = run('B', { shared: 'Notes/common.md', root: 'Maps/B.md', repeated: 'Maps/B-detail.md' });
  const earlierC = run('C', { shared: 'Notes/common.md', root: 'Maps/C.md', repeated: 'Maps/C-detail.md' });
  const existing = exists(current, earlierB, earlierC);
  const first = integrateNativeRuns(current, [earlierC, earlierB], existing);
  const second = integrateNativeRuns(current, [earlierB, earlierC], existing);
  assert.equal(first.nodePaths!.root, 'Maps/current.md');
  assert.equal(first.nodePaths!.repeated, 'Maps/current-detail.md');
  assert.equal(first.nodePaths![`integrated-${stableId('root|Maps/B.md')}`], 'Maps/B.md');
  assert.equal(first.nodePaths![`integrated-${stableId('root|Maps/C.md')}`], 'Maps/C.md');
  assert.deepEqual(paths(first), [...existing].sort());
  assert.deepEqual(first, second, 'the union and collision keys must be independent of history order');
});

test('a namespace colliding with an existing current identity still preserves both files', () => {
  const reserved = `integrated-${stableId('root|Maps/old.md')}`;
  const current = run('current', { root: 'Maps/current.md', shared: 'Notes/common.md', [reserved]: 'Notes/reserved.md' });
  const previous = run('old', { root: 'Maps/old.md', shared: 'Notes/common.md' });
  const integrated = integrateNativeRuns(current, [previous], exists(current, previous));
  assert.equal(integrated.nodePaths![reserved], 'Notes/reserved.md');
  assert.equal(integrated.nodePaths![`${reserved}-2`], 'Maps/old.md');
  assert.deepEqual(paths(integrated), [...exists(current, previous)].sort());
});

test('an already integrated run contributes its union, retains provenance, and does not grow on repeated integration', () => {
  const earlierA = run('A', { root: 'Maps/A.md', shared: 'Notes/shared.md' });
  const earlierB = run('B', { root: 'Maps/B.md', shared: 'Notes/shared.md' });
  const existingAB = exists(earlierA, earlierB);
  const previousUnion = integrateNativeRuns(earlierA, [earlierB], existingAB);
  const current = run('new', { root: 'Maps/new.md', shared: 'Maps/B.md' });
  const existing = new Set([...existingAB, current.rootPath]);
  const first = integrateNativeRuns(current, [previousUnion, earlierB], existing);
  const second = integrateNativeRuns(first, [previousUnion, earlierA, earlierB], existing);
  assert.deepEqual(second, first);
  assert.deepEqual(paths(first), [...existing].sort());
  assert.deepEqual(first.integratedFolders, ['Maps/Runs/A', 'Maps/Runs/B', 'Maps/Runs/new']);
});

test('legacy roots missing from nodePaths are retained while invalid paths and folders cannot enter the union', () => {
  const current: NativeRun = { folder: 'Maps/Runs/current', rootPath: 'Maps/current.md', search: '' };
  const previous = run('old', { shared: 'Maps/current.md', bad: '../secret.md', absolute: 'C:/secret.md', hidden: '.obsidian/secret.md' }, 'Maps/old.md');
  const malformed = { ...run('bad', { root: 'Maps/current.md', other: 'Maps/untrusted.md' }), folder: '../Runs/bad' };
  const integrated = integrateNativeRuns(current, [previous, malformed], new Set(['Maps/current.md', 'Maps/old.md', '../secret.md', 'C:/secret.md', '.obsidian/secret.md', 'Maps/untrusted.md']));
  assert.deepEqual(paths(integrated), ['Maps/current.md', 'Maps/old.md']);
  assert.equal(integrated.rootPath, current.rootPath);
  assert.equal(integrated.graphDepth, undefined);
  assert.throws(() => integrateNativeRuns(current, [], new Set()), /起点笔记不存在/);
  const reservedRoot = `root-${stableId(current.rootPath)}`;
  const withCollision = { ...current, nodePaths: { [reservedRoot]: 'Notes/reserved-root-key.md' } };
  const collisionResult = integrateNativeRuns(withCollision, [], new Set([current.rootPath, 'Notes/reserved-root-key.md']));
  assert.equal(collisionResult.nodePaths![reservedRoot], 'Notes/reserved-root-key.md');
  assert.equal(collisionResult.nodePaths![`${reservedRoot}-2`], current.rootPath);
});

test('current display depth remains independent from the expanded component and never exceeds five', () => {
  const previous = run('old', { root: 'Maps/current.md', old: 'Maps/old.md' }, 'Maps/current.md', 5);
  for (const [provided, expected] of [[0, 0], [2, 2], [5, 5], [20, 5], [-1, 0], [Number.NaN, 3]]) {
    const current = run('current', { root: 'Maps/current.md' }, 'Maps/current.md', provided);
    const integrated = integrateNativeRuns(current, [previous], exists(current, previous));
    assert.equal(integrated.graphDepth, expected);
    assert.equal(integrated.folder, current.folder);
  }
});
