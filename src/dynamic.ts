import { Cancelled, checkAbort, clampOptions, generateGraph, MAX_TOTAL_WEB_CHARS, type EngineAdapter, type Options, type Seed } from './engine';
import { addEdge, addNode, excerptAt, nodeId, normalizeText, usefulConcept, type GraphNode, type KnowledgeGraph } from './graph';
import { coalesceGraph } from './dedup';
import { cleanKnowledgeTitle, isNoiseLabel } from './titles';
import { excludedContent, plainSearchSnippet, scoreCandidate } from './relevance';
import { fetchWebDocument, publicUrl, type WebDocument } from './web';

export interface ReadingHooks {
  onSnapshot?: (graph: KnowledgeGraph) => void;
  shouldFinish?: () => boolean;
  targetIds?: string[];
}

/** User-facing pace controls latency; these are internal runaway guards. */
export const dynamicReadingBudgets = {
  fast: { milliseconds: 15_000, requests: 36, concepts: 120, depth: 2, requestMilliseconds: 10_000, notes: 6, scans: 60 },
  balanced: { milliseconds: 45_000, requests: 100, concepts: 320, depth: 3, requestMilliseconds: 20_000, notes: 12, scans: 150 },
  deep: { milliseconds: 120_000, requests: 240, concepts: 800, depth: 4, requestMilliseconds: 30_000, notes: 24, scans: 400 }
} as const;

type StopReason = 'time' | 'requested' | 'capacity';
class ReadingStopped extends Error { constructor(readonly reason: StopReason) { super(reason); } }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const detail = (value: unknown) => value instanceof Error ? value.message : String(value);
const key = (title: string) => normalizeText(cleanKnowledgeTitle(title));
const urlKey = (url?: string): string | undefined => { try { return url ? publicUrl(url) : undefined; } catch { return undefined; } };
const readable = (node: GraphNode) => Boolean(node.article?.textChars || (node.locator?.endsWith('.md') && node.bodyAvailable === true)
  || (node.status === 'retrieved' && node.kind === 'note' && node.bodyAvailable !== false));
const disambiguation = (doc: WebDocument) => /\((?:消歧义|消歧義|disambiguation)\)$/i.test(doc.title)
  || /(?:可(?:以)?指(?:[：:]|以下)|可能指|may refer to|can refer to)/i.test(doc.text.slice(0, 400));

class Reader {
  graph: KnowledgeGraph;
  readonly options: Options;
  readonly started = Date.now();
  readonly budget;
  readonly targets: Set<string> | undefined;
  private readonly notes: ReturnType<EngineAdapter['listNotes']>;
  private readonly depthCeiling: number;
  private attempts = new Set<string>();
  private requestCache = new Map<string, Promise<Awaited<ReturnType<EngineAdapter['request']>>>>();
  private requestCount = 0;
  private chars = 0;
  private closed = false;
  constructor(graph: KnowledgeGraph, readonly adapter: EngineAdapter, options: Partial<Options>, readonly signal?: AbortSignal,
    readonly progress = (_message: string) => {}, readonly hooks: ReadingHooks = {}, continuation = false) {
    this.graph = clone(graph);
    this.options = clampOptions({ ...options, readingMode: 'adaptive' });
    this.budget = dynamicReadingBudgets[this.options.readingPace ?? 'balanced'];
    this.targets = hooks.targetIds?.length ? new Set(hooks.targetIds) : undefined;
    this.notes = adapter.listNotes();
    const pendingDepths = this.graph.nodes.filter(node => node.kind === 'concept' && !readable(node)
      && !['failed', 'no_match', 'excluded'].includes(node.reading?.state ?? '') && !/消歧义|多个含义/.test(node.reading?.reason ?? '')).map(node => node.depth);
    this.depthCeiling = continuation ? (pendingDepths.length ? Math.min(...pendingDepths) : 1) + this.budget.depth : this.budget.depth + 1;
    for (const node of this.graph.nodes) {
      if (readable(node)) node.reading = { state: 'ready' };
      else if (continuation && node.kind === 'concept' && ['failed', 'no_match'].includes(node.reading?.state ?? '')
        && (this.targets || !/消歧义|多个含义/.test(node.reading?.reason ?? ''))) node.reading = { state: 'pending', reason: '本次继续补全将重新尝试读取。' };
      else if (node.kind !== 'seed' && (!node.reading || node.reading.state === 'reading')) node.reading = { state: 'pending', reason: '已发现，等待补充正文。' };
    }
  }
  private guard(): void {
    checkAbort(this.signal);
    if (this.closed || this.hooks.shouldFinish?.()) throw new ReadingStopped('requested');
    if (Date.now() - this.started >= this.budget.milliseconds) throw new ReadingStopped('time');
  }
  private async wait<T>(operation: () => Promise<T>, timeout = this.budget.requestMilliseconds): Promise<T> {
    this.guard();
    let timer: ReturnType<typeof setInterval> | undefined;
    let aborted: (() => void) | undefined;
    const issuedAt = Date.now();
    try {
      const result = await Promise.race([Promise.resolve().then(() => { this.guard(); return operation(); }), new Promise<never>((_resolve, reject) => {
        const inspect = () => {
          try { this.guard(); if (Date.now() - issuedAt >= timeout) throw new Error('读取超时，可稍后重试。'); }
          catch (error) { reject(error); }
        };
        timer = setInterval(inspect, 25);
        aborted = () => reject(new Cancelled());
        this.signal?.addEventListener('abort', aborted, { once: true });
        inspect();
      })]);
      this.guard(); return result;
    } finally { if (timer) clearInterval(timer); if (aborted) this.signal?.removeEventListener('abort', aborted); }
  }
  private request = async (input: string) => {
    this.guard();
    const url = publicUrl(input);
    // Cache successes and failures for this pass only. Repeated terms may share
    // a query or a source, but a new explicit continuation can retry failures.
    const cached = this.requestCache.get(url);
    if (cached) return this.wait(() => cached);
    if (this.requestCount >= this.budget.requests) throw new ReadingStopped('capacity');
    this.requestCount++; this.graph.stats.requests++;
    const response = this.wait(() => this.adapter.request(url));
    this.requestCache.set(url, response);
    // Source articles already retain structured content and are deduplicated
    // by URL. Do not keep their raw HTML as another large in-memory copy.
    // Bounded small search/error responses can help repeated empty concepts.
    while (this.requestCache.size > 24) this.requestCache.delete(this.requestCache.keys().next().value!);
    const result = await response;
    const endpoint = new URL(url);
    const search = endpoint.pathname === '/w/api.php' && endpoint.searchParams.get('action') === 'query'
      && endpoint.searchParams.get('list') === 'search';
    if ((result.status >= 200 && result.status < 300 && !search) || result.text.length > 128_000) this.requestCache.delete(url);
    return result;
  };
  private find(id: string): GraphNode | undefined { return this.graph.nodes.find(node => node.id === id || node.mergedIds?.includes(id)); }
  private targeted(node: GraphNode): boolean {
    return !this.targets || [node.id, node.managedId, ...(node.mergedIds ?? [])].some(id => id && this.targets!.has(id));
  }
  private status(id: string, state: NonNullable<GraphNode['reading']>['state'], reason?: string): void {
    const node = this.find(id); if (node) node.reading = { state, ...(reason ? { reason } : {}) };
  }
  private consolidate(): void {
    for (const node of this.graph.nodes) if (node.kind === 'concept' && node.managedId && node.id !== node.managedId)
      node.mergedIds = [...new Set([...(node.mergedIds ?? []), node.id])];
    const sources = this.graph.nodes.filter(node => node.kind === 'web' && node.status === 'retrieved' && (node.article?.textChars || node.excerpt.trim()));
    const urls = new Set(sources.map(node => urlKey(node.locator)).filter(Boolean));
    const owners = new Set(sources.map(node => node.managedId ?? node.id));
    // Most incremental snapshots have no new matching identities. Avoid
    // repeatedly comparing every pending term against every source page.
    if (this.graph.nodes.some(node => node.kind === 'concept' && ((urlKey(node.entityUrl) && urls.has(urlKey(node.entityUrl)))
      || (node.managedId && owners.has(node.managedId))))) this.graph = coalesceGraph(this.graph);
  }
  snapshot(): void {
    this.guard();
    this.consolidate();
    this.graph.reading = { mode: 'adaptive', stopReason: 'complete', elapsedMs: Date.now() - this.started };
    this.hooks.onSnapshot?.(clone(this.graph));
  }
  finish(reason: 'complete' | StopReason): KnowledgeGraph {
    checkAbort(this.signal);
    this.closed = true;
    for (const node of this.graph.nodes) if (node.reading?.state === 'reading') node.reading = { state: 'pending', reason: '本轮已结束，尚未取得正文；可继续补全。' };
    this.consolidate();
    this.graph.reading = { mode: 'adaptive', stopReason: reason, elapsedMs: Date.now() - this.started };
    return clone(this.graph);
  }
  private addMentions(source: GraphNode, doc: WebDocument, ambiguous: boolean): void {
    const allowedRef = (path: string) => !path.split('/').some(part => part.startsWith('.')) && !this.options.excludeFolders.some(folder => {
      const normalized = folder.replace(/\\/g, '/').replace(/\/$/, ''); return path === normalized || path.startsWith(normalized + '/');
    });
    const refs = this.notes.filter(ref => allowedRef(ref.path));
    const normalizedBody = normalizeText(doc.text);
    const focus = this.graph.nodes.find(node => node.kind === 'seed')?.title ?? this.graph.seed;
    const links = doc.links.map(link => ({ link, rank: scoreCandidate(focus, link.label, link.quote, this.options) }))
      .filter(({ link, rank }) => usefulConcept(link.label) && !isNoiseLabel(link.label) && rank.reason !== 'navigation'
      && !excludedContent(link.label, this.options.excludeTerms) && normalizedBody.includes(normalizeText(link.label)))
      .sort((a, b) => b.rank.score - a.rank.score);
    for (const { link } of links) {
      const identity = urlKey(link.url); if (!identity || identity === urlKey(doc.url)) continue;
      const body = this.graph.nodes.find(node => node.kind === 'web' && urlKey(node.locator) === identity && readable(node));
      const matches = refs.filter(ref => ref.managedId && urlKey(ref.sourceUrl) === identity);
      const ref = matches.length === 1 ? matches[0] : undefined;
      let concept = body ?? this.graph.nodes.find(node => node.kind === 'concept' && urlKey(node.entityUrl) === identity);
      if (!concept) {
        if (this.graph.nodes.filter(node => node.kind === 'concept').length >= this.budget.concepts) break;
        concept = addNode(this.graph, { id: nodeId('concept', `url:${identity}`), kind: 'concept', title: link.label,
          ...(ref ? { locator: ref.path, managedId: ref.managedId, bodyAvailable: ref.bodyAvailable ?? true } : {}),
          entityUrl: identity, excerpt: '来源正文中的术语或链接名称，定义与语义关系待核实。', status: 'derived', depth: source.depth + 1,
          reading: { state: 'pending', reason: ambiguous ? '消歧义页面列出的不同含义；请选定具体概念后补全。' : '已有来源链接，等待读取正文。' } });
      }
      // A term discovered on a deep branch can later be mentioned by a source
      // nearer the root. Its shortest supported route controls reading order.
      concept.depth = Math.min(concept.depth, source.depth + 1);
      addEdge(this.graph, source.id, concept.id, 'mentions', { sourceId: source.id, quote: excerptAt(link.quote, link.label, 240), method: '来源正文明确提及该名称；不代表语义或因果推断' });
    }
  }
  private addDocument(doc: WebDocument, target?: GraphNode, rootRelation = false, sourceResolution?: GraphNode['sourceResolution']): GraphNode {
    const prior = this.graph.nodes.find(node => node.kind === 'web' && urlKey(node.locator) === urlKey(doc.url));
    const source = addNode(this.graph, { id: prior?.id ?? nodeId('web', doc.url), kind: 'web', title: doc.title,
      locator: doc.url, managedId: target?.managedId, mergedIds: [...new Set([...(prior?.mergedIds ?? []), ...(target?.mergedIds ?? []),
        ...(target && target.id !== target.managedId ? [target.id] : [])])],
      ...(sourceResolution ? { sourceResolution } : {}),
      sourceTitle: doc.sourceTitle, excerpt: doc.text.slice(0, 900), article: doc.article, retrievedAt: doc.retrievedAt,
      status: 'retrieved', depth: target?.depth ?? 1, truncated: doc.truncated, reading: { state: 'ready' } });
    if (rootRelation) {
      const root = this.graph.nodes.find(node => node.kind === 'seed')!;
      addEdge(this.graph, root.id, source.id, 'seed_source', { sourceId: source.id, quote: doc.sourceTitle ?? doc.title, method: '用户起点对应的来源页面' });
    }
    this.chars += prior?.article ? 0 : doc.article.textChars;
    this.addMentions(source, doc, disambiguation(doc));
    if (target?.kind === 'concept') {
      // A request may resolve a redirect. The verified response belongs to this
      // exact requested identity; labels alone never trigger the merge.
      target.entityUrl = doc.url;
      this.status(target.id, 'ready');
    }
    this.consolidate();
    return this.find(source.id)!;
  }
  private async fetch(url: string): Promise<WebDocument> {
    this.guard();
    if (MAX_TOTAL_WEB_CHARS - this.chars < 2000) throw new ReadingStopped('capacity');
    this.graph.stats.pagesAttempted++;
    return fetchWebDocument(url, this.request, this.signal, 48_000, Math.min(1_000_000, MAX_TOTAL_WEB_CHARS - this.chars));
  }
  private incomingContext(node: GraphNode): string {
    const incoming = this.graph.edges.find(edge => edge.to === node.id && edge.relation === 'mentions');
    const source = incoming ? this.find(incoming.from) : undefined;
    // Never send vault prose to a public search service: only the term, source
    // title and user-supplied context words leave the vault.
    return [source?.title, ...this.options.searchTerms].filter(Boolean).join(' ').slice(0, 160);
  }
  private async lookup(title: string, context: string): Promise<{ url: string; queryUrl: string } | undefined> {
    const languages = this.options.searchLanguageMode === 'both'
      ? [this.options.wikiLanguage, this.options.wikiLanguage === 'zh' ? 'en' : 'zh'] : [this.options.wikiLanguage];
    const failures: string[] = [];
    for (const language of languages) {
      const queries = [...new Set([context ? `"${title.replaceAll('"', '')}" ${context}` : title, title].map(text => text.slice(0, 180)))];
      for (const query of queries) {
        this.guard();
        const endpoint = `https://${language}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: 'query', list: 'search',
          srsearch: query, srnamespace: '0', srprop: 'snippet|redirecttitle', srlimit: '8', srsort: 'relevance', format: 'json', utf8: '1', origin: '*' });
        let result;
        try {
          const response = await this.request(endpoint);
          if (response.status !== 200) throw new Error(`百科搜索失败（HTTP ${response.status}）。`);
          result = JSON.parse(response.text);
          if (result.error) throw new Error(result.error.info ?? '百科搜索失败。');
        } catch (error) {
          if (error instanceof ReadingStopped) throw error;
          checkAbort(this.signal); failures.push(detail(error)); continue;
        }
        const candidates = (Array.isArray(result.query?.search) ? result.query.search : [])
          .filter((item: { title?: unknown; redirecttitle?: unknown }) => typeof item.title === 'string'
            && (key(item.title) === key(title) || (typeof item.redirecttitle === 'string' && key(item.redirecttitle) === key(title))))
          .filter((item: { title: string }) => !excludedContent(item.title, this.options.excludeTerms) && !isNoiseLabel(item.title));
        const unique = new Map<string, { title: string; snippet?: string }>(candidates.map((item: { title: string; snippet?: string }) => [item.title, item]));
        if (unique.size === 1) {
          const item = [...unique.values()][0];
          return { url: publicUrl(`https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(' ', '_'))}`), queryUrl: endpoint };
        }
        if (unique.size > 1) {
          const ranked = [...unique.values()].map(item => ({ item, score: context ? scoreCandidate(context, item.title, plainSearchSnippet(item.snippet ?? ''), { relevance: 'strict' }, 'search') : undefined }))
            .filter(item => item.score?.accepted).sort((a, b) => b.score!.score - a.score!.score);
          if (ranked.length === 1) return { url: publicUrl(`https://${language}.wikipedia.org/wiki/${encodeURIComponent(ranked[0].item.title.replaceAll(' ', '_'))}`), queryUrl: endpoint };
          // Do not let a less contextual fallback silently choose a homonym.
          return undefined;
        }
      }
    }
    if (failures.length) throw new Error(`检索未完成，可稍后重试：${[...new Set(failures)].join('；').slice(0, 240)}`);
    return undefined;
  }
  async seed(seed: Seed): Promise<void> {
    this.guard();
    const root = this.graph.nodes.find(node => node.kind === 'seed')!;
    if (seed.kind === 'url') {
      if (!this.options.web) throw new Error('网页起点需要开启公开网页读取。');
      root.reading = { state: 'reading', reason: '读取起点网页。' };
      this.progress('正在读取起点正文…');
      try {
        const doc = await this.fetch(publicUrl(seed.value));
        root.title = doc.title; this.addDocument(doc, undefined, true);
        root.reading = disambiguation(doc) ? { state: 'no_match', reason: '已读取消歧义页面，请选定具体含义或补充领域词。' } : { state: 'ready' }; this.snapshot();
      } catch (error) {
        if (error instanceof ReadingStopped) throw error; checkAbort(this.signal);
        root.reading = { state: 'failed', reason: detail(error) }; this.graph.warnings.push(`起点网页读取失败：${detail(error)}`); this.snapshot();
      }
    } else if (seed.kind === 'topic' && this.options.web) {
      root.reading = { state: 'reading', reason: '寻找起点对应的来源正文。' };
      this.progress(`寻找“${seed.value}”的正文…`);
      try {
        const found = await this.lookup(seed.value, this.options.searchTerms.join(' '));
        if (found) {
          const doc = await this.fetch(found.url); const source = this.addDocument(doc);
          addEdge(this.graph, root.id, source.id, 'search_match', { sourceId: source.id, quote: `检索词：${seed.value}；返回对应标题：${doc.title}`, locator: found.queryUrl, method: '百科搜索返回标题或重定向与起点对应，正文已读取' });
          root.reading = disambiguation(doc) ? { state: 'no_match', reason: '已读取消歧义页面，请选定具体含义或补充领域词。' } : { state: 'ready' };
        } else root.reading = { state: 'no_match', reason: '未找到可确认身份的百科页面，或起点有多个含义；可补充领域词。' };
        this.snapshot();
      } catch (error) {
        if (error instanceof ReadingStopped) throw error; checkAbort(this.signal);
        root.reading = { state: 'failed', reason: detail(error) }; this.snapshot();
      }
    }
    if (seed.kind === 'topic' && root.reading?.state === 'no_match' && this.options.web && this.options.searchTerms[0]) {
      // A user-provided context term can add a separate relevant source; it
      // never silently declares the ambiguous root and the new term identical.
      const term = this.options.searchTerms[0];
      try {
        const found = await this.lookup(term, seed.value);
        if (found) {
          const source = this.addDocument(await this.fetch(found.url));
          addEdge(this.graph, root.id, source.id, 'search_match', { sourceId: source.id, quote: `用户补充检索词：${term}；来源标题：${source.title}`,
            locator: found.queryUrl, method: '用户补充检索词对应的百科来源，保留独立身份' }); this.snapshot();
        }
      } catch (error) {
        if (error instanceof ReadingStopped) throw error; checkAbort(this.signal);
        this.graph.warnings.push(`补充检索词“${term}”读取失败：${detail(error)}`);
      }
    }
    await this.local(seed);
  }
  private async local(seed: Seed): Promise<void> {
    this.guard();
    const safe: EngineAdapter = { ...this.adapter, listNotes: () => this.notes, readNote: path => this.wait(() => this.adapter.readNote(path)) };
    const local = await this.wait(() => generateGraph(seed.kind === 'url' ? { kind: 'topic', value: this.graph.nodes.find(node => node.kind === 'seed')!.title } : seed,
      safe, { ...this.options, web: false, maxPages: 0, depth: this.budget.depth, maxNotes: this.budget.notes,
        scanLimit: this.budget.scans, maxConcepts: this.budget.concepts, maxNoteChars: 200_000 }, this.signal,
      message => {
        if (this.closed || this.signal?.aborted || this.hooks.shouldFinish?.()) return;
        if (message.includes('已有笔记')) this.progress('正在查找已有笔记中的相关内容…');
        else if (message.includes('起点笔记')) this.progress('正在读取起点笔记…');
      }));
    this.guard();
    const root = this.graph.nodes.find(node => node.kind === 'seed')!;
    const localRoot = local.nodes.find(node => node.kind === 'seed')!;
    if (seed.kind === 'note') root.title = localRoot.title;
    for (const node of local.nodes.filter(node => node.kind !== 'seed')) {
      const ref = node.kind === 'note' ? this.notes.find(ref => ref.path === node.locator) : undefined;
      if (ref && ref.bodyAvailable !== undefined) node.bodyAvailable = ref.bodyAvailable;
      if (node.kind === 'note' && node.managedId && node.bodyAvailable === false) {
        node.kind = 'concept'; node.status = 'derived'; node.entityUrl = ref?.sourceUrl;
        node.excerpt = '来源正文中的术语或链接名称，定义与语义关系待核实。';
      }
      if (readable(node)) node.reading = { state: 'ready' };
      else node.reading = { state: 'pending', reason: '笔记中提及该概念，等待检索对应正文。' };
      addNode(this.graph, node);
    }
    for (const edge of local.edges) for (const evidence of edge.evidence) addEdge(this.graph,
      edge.from === localRoot.id ? root.id : edge.from, edge.to === localRoot.id ? root.id : edge.to, edge.relation,
      { ...evidence, sourceId: evidence.sourceId === localRoot.id ? root.id : evidence.sourceId });
    this.graph.stats.notesScanned += local.stats.notesScanned;
    this.graph.warnings.push(...local.warnings.filter(warning => !warning.startsWith('未成功获取任何来源')));
    if (seed.kind === 'note') root.reading = this.graph.nodes.some(node => readable(node)) ? { state: 'ready' } : { state: 'pending', reason: '起点概念尚无正文，正在寻找对应来源。' };
    this.snapshot();
  }
  private pending(): GraphNode | undefined {
    const focus = this.graph.nodes.find(node => node.kind === 'seed')?.title ?? this.graph.seed;
    const incoming = new Map<string, { context: string; sources: Set<string> }>();
    for (const edge of this.graph.edges) if (edge.relation === 'mentions') {
      const prior = incoming.get(edge.to) ?? { context: '', sources: new Set<string>() };
      prior.sources.add(edge.from);
      if (prior.context.length < 2400) prior.context = (prior.context + ' ' + edge.evidence.map(item => item.quote).join(' ')).slice(0, 2400);
      incoming.set(edge.to, prior);
    }
    const priority = (node: GraphNode): number => {
      const mentions = incoming.get(node.id);
      // Lexical scores only schedule reading. All evidence-backed useful terms
      // remain in the graph, including names unrelated to the seed's spelling.
      return scoreCandidate(focus, node.title, mentions?.context ?? '', this.options).score
        + Number(Boolean(node.entityUrl)) * 2 + Math.min(4, mentions?.sources.size ?? 0);
    };
    return this.graph.nodes.filter(node => node.kind === 'concept' && !readable(node) && this.targeted(node)
      && !this.attempts.has(node.id) && (this.targets || (!['failed', 'no_match', 'excluded'].includes(node.reading?.state ?? '')
        && !/消歧义|多个含义/.test(node.reading?.reason ?? '') && node.depth <= this.depthCeiling)))
      .map(node => ({ node, priority: priority(node) }))
      .sort((a, b) => a.node.depth - b.node.depth || b.priority - a.priority)[0]?.node;
  }
  async complete(): Promise<void> {
    if (!this.options.web) return;
    while (true) {
      this.guard();
      const target = this.pending(); if (!target) break;
      this.attempts.add(target.id);
      if (excludedContent(target.title, this.options.excludeTerms) || isNoiseLabel(target.title)) {
        this.status(target.id, 'excluded', '已被排除词或导航噪声规则排除。'); this.snapshot(); continue;
      }
      this.status(target.id, 'reading', '正在补充来源正文。'); this.snapshot();
      this.progress(`正在补全“${target.title}”的正文…`);
      try {
        const found = target.entityUrl ? { url: publicUrl(target.entityUrl), queryUrl: undefined } : await this.lookup(target.title, this.incomingContext(target));
        if (!found) { this.status(target.id, 'no_match', '未找到能确认名称与含义的百科页面；请补充领域词或指定来源。'); this.snapshot(); continue; }
        const existing = this.graph.nodes.find(node => node.kind === 'web' && urlKey(node.locator) === urlKey(found.url) && readable(node));
        if (existing) {
          target.entityUrl = found.url;
          const separateOwner = target.locator?.endsWith('.md') && target.managedId !== (existing.managedId ?? existing.id);
          this.status(target.id, separateOwner ? 'no_match' : 'ready', separateOwner
            ? '该来源已有独立笔记；当前概念尚无正文，请预览合并重复概念与正文节点。' : undefined);
          this.snapshot(); continue;
        }
        const doc = await this.fetch(found.url);
        if (excludedContent(doc.title, this.options.excludeTerms) || isNoiseLabel(doc.title)) {
          this.status(target.id, 'excluded', '来源标题被排除词或导航噪声规则排除。'); this.snapshot(); continue;
        }
        if (!target.entityUrl && disambiguation(doc)) {
          this.status(target.id, 'no_match', '对应页面包含多个含义，请补充领域词或指定具体来源。'); this.snapshot(); continue;
        }
        // The URL is assigned only after matching API title/redirect and reading
        // an actual document. No label-only upgrade can occur in the preview.
        const resolution = !target.entityUrl && found.queryUrl ? { term: target.title, queryUrl: found.queryUrl } : undefined;
        target.entityUrl = doc.url;
        const source = this.addDocument(doc, target, false, resolution);
        if (found.queryUrl) this.graph.warnings.push(`已通过百科标题或重定向对应补全“${target.title}”；关联含义仍需结合原文核查。`);
        source.reading = disambiguation(doc)
          ? { state: 'no_match', reason: '来源页面包含多个含义；已保留页面正文，请选定具体概念后继续。' }
          : { state: 'ready' }; this.snapshot();
      } catch (error) {
        if (error instanceof ReadingStopped) throw error;
        checkAbort(this.signal); this.status(target.id, 'failed', detail(error)); this.snapshot();
      }
    }
  }
}

async function run(reader: Reader, seed?: Seed): Promise<KnowledgeGraph> {
  try { if (seed) await reader.seed(seed); await reader.complete(); return reader.finish('complete'); }
  catch (error) { if (error instanceof ReadingStopped) return reader.finish(error.reason); checkAbort(reader.signal); throw error; }
}

export async function discoverDynamic(seed: Seed, adapter: EngineAdapter, options: Partial<Options>, signal?: AbortSignal,
  progress?: (message: string) => void, hooks?: ReadingHooks): Promise<KnowledgeGraph> {
  if (!seed.value.trim()) throw new Error('请输入网页地址、知识主题或笔记路径。');
  checkAbort(signal);
  const value = seed.value.trim();
  const graph: KnowledgeGraph = { version: 1, seed: value, createdAt: new Date().toISOString(), nodes: [{ id: nodeId('seed', `${seed.kind}:${value}`),
    kind: 'seed', title: value, excerpt: '正文与概念逐步补全；来源提及不代表语义或因果推断。', depth: 0, status: 'derived' }],
    edges: [], warnings: [], stats: { pagesAttempted: 0, notesScanned: 0, requests: 0 } };
  return run(new Reader(graph, adapter, options, signal, progress, hooks), { ...seed, value });
}

export async function completeDynamic(graph: KnowledgeGraph, adapter: EngineAdapter, options: Partial<Options>, signal?: AbortSignal,
  progress?: (message: string) => void, hooks?: ReadingHooks): Promise<KnowledgeGraph> {
  checkAbort(signal);
  return run(new Reader(graph, adapter, options, signal, progress, hooks, true));
}
