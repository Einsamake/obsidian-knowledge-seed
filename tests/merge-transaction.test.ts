import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMergeTransaction, MergeTransactionError, type MergeWriter } from '../src/merge-transaction';

type Operation = 'mkdir' | 'create' | 'process' | 'trash' | 'journal';
function memoryWriter() {
  const files = new Map<string, string>([['Keep.md', '详细正文\r\n手工内容 😀'], ['A.md', '概念 A\r\n证据'], ['B.md', '概念 B\n证据'], ['Root.md', '[[A]] [[B]]']]);
  const directories = new Set<string>(), created = new Set<string>(), events: Array<{ operation: Operation; path: string }> = [];
  const journals: Array<Record<string, unknown>> = [], trashed: Array<{ path: string; content: string; retainedPath?: string }> = [];
  let hook: ((operation: Operation, path: string) => void) | undefined;
  const step = (operation: Operation, path: string) => { events.push({ operation, path }); hook?.(operation, path); };
  const writer: MergeWriter = {
    async exists(path) { return files.has(path) || directories.has(path); },
    async mkdir(path) { step('mkdir', path); if (files.has(path) || directories.has(path)) throw new Error('directory occupied'); directories.add(path); },
    async create(path, content) { step('create', path); if (files.has(path) || directories.has(path)) throw new Error('file occupied'); files.set(path, content); created.add(path); if (path.endsWith('/journal.json')) journals.push(JSON.parse(content)); },
    async process(path, before, after) { step('process', path); if (files.get(path) !== before) throw new Error('concurrent note edit'); files.set(path, after); },
    async trash(path, expectedContent, retainedPath) { step('trash', path); if (files.get(path) !== expectedContent) throw new Error('concurrent source edit'); if (retainedPath) { if (files.has(retainedPath) || directories.has(retainedPath)) throw new Error('retained path occupied'); files.set(retainedPath, files.get(path)!); } trashed.push({ path, content: expectedContent, retainedPath }); files.delete(path); },
    async journal(path, content) { step('journal', path); if (!created.has(path) || !path.endsWith('/journal.json')) throw new Error('not our journal'); files.set(path, content); journals.push(JSON.parse(content)); },
  };
  return { writer, files, directories, events, journals, trashed, setHook(value: typeof hook) { hook = value; } };
}
const folder = 'Knowledge Seed/合并备份/Run-1';
function plan(state: ReturnType<typeof memoryWriter>) {
  return {
    edits: [{ path: 'Keep.md', before: state.files.get('Keep.md')!, after: '详细正文\r\n手工内容 😀\r\n合并证据' }, { path: 'Root.md', before: state.files.get('Root.md')!, after: '[[Keep]] [[Keep]]' }],
    archives: [{ path: 'A.md', content: state.files.get('A.md')!, to: 'Keep.md' }, { path: 'B.md', content: state.files.get('B.md')!, to: 'Keep.md' }],
  };
}
async function reject(state: ReturnType<typeof memoryWriter>, edits = plan(state).edits, archives = plan(state).archives, destination = folder) {
  try { await executeMergeTransaction(destination, edits, archives, state.writer); assert.fail('expected failure'); }
  catch (error) { assert.ok(error instanceof MergeTransactionError); return error; }
}

test('merge backs up every exact UTF-8 string and writing journal before edits, then trashes only after all edits', async () => {
  const state = memoryWriter(), input = plan(state);
  const result = await executeMergeTransaction(folder, input.edits, input.archives, state.writer);
  assert.deepEqual(result, { folder, completed: [{ from: 'A.md', to: 'Keep.md' }, { from: 'B.md', to: 'Keep.md' }] });
  for (const [index, original] of [...input.edits.map(item => item.before), ...input.archives.map(item => item.content)].entries()) assert.equal(state.files.get(`${folder}/${index + 1}.bak`), original);
  const firstEdit = state.events.findIndex(item => item.operation === 'process');
  assert.deepEqual(state.events.slice(0, firstEdit).filter(item => item.operation === 'create').map(item => item.path), [1, 2, 3, 4].map(number => `${folder}/${number}.bak`).concat(`${folder}/journal.json`));
  assert.ok(state.events.filter(item => item.operation === 'process').every(item => state.events.indexOf(item) < state.events.findIndex(event => event.operation === 'trash')));
  assert.deepEqual([...state.directories], ['Knowledge Seed', 'Knowledge Seed/合并备份', folder]);
  assert.equal(state.journals[0].status, 'writing');
  assert.deepEqual(state.journals[0].backups, [{ path: 'Keep.md', backup: '1.bak', kind: 'edit' }, { path: 'Root.md', backup: '2.bak', kind: 'edit' }, { path: 'A.md', backup: '3.bak', kind: 'archive', to: 'Keep.md', retained: 'source-3.bak' }, { path: 'B.md', backup: '4.bak', kind: 'archive', to: 'Keep.md', retained: 'source-4.bak' }]);
  assert.equal(state.journals.at(-1)!.status, 'complete');
  assert.deepEqual(state.journals.at(-1)!.applied, ['Keep.md', 'Root.md']);
  assert.deepEqual(state.journals.at(-1)!.completed, result.completed);
  assert.equal(state.files.get('Keep.md'), input.edits[0].after);
  assert.equal(state.files.has('A.md'), false);
  assert.ok([...state.files.keys()].filter(path => path.startsWith(folder)).every(path => !path.endsWith('.md')));
});

test('archive writer receives distinct retained .bak paths alongside the original text backups', async () => {
  const state = memoryWriter(), input = plan(state);
  await executeMergeTransaction(folder, input.edits, input.archives, state.writer);
  assert.deepEqual(state.trashed.map(item => item.retainedPath), [`${folder}/source-3.bak`, `${folder}/source-4.bak`]);
  assert.equal(new Set(state.trashed.map(item => item.retainedPath)).size, 2);
  for (const [index, archive] of input.archives.entries()) {
    const retainedPath = state.trashed[index].retainedPath!;
    assert.ok(retainedPath.startsWith(`${folder}/`)); assert.ok(retainedPath.endsWith('.bak'));
    assert.notEqual(retainedPath, `${folder}/${index + 3}.bak`);
    assert.equal(state.files.get(retainedPath), archive.content);
    assert.equal(state.files.get(`${folder}/${index + 3}.bak`), archive.content);
  }
});

test('an edit failure preserves all sources and records only successful edits', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'process' && path === 'Root.md') throw new Error('edit unavailable'); });
  const error = await reject(state);
  assert.deepEqual(error.completed, []); assert.equal(error.folder, folder);
  assert.equal(state.files.has('A.md'), true); assert.equal(state.files.has('B.md'), true);
  assert.equal(state.trashed.length, 0);
  assert.deepEqual(state.journals.at(-1)!.applied, ['Keep.md']);
  assert.equal(state.journals.at(-1)!.status, 'partial');
  assert.equal(state.journals.at(-1)!.error, 'edit unavailable');
});

test('a partial trash failure reports exactly the already completed source mapping', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'trash' && path === 'B.md') throw new Error('trash unavailable'); });
  const error = await reject(state);
  assert.deepEqual(error.completed, [{ from: 'A.md', to: 'Keep.md' }]);
  assert.deepEqual(state.journals.at(-1)!.completed, error.completed);
  assert.equal(state.files.has('A.md'), false); assert.equal(state.files.has('B.md'), true);
  assert.equal(state.files.get(`${folder}/3.bak`), '概念 A\r\n证据');
});

test('process compares the exact original text and refuses a concurrent keeper edit', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'process' && path === 'Keep.md') state.files.set(path, '刚刚手工修改'); });
  const error = await reject(state);
  assert.match(error.message, /concurrent note edit/);
  assert.equal(state.files.get('Keep.md'), '刚刚手工修改');
  assert.equal(state.trashed.length, 0); assert.deepEqual(state.journals.at(-1)!.applied, []);
});

test('trash compares the exact source and keeps a concurrently edited duplicate', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'trash' && path === 'A.md') state.files.set(path, '保留我的新内容'); });
  const error = await reject(state);
  assert.match(error.message, /concurrent source edit/);
  assert.equal(state.files.get('A.md'), '保留我的新内容'); assert.equal(state.files.has('B.md'), true);
  assert.deepEqual(error.completed, []);
});

test('backup failure prevents every note mutation and attempts a partial journal', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'create' && path.endsWith('/3.bak')) throw new Error('backup failed'); });
  const error = await reject(state);
  assert.match(error.message, /backup failed/);
  assert.ok(state.events.every(item => item.operation !== 'process' && item.operation !== 'trash'));
  assert.equal(state.journals.at(-1)!.status, 'partial');
  assert.equal((state.journals.at(-1)!.backups as unknown[]).length, 2);
});

test('initial journal failure prevents every note mutation and never updates an unowned journal', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'create' && path.endsWith('/journal.json')) { state.files.set(path, 'another transaction'); throw new Error('journal collision'); } });
  const error = await reject(state);
  assert.match(error.message, /journal collision/);
  assert.equal(state.files.get(`${folder}/journal.json`), 'another transaction');
  assert.ok(state.events.every(item => !['process', 'trash', 'journal'].includes(item.operation)));
});

test('a journal update failure stops before the next edit and preserves its original cause if partial logging also fails', async () => {
  const state = memoryWriter(), originalError = new Error('disk full'); state.setHook(operation => { if (operation === 'journal') throw originalError; });
  const error = await reject(state);
  assert.equal(error.cause, originalError);
  assert.deepEqual(error.completed, []);
  assert.equal(state.events.filter(item => item.operation === 'process').length, 1);
  assert.equal(state.trashed.length, 0);
  assert.equal(state.files.get(`${folder}/1.bak`), '详细正文\r\n手工内容 😀');
});

test('journal failure after trash still reports that source as completed and stops further trashing', async () => {
  const state = memoryWriter(); let failed = false;
  state.setHook(operation => { if (operation === 'journal' && state.trashed.length === 1 && !failed) { failed = true; throw new Error('journal temporary failure'); } });
  const error = await reject(state);
  assert.deepEqual(error.completed, [{ from: 'A.md', to: 'Keep.md' }]);
  assert.equal(state.files.has('B.md'), true);
  assert.equal(state.journals.at(-1)!.status, 'partial');
  assert.deepEqual(state.journals.at(-1)!.completed, error.completed);
});

test('final journal failure reports all completed archives and retries only partial logging', async () => {
  const state = memoryWriter(); let journalUpdates = 0;
  state.setHook(operation => { if (operation === 'journal' && ++journalUpdates === 5) throw new Error('final journal failed'); });
  const error = await reject(state);
  assert.equal(error.completed.length, 2);
  assert.equal(state.trashed.length, 2); assert.equal(state.journals.at(-1)!.status, 'partial');
  assert.equal(state.journals.at(-1)!.error, 'final journal failed');
});

test('unsafe backup folders and note paths fail without creating or modifying files', async () => {
  for (const destination of ['../backups', '/backups', 'C:/backups', '.obsidian/backups', 'a//b', 'a/../b']) {
    const state = memoryWriter(); await reject(state, undefined, undefined, destination); assert.equal(state.events.length, 0);
  }
  for (const path of ['../A.md', '/A.md', 'C:/A.md', 'dir\\A.md', 'a//A.md', '.obsidian/A.md', 'a/../A.md', 'A.txt', 'a\u0000.md']) {
    const state = memoryWriter(), input = plan(state);
    await reject(state, [{ ...input.edits[0], path }], input.archives);
    assert.equal(state.events.length, 0);
    await reject(state, input.edits, [{ ...input.archives[0], to: path }]);
    assert.equal(state.events.length, 0);
  }
});

test('duplicate paths are rejected case-insensitively before backup creation', async () => {
  const state = memoryWriter(), input = plan(state);
  await reject(state, [input.edits[0], { ...input.edits[0], path: 'keep.md' }], input.archives);
  await reject(state, input.edits, [input.archives[0], { ...input.archives[0], path: 'a.md' }]);
  assert.equal(state.events.length, 0);
});

test('archived sources cannot also be edited or used as a keeper including chains and self-merges', async () => {
  for (const to of ['A.md', 'B.md', 'a.md']) {
    const state = memoryWriter(), input = plan(state);
    await reject(state, input.edits, [{ ...input.archives[0], to }, input.archives[1]]); assert.equal(state.events.length, 0);
  }
  const state = memoryWriter(), input = plan(state);
  await reject(state, [...input.edits, { path: 'A.md', before: 'before', after: 'after' }], input.archives);
  assert.equal(state.events.length, 0);
});

test('missing source or keeper and empty archived text fail before backup creation', async () => {
  for (const missing of ['Keep.md', 'A.md', 'Root.md']) {
    const state = memoryWriter(), input = plan(state); state.files.delete(missing);
    await reject(state, input.edits, input.archives); assert.equal(state.events.length, 0);
  }
  const state = memoryWriter(), input = plan(state);
  await reject(state, input.edits, [{ ...input.archives[0], content: '' }]); assert.equal(state.events.length, 0);
});

test('existing backup folders are never reused or modified', async () => {
  const state = memoryWriter(); state.directories.add(folder); state.files.set(`${folder}/journal.json`, 'original journal');
  await reject(state);
  assert.equal(state.events.length, 0); assert.equal(state.files.get(`${folder}/journal.json`), 'original journal');
});

test('a concurrently occupied backup filename is not overwritten', async () => {
  const state = memoryWriter(); state.setHook((operation, path) => { if (operation === 'create' && path.endsWith('/1.bak')) state.files.set(path, 'occupied backup'); });
  await reject(state);
  assert.equal(state.files.get(`${folder}/1.bak`), 'occupied backup');
  assert.ok(state.events.every(item => item.operation !== 'process' && item.operation !== 'trash'));
});

test('pre-existing parents are retained and only missing backup directories are created', async () => {
  const state = memoryWriter(), input = plan(state); state.directories.add('Knowledge Seed');
  await executeMergeTransaction(folder, input.edits, input.archives, state.writer);
  assert.deepEqual(state.events.filter(item => item.operation === 'mkdir').map(item => item.path), ['Knowledge Seed/合并备份', folder]);
});

test('UI changes to the supplied plan during storage do not change the accepted transaction', async () => {
  const state = memoryWriter(), input = plan(state), originalAfter = input.edits[0].after;
  state.setHook(operation => {
    if (operation === 'mkdir') {
      input.edits[0].after = 'later UI state'; input.archives[0].content = 'later source state';
      input.archives[0].to = 'Root.md';
    }
  });
  const result = await executeMergeTransaction(folder, input.edits, input.archives, state.writer);
  assert.equal(state.files.get('Keep.md'), originalAfter);
  assert.equal(state.files.get(`${folder}/3.bak`), '概念 A\r\n证据');
  assert.deepEqual(result.completed[0], { from: 'A.md', to: 'Keep.md' });
});
