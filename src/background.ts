/** One logical worker for user-triggered concept reading; it never discovers new work itself. */
export type BackgroundState = 'queued' | 'reading' | 'ready' | 'failed' | 'no_match'
  | 'cancelled' | 'skipped' | 'interrupted';

export interface BackgroundInput<T> { path: string; ownerId: string; title: string; data: T }
export interface BackgroundJob<T = unknown> {
  id: string;
  path: string;
  ownerId: string;
  title: string;
  state: BackgroundState;
  reason?: string;
  auditFolder?: string;
  created: number;
  updated: number;
  attempt: number;
  /** Only live jobs have a trusted payload. Restored history deliberately does not. */
  data?: T;
}
export type BackgroundRunnableJob<T> = BackgroundJob<T> & { data: T };
export interface BackgroundResult {
  state: 'ready' | 'failed' | 'no_match' | 'skipped';
  reason?: string;
  auditFolder?: string;
}
export type BackgroundHistory = Omit<BackgroundJob, 'data'>;
export interface BackgroundOptions<T> {
  /** The caller must check signal immediately before an exact-old-text commit.
   * Aborting cannot roll back a commit that already happened. No late result is published. */
  run: (job: BackgroundRunnableJob<T>, signal: AbortSignal) => Promise<BackgroundResult>;
  canRun?: () => boolean;
  /** A waiting automatic task may yield its slot to an explicitly opened concept.
   * The caller can clear its discovery-attempt marker and enqueue it again later. */
  onDisplaced?: (job: BackgroundJob<T>) => void;
  debounceMs?: number;
  failureCooldownMs?: number;
  gatePollMs?: number;
  maxHistory?: number;
  maxQueued?: number;
  now?: () => number;
}

type BackgroundPriority = 'user' | 'automatic';
interface Entry<T> { job: BackgroundJob<T>; payload?: T; hasPayload: boolean; due: number; revision: number; priority: BackgroundPriority }
interface Active { id: string; revision: number; controller: AbortController }
const states = new Set<BackgroundState>(['queued', 'reading', 'ready', 'failed', 'no_match', 'cancelled', 'skipped', 'interrupted']);
const finalStates = new Set<BackgroundResult['state']>(['ready', 'failed', 'no_match', 'skipped']);
const activeState = (state: BackgroundState) => state === 'queued' || state === 'reading';
const finiteOption = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
const text = (value: unknown, limit: number, required = false): string | undefined => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  const clean = value.trim();
  return required && !clean ? undefined : clean;
};
const keyOf = (path: string, ownerId: string) => `${path}\u0000${ownerId}`;
const validInput = <T>(input: BackgroundInput<T>): boolean => Boolean(input &&
  text(input.path, 1024, true) && !/[\r\n]/.test(input.path) &&
  text(input.ownerId, 256, true) && !/[\r\n]/.test(input.ownerId) && text(input.title, 512, true));
const safeReason = (reason: unknown): string | undefined => typeof reason === 'string'
  ? reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000) : undefined;

export class BackgroundReader<T> {
  private entries = new Map<string, Entry<T>>();
  private keys = new Map<string, string>();
  private listeners = new Set<(jobs: readonly BackgroundJob<T>[]) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Active;
  private pumping = false;
  private stopped = false;
  private destroyed = false;
  private sequence = 0;
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly gatePollMs: number;
  private readonly maxHistory: number;
  private readonly maxQueued: number;
  private readonly now: () => number;

  constructor(private readonly options: BackgroundOptions<T>) {
    this.debounceMs = finiteOption(options.debounceMs, 350, 0, 60000);
    this.cooldownMs = finiteOption(options.failureCooldownMs, 5 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
    this.gatePollMs = finiteOption(options.gatePollMs, 1000, 10, 60000);
    this.maxHistory = finiteOption(options.maxHistory, 50, 1, 50);
    this.maxQueued = finiteOption(options.maxQueued, 24, 1, 24);
    this.now = options.now ?? Date.now;
  }

  get jobs(): readonly BackgroundJob<T>[] { return Array.from(this.entries.values(), entry => this.snapshot(entry)); }
  get paused(): boolean { return this.stopped; }

  subscribe(listener: (jobs: readonly BackgroundJob<T>[]) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.listeners.add(listener);
    this.callListener(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reopening completed/no-match/cancelled tasks is quiet; only failed tasks retry after cooldown. */
  enqueue(input: BackgroundInput<T>, { immediate = false, priority = 'automatic' }: { immediate?: boolean; priority?: BackgroundPriority } = {}): BackgroundJob<T> | undefined {
    if (this.destroyed || !validInput(input)) return undefined;
    const key = keyOf(input.path, input.ownerId);
    const found = this.keys.get(key);
    const old = found ? this.entries.get(found) : undefined;
    if (old) {
      if (old.job.state === 'reading' || ['ready', 'no_match', 'skipped', 'cancelled'].includes(old.job.state)) return this.snapshot(old);
      if (old.job.state === 'failed' && this.now() - old.job.updated < this.cooldownMs) return this.snapshot(old);
      if (old.job.state === 'queued' && old.priority === 'user' && priority === 'automatic') return this.snapshot(old);
      const displaced = old.job.state !== 'queued' && this.queuedCount() >= this.maxQueued
        ? (priority === 'user' ? this.displaceAutomatic() : undefined) : undefined;
      if (old.job.state !== 'queued' && this.queuedCount() >= this.maxQueued) return undefined;
      old.payload = input.data;
      old.hasPayload = true;
      old.job.title = input.title;
      if (priority === 'user') old.priority = 'user';
      this.queueEntry(old, immediate || priority === 'user', displaced);
      return this.snapshot(old);
    }
    let displaced = this.queuedCount() >= this.maxQueued && priority === 'user' ? this.displaceAutomatic() : undefined;
    if (this.queuedCount() >= this.maxQueued) return undefined;
    if (!this.makeRoom()) {
      if (priority !== 'user') return undefined;
      displaced = this.displaceAutomatic();
      if (!displaced || !this.makeRoom()) return undefined;
    }
    const timestamp = this.now();
    let id: string;
    do { id = `background-${timestamp.toString(36)}-${++this.sequence}`; } while (this.entries.has(id));
    const entry: Entry<T> = { job: { id, path: input.path, ownerId: input.ownerId, title: input.title,
      state: 'queued', created: timestamp, updated: timestamp, attempt: 0 }, payload: input.data,
      hasPayload: true, due: timestamp + (immediate || priority === 'user' ? 0 : this.debounceMs), revision: 0, priority };
    this.entries.set(id, entry);
    this.keys.set(key, id);
    this.notifyDisplaced(displaced);
    this.notify();
    this.schedule();
    return this.snapshot(entry);
  }

  /** Imported jobs require a fresh input from the caller's current eligibility check. */
  retry(id: string, input?: BackgroundInput<T>): boolean {
    const entry = this.entries.get(id);
    if (this.destroyed || !entry || activeState(entry.job.state)) return false;
    if (input) {
      if (!validInput(input) || keyOf(input.path, input.ownerId) !== keyOf(entry.job.path, entry.job.ownerId)) return false;
    }
    if (!entry.hasPayload && !input) return false;
    const displaced = this.queuedCount() >= this.maxQueued ? this.displaceAutomatic() : undefined;
    if (this.queuedCount() >= this.maxQueued) return false;
    if (input) {
      entry.payload = input.data;
      entry.hasPayload = true;
      entry.job.title = input.title;
    }
    entry.priority = 'user';
    this.queueEntry(entry, true, displaced);
    return true;
  }

  pause(): void {
    if (this.destroyed || this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.interruptActive('后台读取已暂停。');
    this.notify();
  }

  resume(): void {
    if (this.destroyed) return;
    this.stopped = false;
    this.notify();
    this.schedule();
  }

  /** Call this when foreground work or network policy changes. No idle polling is retained. */
  refreshGate(): void {
    if (this.destroyed) return;
    this.clearTimer();
    if (!this.allowed()) this.interruptActive('后台读取等待前台任务或网络恢复。');
    this.schedule();
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (this.destroyed || !entry || !activeState(entry.job.state)) return false;
    entry.revision++;
    entry.job.state = 'cancelled';
    entry.job.reason = '已取消；如需重新读取，请手动重试。';
    entry.job.updated = this.now();
    if (this.active?.id === id) this.active.controller.abort();
    this.notify();
    this.schedule();
    return true;
  }

  cancelAll(): void {
    if (this.destroyed) return;
    for (const entry of this.entries.values()) if (activeState(entry.job.state)) {
      entry.revision++;
      entry.job.state = 'cancelled';
      entry.job.reason = '已取消；如需重新读取，请手动重试。';
      entry.job.updated = this.now();
    }
    this.active?.controller.abort();
    this.clearTimer();
    this.notify();
  }

  exportHistory(): BackgroundHistory[] {
    return this.jobs.map(({ data: _data, ...history }) => history);
  }

  /** The stored payload is untrusted and is ignored. Restored work never starts automatically. */
  restoreHistory(value: unknown): number {
    if (this.destroyed || !Array.isArray(value)) return 0;
    let count = 0;
    for (const raw of value.slice(0, 50)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const id = text(item.id, 256, true), path = text(item.path, 1024, true);
      const ownerId = text(item.ownerId, 256, true), title = text(item.title, 512, true);
      if (!id || !path || /[\r\n]/.test(path) || !ownerId || /[\r\n]/.test(ownerId) || !title ||
        typeof item.state !== 'string' || !states.has(item.state as BackgroundState) ||
        ![item.created, item.updated].every(time => typeof time === 'number' && Number.isFinite(time) && time >= 0) ||
        typeof item.attempt !== 'number' || !Number.isInteger(item.attempt) || item.attempt < 0 || item.attempt > 1000000 ||
        (item.reason !== undefined && text(item.reason, 2000) === undefined) ||
        (item.auditFolder !== undefined && (text(item.auditFolder, 1024) === undefined || /[\r\n]/.test(String(item.auditFolder))))) continue;
      const key = keyOf(path, ownerId);
      if (this.entries.has(id) || this.keys.has(key) || !this.makeRoom()) continue;
      const oldState = item.state as BackgroundState;
      const state = activeState(oldState) ? 'interrupted' : oldState;
      const job: BackgroundJob<T> = { id, path, ownerId, title, state,
        created: item.created as number, updated: item.updated as number, attempt: item.attempt,
        reason: activeState(oldState) ? '上次读取未完成；打开概念或手动重试前会重新检查资格。' : text(item.reason, 2000),
        auditFolder: text(item.auditFolder, 1024) };
      this.entries.set(id, { job, hasPayload: false, due: Infinity, revision: 0, priority: 'automatic' });
      this.keys.set(key, id);
      count++;
    }
    if (count) this.notify();
    return count;
  }

  dispose(): void {
    if (this.destroyed) return;
    this.cancelAll();
    this.destroyed = true;
    this.clearTimer();
    this.listeners.clear();
  }

  private snapshot(entry: Entry<T>): BackgroundJob<T> {
    return { ...entry.job, ...(entry.hasPayload ? { data: entry.payload as T } : {}) };
  }
  // Include the active slot so preemption can put it back into queued without
  // exceeding the hard pending limit.
  private queuedCount(): number { return Array.from(this.entries.values()).filter(entry => activeState(entry.job.state)).length; }
  private displaceAutomatic(): BackgroundJob<T> | undefined {
    const waiting = Array.from(this.entries.values()).filter(entry => entry.job.state === 'queued' && entry.priority === 'automatic' && entry.job.id !== this.active?.id)
      .sort((a, b) => b.due - a.due || b.job.created - a.job.created)[0];
    if (!waiting) return undefined;
    this.entries.delete(waiting.job.id);
    this.keys.delete(keyOf(waiting.job.path, waiting.job.ownerId));
    return this.snapshot(waiting);
  }
  private notifyDisplaced(job: BackgroundJob<T> | undefined): void {
    if (!job) return;
    try { this.options.onDisplaced?.(job); } catch { /* Caller bookkeeping must not lose the admitted user task. */ }
  }
  private makeRoom(): boolean {
    while (this.entries.size >= this.maxHistory) {
      const oldest = Array.from(this.entries.values()).filter(entry => !activeState(entry.job.state))
        .sort((a, b) => a.job.updated - b.job.updated)[0];
      if (!oldest) return false;
      this.entries.delete(oldest.job.id);
      this.keys.delete(keyOf(oldest.job.path, oldest.job.ownerId));
    }
    return true;
  }
  private queueEntry(entry: Entry<T>, immediate: boolean, displaced?: BackgroundJob<T>): void {
    entry.revision++;
    entry.job.state = 'queued';
    entry.job.reason = undefined;
    entry.job.auditFolder = undefined;
    entry.job.updated = this.now();
    entry.due = this.now() + (immediate ? 0 : this.debounceMs);
    this.notifyDisplaced(displaced);
    this.notify();
    this.schedule();
  }
  private allowed(): boolean {
    try { return !this.stopped && (this.options.canRun?.() ?? true); } catch { return false; }
  }
  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    this.clearTimer();
    if (this.destroyed || this.stopped || this.pumping) return;
    const pending = Array.from(this.entries.values()).filter(entry => entry.job.state === 'queued' && entry.hasPayload);
    if (!pending.length) return;
    const delay = this.allowed() ? Math.max(0, Math.min(...pending.map(entry => entry.due)) - this.now()) : this.gatePollMs;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, delay);
  }
  private interruptActive(reason: string): void {
    if (!this.active) return;
    const entry = this.entries.get(this.active.id);
    if (entry?.job.state === 'reading') {
      entry.revision++;
      entry.job.state = 'queued';
      entry.job.reason = reason;
      entry.job.updated = this.now();
      entry.due = this.now();
      this.notify();
    }
    this.active.controller.abort();
  }
  private async pump(): Promise<void> {
    if (this.destroyed || this.stopped || this.pumping || !this.allowed()) { this.schedule(); return; }
    const entry = Array.from(this.entries.values()).filter(item => item.job.state === 'queued' && item.hasPayload && item.due <= this.now())
      .sort((a, b) => Number(b.priority === 'user') - Number(a.priority === 'user') || a.due - b.due || a.job.created - b.job.created)[0];
    if (!entry) { this.schedule(); return; }
    this.pumping = true;
    const active: Active = { id: entry.job.id, revision: entry.revision, controller: new AbortController() };
    this.active = active;
    entry.job.state = 'reading';
    entry.job.updated = this.now();
    entry.job.attempt++;
    this.notify();
    const signal = active.controller.signal;
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<undefined>(resolve => {
        abortListener = () => resolve(undefined);
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) resolve(undefined);
      });
      // Race releases the logical worker even if a third-party request ignores abort.
      // The losing runner promise has a rejection handler through Promise.race.
      const result = await Promise.race([aborted, Promise.resolve().then(() => {
        if (signal.aborted) return undefined;
        return this.options.run({ ...this.snapshot(entry), data: entry.payload as T }, signal);
      })]);
      if (!this.current(entry, active)) return;
      if (!result || !finalStates.has(result.state)) throw new Error('后台读取返回了无效结果。');
      entry.job.state = result.state;
      entry.job.reason = safeReason(result.reason);
      entry.job.auditFolder = text(result.auditFolder, 1024);
      entry.job.updated = this.now();
      this.notify();
    } catch (error) {
      if (this.current(entry, active)) {
        entry.job.state = 'failed';
        entry.job.reason = safeReason(error instanceof Error ? error.message : String(error)) || '后台读取失败。';
        entry.job.updated = this.now();
        this.notify();
      }
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
      if (this.active === active) this.active = undefined;
      this.pumping = false;
      this.schedule();
    }
  }
  private current(entry: Entry<T>, active: Active): boolean {
    return !this.destroyed && !active.controller.signal.aborted && this.active === active &&
      entry.revision === active.revision && entry.job.state === 'reading';
  }
  private callListener(listener: (jobs: readonly BackgroundJob<T>[]) => void): void {
    try { listener(this.jobs); } catch { /* A status view must not stop background work. */ }
  }
  private notify(): void { for (const listener of this.listeners) this.callListener(listener); }
}
