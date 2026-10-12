import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundReader, type BackgroundInput, type BackgroundResult } from '../src/background';

const input = (name: string, ownerId = `concept-${name}`): BackgroundInput<string> =>
  ({ path: `Knowledge Seed/概念/${name}.md`, title: name, ownerId, data: `payload-${name}` });
const delay = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 1500;
  while (!predicate() && Date.now() < end) await delay(5);
  assert.ok(predicate(), label);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('opening the same concept debounces and deduplicates path plus owner without starting immediately', async () => {
  const starts: string[] = [];
  const reader = new BackgroundReader<string>({ debounceMs: 30, run: async job => { starts.push(job.data); return { state: 'ready' }; } });
  try {
    const first = reader.enqueue(input('A'))!;
    const repeated = reader.enqueue({ ...input('A'), data: 'latest' })!;
    assert.equal(first.id, repeated.id);
    assert.equal(reader.jobs.length, 1);
    assert.deepEqual(starts, []);
    await until(() => reader.jobs[0].state === 'ready', 'debounced concept eventually starts');
    assert.deepEqual(starts, ['latest']);
    assert.equal(reader.jobs[0].attempt, 1);
    const samePathNewOwner = reader.enqueue(input('A', 'concept-replaced'), { immediate: true })!;
    assert.notEqual(samePathNewOwner.id, first.id, 'ownership change must not deduplicate into the old owner');
    await until(() => reader.jobs[1].state === 'ready', 'new owner runs independently');
  } finally { reader.dispose(); }
});

test('one logical worker serializes successful tasks and exceptions do not stop the next task', async () => {
  const hold = deferred<BackgroundResult>();
  const starts: string[] = [];
  let concurrent = 0, highest = 0;
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: async job => {
    starts.push(job.title); highest = Math.max(highest, ++concurrent);
    try {
      if (job.title === 'A') return await hold.promise;
      if (job.title === 'B') throw new Error('HTTP 503 temporary');
      return { state: 'ready', auditFolder: 'Knowledge Seed/Runs/after-C' };
    } finally { concurrent--; }
  } });
  try {
    reader.enqueue(input('A')); reader.enqueue(input('B')); reader.enqueue(input('C'));
    await until(() => starts.length === 1, 'first task starts');
    assert.deepEqual(starts, ['A']);
    hold.resolve({ state: 'ready' });
    await until(() => reader.jobs.every(job => !['queued', 'reading'].includes(job.state)), 'queue settles after exception');
    assert.deepEqual(starts, ['A', 'B', 'C']);
    assert.equal(highest, 1);
    assert.equal(reader.jobs[1].state, 'failed');
    assert.match(reader.jobs[1].reason!, /503/);
    assert.equal(reader.jobs[2].auditFolder, 'Knowledge Seed/Runs/after-C');
  } finally { reader.dispose(); }
});

test('foreground/network gates retain queued work and only poll while there is pending work', async () => {
  let allowed = false, checks = 0, runs = 0;
  const reader = new BackgroundReader<string>({ debounceMs: 0, gatePollMs: 10,
    canRun: () => { checks++; return allowed; }, run: async () => { runs++; return { state: 'ready' }; } });
  try {
    await delay(25);
    assert.equal(checks, 0, 'idle queue must not call the gate or keep a poll timer');
    reader.enqueue(input('A'));
    await delay(25);
    assert.equal(runs, 0);
    assert.equal(reader.jobs[0].state, 'queued');
    assert.ok(checks > 0);
    allowed = true; reader.refreshGate();
    await until(() => reader.jobs[0].state === 'ready', 'gate reopening resumes queued task');
    const settledChecks = checks;
    await delay(30);
    assert.equal(checks, settledChecks, 'ready queue has no gate timer');
  } finally { reader.dispose(); }
});

test('closing a gate or pausing aborts active work and resume requeues without publishing its late result', async () => {
  let allowed = true;
  const first = deferred<BackgroundResult>();
  const signals: AbortSignal[] = [];
  const reader = new BackgroundReader<string>({ debounceMs: 0, gatePollMs: 10, canRun: () => allowed,
    run: async (_job, signal) => { signals.push(signal); return signals.length === 1 ? first.promise : { state: 'ready', reason: 'new attempt' }; } });
  try {
    const task = reader.enqueue(input('A'))!;
    await until(() => signals.length === 1, 'initial read begins');
    allowed = false; reader.refreshGate();
    assert.equal(signals[0].aborted, true);
    assert.equal(reader.jobs[0].state, 'queued');
    reader.pause();
    const checksBeforeResume = reader.jobs[0].attempt;
    allowed = true; reader.refreshGate();
    await delay(25);
    assert.equal(reader.jobs[0].attempt, checksBeforeResume);
    first.resolve({ state: 'ready', reason: 'obsolete response' });
    await delay(0);
    assert.equal(reader.jobs[0].state, 'queued');
    reader.resume();
    await until(() => reader.jobs[0].state === 'ready', 'resume runs a fresh attempt');
    assert.equal(reader.jobs[0].id, task.id);
    assert.equal(reader.jobs[0].attempt, 2);
    assert.equal(reader.jobs[0].reason, 'new attempt');
  } finally { reader.dispose(); }
});

test('cancellation releases an uncooperative request and neither late success nor rejection revives it', async () => {
  const first = deferred<BackgroundResult>(), second = deferred<BackgroundResult>();
  const signals = new Map<string, AbortSignal>();
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: async (job, signal) => {
    signals.set(job.title, signal);
    return job.title === 'A' ? first.promise : job.title === 'B' ? second.promise : { state: 'ready' };
  } });
  try {
    const a = reader.enqueue(input('A'))!, b = reader.enqueue(input('B'))!;
    reader.enqueue(input('C'));
    await until(() => signals.has('A'), 'A starts');
    assert.equal(reader.cancel(a.id), true);
    await until(() => signals.has('B'), 'B starts even if A ignores abort');
    assert.equal(reader.cancel(b.id), true);
    await until(() => reader.jobs[2].state === 'ready', 'C starts even if B ignores abort');
    assert.equal(signals.get('A')!.aborted, true);
    assert.equal(signals.get('B')!.aborted, true);
    first.resolve({ state: 'ready', reason: 'late A' }); second.reject(new Error('late B'));
    await delay(15);
    assert.deepEqual(reader.jobs.map(job => job.state), ['cancelled', 'cancelled', 'ready']);
    assert.equal(reader.cancel(a.id), false, 'terminal cancellation is idempotent');
  } finally { reader.dispose(); }
});

test('ready and no-match tasks are quiet on reopening, failures cool down and explicit retry bypasses cooldown', async () => {
  let now = 1000, runs = 0;
  const reader = new BackgroundReader<string>({ now: () => now, debounceMs: 0, failureCooldownMs: 300000,
    run: async job => { runs++; return { state: job.title === 'A' ? 'ready' : job.title === 'B' ? 'no_match' : 'failed' }; } });
  try {
    const a = reader.enqueue(input('A'))!, b = reader.enqueue(input('B'))!, c = reader.enqueue(input('C'))!;
    await until(() => reader.jobs.every(job => !['queued', 'reading'].includes(job.state)), 'initial results settle');
    now += 299999;
    reader.enqueue(input('A')); reader.enqueue(input('B')); reader.enqueue(input('C'));
    await delay(15);
    assert.equal(runs, 3);
    assert.equal(reader.retry(c.id), true);
    await until(() => runs === 4 && reader.jobs[2].state === 'failed', 'manual retry starts inside cooldown');
    now += 300000;
    reader.enqueue(input('C'), { immediate: true });
    await until(() => runs === 5 && reader.jobs[2].state === 'failed', 'failure can retry after cooldown');
    assert.equal(reader.jobs[2].attempt, 3);
    assert.equal(reader.retry(a.id), true);
    assert.equal(reader.retry(b.id), true);
    await until(() => runs === 7, 'explicit retry is also available for terminal results');
  } finally { reader.dispose(); }
});

test('queue bounds reject overflow without dropping active work, and bounded history evicts terminal jobs only', async () => {
  const reader = new BackgroundReader<string>({ canRun: () => false, maxQueued: 1000, maxHistory: 1000,
    run: async () => ({ state: 'ready' }) });
  try {
    const tasks = Array.from({ length: 24 }, (_unused, i) => reader.enqueue(input(String(i))));
    assert.equal(tasks.filter(Boolean).length, 24);
    assert.equal(reader.enqueue(input('overflow')), undefined, 'hard queued cap is 24 despite caller settings');
    assert.equal(reader.enqueue(input('0'))!.id, tasks[0]!.id);
    assert.equal(reader.jobs.length, 24);
    reader.cancelAll();
    for (let i = 0; i < 60; i++) {
      const job = reader.enqueue(input(`history-${i}`));
      assert.ok(job); reader.cancel(job.id);
    }
    assert.equal(reader.jobs.length, 50, 'hard history cap is 50 despite caller settings');
    assert.ok(reader.jobs.some(job => job.title === 'history-59'));
  } finally { reader.dispose(); }
  const tiny = new BackgroundReader<string>({ canRun: () => false, maxHistory: 2, run: async () => ({ state: 'ready' }) });
  try {
    const a = tiny.enqueue(input('A'))!, b = tiny.enqueue(input('B'))!;
    assert.equal(tiny.enqueue(input('C')), undefined);
    tiny.cancel(a.id);
    const c = tiny.enqueue(input('C'))!;
    assert.ok(c);
    assert.deepEqual(tiny.jobs.map(job => job.id), [b.id, c.id], 'queued B remains, terminal A can be evicted');
  } finally { tiny.dispose(); }
});

test('an opened concept takes one waiting automatic slot at the hard limit and displaced work can return later', () => {
  const displaced: string[] = [];
  const callbackStates: Array<{ count: number; openedPresent: boolean; refillAccepted: boolean }> = [];
  let reader!: BackgroundReader<string>;
  reader = new BackgroundReader<string>({ canRun: () => false, now: () => 1000,
    run: async () => ({ state: 'ready' }), onDisplaced: job => {
      displaced.push(job.title);
      callbackStates.push({ count: reader.jobs.length, openedPresent: reader.jobs.some(current => current.title === 'opened'),
        refillAccepted: Boolean(reader.enqueue(input('callback-refill'))) });
    } });
  try {
    for (let i = 0; i < 24; i++) reader.enqueue(input(`automatic-${i}`));
    assert.equal(reader.enqueue(input('automatic-overflow')), undefined);
    const opened = reader.enqueue(input('opened'), { priority: 'user' });
    assert.ok(opened); assert.equal(reader.jobs.length, 24);
    assert.equal(displaced.length, 1);
    assert.deepEqual(callbackStates, [{ count: 24, openedPresent: true, refillAccepted: false }],
      'the user occupies its slot before caller bookkeeping, so synchronous refill cannot steal it');
    assert.ok(!reader.jobs.some(job => job.title === displaced[0]));
    reader.cancel(opened.id);
    const returned = reader.enqueue(input(displaced[0]));
    assert.ok(returned, 'displacement clears the path/owner dedup key so discovery may retry later');
    assert.equal(returned.title, displaced[0]); assert.equal(returned.attempt, 0);
    assert.equal(reader.jobs.filter(job => ['queued', 'reading'].includes(job.state)).length, 24);
  } finally { reader.dispose(); }
});

test('user priority preserves the running request and other user tasks, then reads opened concepts ahead of automatic backlog', async () => {
  const hold = deferred<BackgroundResult>(), starts: string[] = [], displaced: string[] = [];
  let signal!: AbortSignal;
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: async (job, next) => {
    starts.push(job.title);
    if (job.title === 'running') { signal = next; return hold.promise; }
    return { state: 'ready' };
  }, onDisplaced: job => displaced.push(job.title) });
  try {
    const running = reader.enqueue(input('running'))!;
    await until(() => starts.length === 1, 'automatic source starts');
    for (let i = 0; i < 22; i++) reader.enqueue(input(`automatic-${i}`));
    const protectedUser = reader.enqueue(input('already-opened'), { priority: 'user' })!;
    const opened = reader.enqueue(input('newly-opened'), { priority: 'user' })!;
    assert.ok(opened); assert.equal(reader.jobs.filter(job => ['queued', 'reading'].includes(job.state)).length, 24);
    assert.equal(signal.aborted, false);
    assert.equal(reader.jobs.find(job => job.id === running.id)?.state, 'reading');
    assert.ok(reader.jobs.some(job => job.id === protectedUser.id));
    assert.equal(displaced.length, 1); assert.match(displaced[0], /^automatic-/);
    hold.resolve({ state: 'ready' });
    await until(() => reader.jobs.every(job => job.state === 'ready'), 'all admitted work completes');
    assert.deepEqual(new Set(starts.slice(1, 3)), new Set(['already-opened', 'newly-opened']));
    assert.equal(starts.length, 24);
  } finally { reader.dispose(); }
});

test('opening an already queued concept promotes the same task and automatic revisits preserve its user payload', async () => {
  let allowed = false;
  const starts: string[] = [], payloads: string[] = [], reader = new BackgroundReader<string>({ debounceMs: 60000,
    canRun: () => allowed, run: async job => { starts.push(job.title); payloads.push(job.data); return { state: 'ready' }; } });
  try {
    const automatic = reader.enqueue(input('backlog'), { immediate: true })!;
    const original = reader.enqueue(input('selected'))!;
    const promoted = reader.enqueue({ ...input('selected'), data: 'user-source' }, { priority: 'user' })!;
    assert.equal(promoted.id, original.id); assert.equal(reader.jobs.length, 2);
    reader.enqueue({ ...input('selected'), data: 'automatic-source' });
    allowed = true; reader.refreshGate();
    await until(() => reader.jobs.every(job => job.state === 'ready'), 'promoted task bypasses its old debounce');
    assert.deepEqual(starts, ['selected', 'backlog']);
    assert.deepEqual(payloads, ['user-source', automatic.data]);
    assert.equal(reader.jobs.find(job => job.id === original.id)?.attempt, 1);
  } finally { reader.dispose(); }
});

test('a full user queue refuses additional work without evicting any user request or pending active slot', async () => {
  let displacements = 0;
  const reader = new BackgroundReader<string>({ canRun: () => false, run: async () => ({ state: 'ready' }),
    onDisplaced: () => { displacements++; } });
  try {
    const before = Array.from({ length: 24 }, (_unused, i) => reader.enqueue(input(`user-${i}`), { priority: 'user' })!.id);
    assert.equal(reader.enqueue(input('user-overflow'), { priority: 'user', immediate: true }), undefined);
    assert.equal(reader.enqueue(input('automatic-overflow')), undefined);
    assert.deepEqual(reader.jobs.map(job => job.id), before);
    assert.equal(displacements, 0, 'there is no automatic task to displace');
  } finally { reader.dispose(); }
  const hold = deferred<BackgroundResult>();
  const tiny = new BackgroundReader<string>({ debounceMs: 0, maxQueued: 1, run: async () => hold.promise });
  try {
    tiny.enqueue(input('active'));
    await until(() => tiny.jobs[0]?.state === 'reading', 'single slot begins reading');
    tiny.pause();
    assert.equal(tiny.enqueue(input('opened-during-pause'), { priority: 'user' }), undefined,
      'an aborted runner still unwinding owns its slot until the worker releases it');
  } finally { tiny.dispose(); hold.resolve({ state: 'ready' }); }
});

test('user priority keeps cancelled and no-match reopening quiet while explicit retry can reclaim an automatic slot', async () => {
  const reader = new BackgroundReader<string>({ debounceMs: 0, maxQueued: 2, run: async job => ({ state: job.title === 'unmatched' ? 'no_match' : 'ready' }) });
  try {
    const unmatched = reader.enqueue(input('unmatched'))!;
    await until(() => reader.jobs[0].state === 'no_match', 'unmatched source settles');
    reader.pause();
    const cancelled = reader.enqueue(input('cancelled'))!; reader.cancel(cancelled.id);
    const first = reader.enqueue(input('automatic-first'))!, second = reader.enqueue(input('automatic-second'))!;
    assert.equal(reader.enqueue(input('unmatched'), { priority: 'user' })!.state, 'no_match');
    assert.equal(reader.enqueue(input('cancelled'), { priority: 'user' })!.state, 'cancelled');
    assert.ok(reader.jobs.some(job => job.id === first.id) && reader.jobs.some(job => job.id === second.id));
    assert.equal(reader.retry(unmatched.id, { ...input('unmatched'), data: 'fresh' }), true);
    assert.equal(reader.jobs.find(job => job.id === unmatched.id)?.state, 'queued');
    assert.equal(reader.jobs.filter(job => ['queued', 'reading'].includes(job.state)).length, 2);
    assert.equal(reader.jobs.find(job => job.id === cancelled.id)?.state, 'cancelled');
  } finally { reader.dispose(); }
});

test('retrying terminal history cannot displace a full user queue or silently alter its terminal state', async () => {
  const reader = new BackgroundReader<string>({ debounceMs: 0, maxQueued: 2,
    run: async () => ({ state: 'no_match' }) });
  try {
    const terminal = reader.enqueue(input('unmatched'))!;
    await until(() => reader.jobs[0].state === 'no_match', 'terminal search completes');
    reader.pause();
    reader.enqueue(input('user-one'), { priority: 'user' }); reader.enqueue(input('user-two'), { priority: 'user' });
    const before = reader.jobs;
    assert.equal(reader.retry(terminal.id, { ...input('unmatched'), data: 'new-manual-payload' }), false);
    assert.deepEqual(reader.jobs, before);
    assert.equal(reader.jobs.find(job => job.id === terminal.id)?.state, 'no_match');
  } finally { reader.dispose(); }
});

test('small history bounds still admit user priority by displacing only automatic waiting work, and callback errors are isolated', () => {
  const reader = new BackgroundReader<string>({ maxHistory: 2, canRun: () => false, run: async () => ({ state: 'ready' }),
    onDisplaced: () => { throw new Error('caller bookkeeping failed'); } });
  try {
    reader.enqueue(input('automatic-one')); reader.enqueue(input('automatic-two'));
    assert.equal(reader.enqueue(input('automatic-overflow')), undefined);
    assert.ok(reader.enqueue(input('opened'), { priority: 'user' }));
    assert.equal(reader.jobs.length, 2);
    assert.ok(reader.jobs.some(job => job.title === 'opened'));
  } finally { reader.dispose(); }
});

test('history restoration validates metadata, ignores untrusted payloads, and never silently sends restored tasks', async () => {
  let runs = 0;
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: async job => { runs++; assert.equal(job.data, 'rebuilt'); return { state: 'ready' }; } });
  try {
    const base = { ...input('A'), id: 'old-task', state: 'reading', created: 1, updated: 2, attempt: 1 };
    const rejected = [
      { ...base, id: 'wrong-state', state: 'invented' },
      { ...base, id: 'title-too-long', title: 'x'.repeat(513) },
      { ...base, id: 'bad-path', path: 'a\n.md' },
      { ...base, id: 'bad-time', updated: Infinity },
      { ...base, id: 'bad-attempt', attempt: -1 },
      { ...base, id: 'bad-reason', reason: 'x'.repeat(2001) },
      { ...base, id: 'bad-audit', auditFolder: 'Runs/x\ny' },
      { ...base, id: 'bad-owner', ownerId: ['concept-A'] },
    ];
    assert.equal(reader.restoreHistory([base, ...rejected]), 1);
    assert.equal(reader.jobs[0].state, 'interrupted');
    assert.equal(reader.jobs[0].data, undefined);
    assert.equal(reader.exportHistory()[0].id, base.id);
    assert.equal('data' in reader.exportHistory()[0], false);
    assert.equal(reader.retry(base.id), false, 'imported data must not become runnable');
    assert.equal(reader.retry(base.id, { ...input('A'), ownerId: 'other', data: 'rebuilt' }), false);
    await delay(20);
    assert.equal(runs, 0);
    assert.equal(reader.retry(base.id, { ...input('A'), data: 'rebuilt' }), true);
    await until(() => reader.jobs[0].state === 'ready', 'caller-rebuilt input can run');
    assert.equal(reader.jobs[0].attempt, 2);
  } finally { reader.dispose(); }
});

test('reopening an interrupted historical task can safely reconstruct eligibility through enqueue', async () => {
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: async job => {
    assert.equal(job.data, 'fresh'); return { state: 'ready' };
  } });
  try {
    reader.restoreHistory([{ ...input('A'), id: 'restored', state: 'queued', created: 1, updated: 1, attempt: 0 }]);
    assert.equal(reader.enqueue({ ...input('A'), data: 'fresh' }, { immediate: true })!.id, 'restored');
    await until(() => reader.jobs[0].state === 'ready', 'fresh caller input activates interrupted task');
  } finally { reader.dispose(); }
});

test('subscriptions are isolated and disposal aborts work, clears timers and rejects further operations', async () => {
  const hold = deferred<BackgroundResult>();
  let signal: AbortSignal | undefined, calls = 0, gateChecks = 0;
  const reader = new BackgroundReader<string>({ debounceMs: 0, gatePollMs: 10, canRun: () => { gateChecks++; return true; },
    run: async (_job, next) => { signal = next; return hold.promise; } });
  const off = reader.subscribe(() => { calls++; });
  reader.subscribe(() => { throw new Error('broken view'); });
  const task = reader.enqueue(input('A'))!;
  await until(() => Boolean(signal), 'active task starts despite a broken status subscriber');
  reader.enqueue(input('B'));
  off();
  const callsAfterOff = calls;
  reader.dispose(); reader.dispose();
  assert.equal(signal!.aborted, true);
  assert.deepEqual(reader.jobs.map(job => job.state), ['cancelled', 'cancelled']);
  const checksAfterDispose = gateChecks;
  hold.resolve({ state: 'ready' });
  await delay(25);
  assert.equal(gateChecks, checksAfterDispose);
  assert.equal(calls, callsAfterOff);
  assert.equal(reader.enqueue(input('C')), undefined);
  assert.equal(reader.retry(task.id), false);
  assert.equal(reader.restoreHistory([]), 0);
});

test('invalid runner state and synchronous throw become failed rather than an unhandled queue rejection', async () => {
  const reader = new BackgroundReader<string>({ debounceMs: 0, run: job => {
    if (job.title === 'A') throw new Error('synchronous failure');
    return Promise.resolve({ state: 'reading' } as unknown as BackgroundResult);
  } });
  try {
    reader.enqueue(input('A')); reader.enqueue(input('B'));
    await until(() => reader.jobs.every(job => job.state === 'failed'), 'invalid runners fail closed');
    assert.match(reader.jobs[0].reason!, /synchronous/);
    assert.match(reader.jobs[1].reason!, /无效结果/);
  } finally { reader.dispose(); }
});

test('bad enqueue inputs are rejected before any network job or history item is constructed', () => {
  const reader = new BackgroundReader<string>({ run: async () => ({ state: 'ready' }) });
  try {
    for (const bad of [{ ...input('A'), path: '' }, { ...input('A'), ownerId: '' },
      { ...input('A'), title: 'x'.repeat(513) }, { ...input('A'), path: 'bad\u0000.md' }])
      assert.equal(reader.enqueue(bad), undefined);
    assert.equal(reader.jobs.length, 0);
  } finally { reader.dispose(); }
});
