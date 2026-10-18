import { Cancelled, checkAbort, clampOptions, fallbackNoteLinks, filterVisibleNoteLinks, visibleNoteContent, MAX_TOTAL_WEB_CHARS, type EngineAdapter, type NoteRef, type Options, type Seed } from './engine';
import { addEdge, excerptAt, nodeId, normalizeText, usefulConcept, NO_RETRIEVED_SOURCE_WARNING, type GraphNode, type KnowledgeGraph, type Relation } from './graph';
import { cleanKnowledgeTitle, isNoiseLabel } from './titles';
import { excludedContent, plainSearchSnippet, scoreCandidate, scoreSearchCandidate, searchQueries } from './relevance';
import { fetchWebDocument, publicUrl, type WebDocument } from './web';
import { compareExplorationWork, explorationDirectionTerms, explorationPolicy } from './exploration-policy';

export interface ExplorationHooks {
  onSnapshot?: (graph: KnowledgeGraph) => Promise<void> | void;
  progress?: (text: string) => void;
  shouldExclude?: (node: GraphNode) => boolean;
  /** Resolve when allowed to continue; a parent may wait here while paused. */
  shouldContinue?: () => Promise<void> | void;
}
interface Work { id: string; distance: number; priority: number; sequence: number }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const visibleNote = visibleNoteContent;
const under = (path: string, folder: string) => {
  const normalized = folder.trim().replace(/\\/g, '/').replace(/\/$/, '');
  return Boolean(normalized) && (path === normalized || path.startsWith(normalized + '/'));
};

/** Discover and publish concepts incrementally. This pass reads source pages
 * solely to extract supported links and retains their real article if fetched.
 * It never waits for all discovered concepts to receive detailed bodies. */
export async function exploreConcepts(seed: Seed, adapter: EngineAdapter, raw: Options, signal?: AbortSignal, hooks: ExplorationHooks = {}): Promise<KnowledgeGraph> {
  const value = seed.value.trim();
  if (!value) throw new Error('请输入网页地址、知识主题或笔记路径。');
  checkAbort(signal);
  const options = clampOptions(raw);
  const directionTerms = explorationDirectionTerms(options), rankingOptions = {...options, searchTerms:directionTerms};
  const graph: KnowledgeGraph = { version: 1, seed: value, createdAt: new Date().toISOString(), nodes: [], edges: [], warnings: [],
    stats: { pagesAttempted: 0, notesScanned: 0, requests: 0 } };
  const root: GraphNode = { id: nodeId('seed', `${seed.kind}:${value}`), kind: 'seed', title: value, depth: 0, status: 'derived',
    excerpt: '后台逐步发现来源与概念；词项匹配和提及不表示因果关系。' };
  // The first snapshot allocates the permanent navigation note before the
  // metadata index is listed. Use the filename as its readable initial label,
  // while keeping the full vault path in the seed identity.
  if(seed.kind==='note') root.title=cleanKnowledgeTitle(value.replace(/\.md$/i,'').split('/').pop()??value);
  if(seed.kind==='url') {
    const target=new URL(publicUrl(value));
    try{root.title=cleanKnowledgeTitle(decodeURIComponent(target.pathname.split('/').filter(Boolean).at(-1)??target.hostname).replaceAll('_',' '));}
    catch{root.title=target.hostname;}
  }
  graph.nodes.push(root);
  const guard = async () => { checkAbort(signal); await cancellable(() => Promise.resolve(hooks.shouldContinue?.()), false); checkAbort(signal); };
  async function cancellable<T>(operation: () => Promise<T>, timed = true): Promise<T> {
    checkAbort(signal);
    let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return operation(); }), new Promise<never>((_resolve, reject) => {
        if (timed) timer = setTimeout(() => reject(new Error('来源读取超时，可稍后继续探索。')), 20_000);
        aborted = () => reject(new Cancelled()); signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      })]);
      checkAbort(signal); return result;
    } finally { if (timer) clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted); }
  }
  const publish = async () => { await guard(); checkAbort(signal); await hooks.onSnapshot?.(clone(graph)); checkAbort(signal); };
  // Deliberately before even listing/reading local notes or issuing a request.
  await publish();
  const known = adapter.listNotes(), byPath = new Map(known.map(note => [note.path, note]));
  const paths = new Map<string, string>(), urls = new Map<string, string>();
  const queue: Work[] = [], scheduled = new Set<string>(), inspected = new Set<string>();
  const localReads = new Map<string, string>();
  const requestBudget = options.maxPages * 3 + 12;
  let sequence = 0, retainedChars = 0, query = value, selectedNotes = 0, scannedNotes = 0, warnedCapacity = false;
  const excludedPath = (path: string) => path.split('/').some(part => part.startsWith('.')) || options.excludeFolders.some(folder => under(path, folder));
  const allowed = (node: GraphNode) => node.kind==='seed' || (!excludedContent(node.title, options.excludeTerms) && !isNoiseLabel(node.title)
    && !(node.locator?.endsWith('.md') && excludedPath(node.locator)) && !hooks.shouldExclude?.(clone(node)));
  const find = (id: string) => graph.nodes.find(node => node.id === id)!;
  const request = async (url: string) => {
    await guard();
    if (graph.stats.requests >= requestBudget) throw new Error('已达到概念探索的网络请求预算。');
    graph.stats.requests++;
    return cancellable(() => adapter.request(publicUrl(url)));
  };
  const schedule = (node: GraphNode, distance: number, context = '', always = false) => {
    if (scheduled.has(node.id) || inspected.has(node.id) || !allowed(node)) return;
    const policy = explorationPolicy(node.title, context, distance, options, query);
    if (!always && (distance >= policy.depthCap || !policy.breadth)) return;
    if (!node.entityUrl && !(node.kind === 'note' && node.locator) && !node.sourceResolution) return;
    scheduled.add(node.id); queue.push({ id: node.id, distance, priority: policy.priority, sequence: sequence++ });
  };
  const insert = (node: GraphNode): GraphNode | undefined => {
    const prior = graph.nodes.find(item => item.id === node.id);
    if (prior) return allowed(prior) ? prior : undefined;
    if (!allowed(node)) return;
    if (graph.nodes.length - 1 >= options.maxConcepts) {
      if (!warnedCapacity) { graph.warnings.push(`概念探索达到 ${options.maxConcepts} 个非起点节点上限；可从已有节点继续探索。`); warnedCapacity = true; }
      return;
    }
    graph.nodes.push(node); return node;
  };
  const addRef = (ref: NoteRef, distance: number): GraphNode | undefined => {
    const prior = paths.get(ref.path);
    if (prior) return allowed(find(prior)) ? find(prior) : undefined;
    if (selectedNotes >= options.maxNotes && !(seed.kind === 'note' && ref.path === value)) return;
    let sourceUrl: string | undefined;
    try { sourceUrl = ref.sourceUrl ? publicUrl(ref.sourceUrl) : undefined; } catch { /* Invalid note metadata is not a network destination. */ }
    const sourceId = sourceUrl ? urls.get(sourceUrl) : undefined;
    if (sourceId) return allowed(find(sourceId)) ? find(sourceId) : undefined;
    const node = insert({ id: nodeId('note', ref.path), kind: 'note', title: cleanKnowledgeTitle(ref.title), locator: ref.path, managedId: ref.managedId, entityUrl: sourceUrl,
      bodyAvailable: ref.bodyAvailable ?? true, depth: distance + 1, status: 'discovered',
      excerpt: '已有笔记；本次来源尚未读取，关系以原有链接或词项匹配为证据。',
      reading: { state: ref.bodyAvailable === false ? 'pending' : 'ready' } });
    if (node) { paths.set(ref.path, node.id); if (sourceUrl) urls.set(sourceUrl, node.id); if (!(seed.kind === 'note' && ref.path === value)) selectedNotes++; }
    return node;
  };
  const addTerm = (label: string, distance: number, url?: string, localPath?: string, identity?: string): GraphNode | undefined => {
    const title = cleanKnowledgeTitle(label);
    if (!usefulConcept(title)) return;
    let normalizedUrl: string | undefined;
    try { normalizedUrl = url ? publicUrl(url) : undefined; } catch { return; }
    const ref = localPath ? byPath.get(localPath) : undefined;
    let refUrl: string | undefined;
    try { refUrl = ref?.sourceUrl ? publicUrl(ref.sourceUrl) : undefined; } catch { /* Require explicit, valid identity to reuse a web-backed file. */ }
    // A label can resolve to a same-named vault file, including the newly saved
    // navigation seed. A web mention may reuse that file only when its source
    // URL independently confirms the same entity; missing metadata is no match.
    if (ref && (!normalizedUrl || refUrl === normalizedUrl)) return addRef(ref, distance);
    const prior = normalizedUrl ? urls.get(normalizedUrl) : undefined;
    if (prior) return allowed(find(prior)) ? find(prior) : undefined;
    const node = insert({ id: nodeId('concept', normalizedUrl ? `url:${normalizedUrl}` : `term:${identity ?? title}`), kind: 'concept', title,
      entityUrl: normalizedUrl, depth: distance + 1, status: 'derived', bodyAvailable: false,
      excerpt: '来源正文中的术语或链接名称，定义与语义关系待核实。', reading: { state: 'pending', reason: '概念已发现，正文由独立后台任务补充。' } });
    if (node && normalizedUrl) urls.set(normalizedUrl, node.id);
    return node;
  };
  const connect = (parent: GraphNode, node: GraphNode, relation: Relation, quote: string, method: string, locator?: string) => {
    if (allowed(parent) && allowed(node)) addEdge(graph, parent.id, node.id, relation,
      { sourceId: relation === 'search_match' || relation === 'keyword_match' || relation === 'seed_source' ? node.id : parent.id,
        quote: excerptAt(quote, node.title, 240), method, ...(locator ? { locator } : {}) });
  };
  const readLocal = async (path: string): Promise<string | undefined> => {
    if (localReads.has(path)) return localReads.get(path);
    if (scannedNotes >= options.scanLimit) return;
    await guard(); scannedNotes++;
    try {
      const full = await cancellable(() => adapter.readNote(path)); graph.stats.notesScanned++;
      const text = full.slice(0, options.maxNoteChars); localReads.set(path, text);
      if (full.length > text.length) graph.warnings.push(`笔记仅分析前 ${options.maxNoteChars} 字符：${path}`);
      return text;
    } catch (error) { checkAbort(signal); graph.warnings.push(`笔记读取失败 ${path}：${errorText(error)}`); return; }
  };
  const processNote = async (source: GraphNode, distance: number) => {
    const text = await readLocal(source.locator!);
    if (text === undefined) return;
    await guard(); if (!allowed(source)) return;
    source.status = 'retrieved'; source.retrievedAt = graph.createdAt; source.excerpt = excerptAt(visibleNote(text), query, 800);
    const indexed = adapter.noteLinks?.(source.locator!);
    const links = (indexed === undefined ? fallbackNoteLinks(text) : filterVisibleNoteLinks(text, indexed))
      .filter(link => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.target.trim()));
    const policy = explorationPolicy(source.title, source.excerpt, distance, options, query);
    if (distance >= policy.depthCap) { await publish(); return; }
    const ranked = links.map(link => ({ link, title: link.label?.trim() || link.target.split('#')[0].split('/').pop()!,
      score: scoreCandidate(query, link.label ?? link.target, link.quote, rankingOptions, 'note').score,
      branch:explorationPolicy(link.label ?? link.target, link.quote, distance + 1, options, query) }))
      .sort((a, b) => b.branch.priority - a.branch.priority || b.score - a.score).slice(0, policy.breadth);
    for (const { link, title } of ranked) {
      await guard(); if (!allowed(source)) break;
      const target = link.target.split('#')[0].trim(); if (!target) continue;
      const path = adapter.resolveLink(target, source.locator!);
      const node = path ? (byPath.has(path) ? addRef(byPath.get(path)!, distance + 1) : undefined) : addTerm(title, distance + 1, undefined, undefined, target);
      if (!node) continue;
      connect(source, node, path ? 'wiki_link' : 'mentions', link.quote, path ? '已存在的 Obsidian 内部链接' : '笔记中的未解析双链名称，尚未取得正文');
      schedule(node, distance + 1, link.quote);
    }
    await publish();
  };
  const processWeb = async (source: GraphNode, distance: number) => {
    if (!options.web || graph.stats.pagesAttempted >= options.maxPages || MAX_TOTAL_WEB_CHARS - retainedChars < 2000) return;
    await guard(); if (!allowed(source)) return;
    graph.stats.pagesAttempted++; hooks.progress?.(`发现概念来源：${source.title}…`);
    const requested = source.entityUrl!;
    let doc: WebDocument;
    try {
      doc = await fetchWebDocument(requested, request, signal, options.maxBodyChars, Math.min(1_000_000, MAX_TOTAL_WEB_CHARS - retainedChars));
    } catch (error) {
      checkAbort(signal); if (!allowed(source)) return;
      source.reading = { state: 'failed', reason: `概念保留，来源读取失败：${errorText(error)}` };
      graph.warnings.push(`概念来源读取失败 ${source.title}：${errorText(error)}`); await publish(); return;
    }
      await guard(); if (!allowed(source) || excludedContent(doc.title, options.excludeTerms) || isNoiseLabel(doc.title)) return;
      // Retain the published concept ID across hydration, including redirects.
      // The requested URL is an explicit identity; a matching title is not.
      const canonical = urls.get(doc.url);
      if (canonical && canonical !== source.id) {
        const target = find(canonical);
        const aliases = new Set([...(target.mergedIds ?? []), source.id, ...(source.mergedIds ?? [])]);
        target.mergedIds = [...aliases].filter(id => id !== target.id);
        const oldEdges = graph.edges; graph.edges = []; graph.nodes = graph.nodes.filter(node => node.id !== source.id);
        for (const edge of oldEdges) for (const evidence of edge.evidence) addEdge(graph, edge.from === source.id ? target.id : edge.from,
          edge.to === source.id ? target.id : edge.to, edge.relation, { ...evidence, sourceId: evidence.sourceId === source.id ? target.id : evidence.sourceId });
        urls.set(requested, target.id); source = target;
      }
      urls.set(doc.url, source.id); urls.set(requested, source.id);
      Object.assign(source, { kind: 'web', title: cleanKnowledgeTitle(doc.title), sourceTitle: doc.sourceTitle, locator: doc.url, entityUrl: doc.url,
        article: doc.article, excerpt: doc.text.slice(0, 900), retrievedAt: doc.retrievedAt, status: 'retrieved', bodyAvailable: true,
        reading: { state: 'ready' }, truncated: doc.truncated });
      retainedChars += doc.article.textChars;
      // Root-level search candidates also have depth 1. Only the explicitly
      // requested seed URL may refine the root, even if its returned title changes.
      if (seed.kind === 'url' && requested === publicUrl(value)) { root.title = source.title; query = root.title; }
      if (doc.truncated) graph.warnings.push(`概念来源的保留正文已按结构截断：${doc.title}`);
      addWebMentions(source, doc, distance);
      await publish();
  };
  const addWebMentions = (source: GraphNode, doc: WebDocument, distance: number) => {
    const policy = explorationPolicy(source.title, doc.text.slice(0, 4000), distance, options, query);
    if (distance >= policy.depthCap || /\((?:消歧义|消歧義|disambiguation)\)$/i.test(doc.title)) return;
    const body = normalizeText(doc.text);
    const ranked = doc.links.map(link => ({ link, rank: scoreCandidate(query, link.label, link.quote, rankingOptions),
      branch: explorationPolicy(link.label, link.quote, distance + 1, options, query) }))
      .filter(item => item.rank.reason !== 'navigation' && item.rank.reason !== 'excluded'
        && (options.relevance !== 'strict' || item.rank.accepted || item.branch.focused)
        && body.includes(normalizeText(item.link.label)))
      .sort((a, b) => b.branch.priority - a.branch.priority || b.rank.score - a.rank.score).slice(0, policy.breadth);
    for (const { link } of ranked) {
      const path = adapter.resolveLink(link.label, seed.kind === 'note' ? value : '');
      const node = addTerm(link.label, distance + 1, link.url, path ?? undefined);
      if (!node) continue;
      connect(source, node, 'mentions', link.quote, '已读取来源正文中的实际超链接与名称；不是模型推断');
      schedule(node, distance + 1, link.quote);
    }
  };
  const search = async (language: 'zh' | 'en', phrase: string) => {
    await guard();
    const endpoint = `https://${language}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: 'query', list: 'search', srsearch: phrase,
      srnamespace: '0', srprop: 'snippet|redirecttitle', srlimit: String(options.searchLimit), srsort: 'relevance', format: 'json', utf8: '1', origin: '*' });
    hooks.progress?.(`后台发现概念：${phrase}…`);
    let candidates: Array<{ title?: unknown; snippet?: unknown; redirecttitle?: unknown }>;
    try {
      const response = await request(endpoint);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (response.text.length > 2_000_000) throw new Error('百科搜索响应超过容量。');
      const result = JSON.parse(response.text);
      if (result.error) throw new Error(String(result.error.info ?? '百科检索失败'));
      candidates = (Array.isArray(result.query?.search) ? result.query.search : []).slice(0, options.searchLimit);
    } catch (error) { checkAbort(signal); graph.warnings.push(`概念检索失败（${language}，${phrase}）：${errorText(error)}`); await publish(); return; }
      for (const item of candidates) {
        await guard(); if (typeof item.title !== 'string') continue;
        const title = item.title, snippet = plainSearchSnippet(typeof item.snippet === 'string' ? item.snippet : '');
        const rank = scoreSearchCandidate(query, title, `${snippet} ${typeof item.redirecttitle === 'string' ? item.redirecttitle : ''}`, rankingOptions);
        if (!rank.accepted || isNoiseLabel(title)) continue;
        const url = publicUrl(`https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`);
        const node = addTerm(title, 0, url); if (!node) continue;
        if (node.status !== 'retrieved') node.excerpt = snippet || '公开百科搜索返回的候选名称；尚未读取来源正文。';
        connect(root, node, 'search_match', `检索词：${phrase}；API 返回标题：${title}${rank.expandedTerm ? '；按核心词匹配：' + rank.expandedTerm : ''}${snippet ? '；API 摘要：' + snippet : ''}`,
          '公开百科搜索返回记录，尚未核实正文或语义关系', endpoint);
        schedule(node, 0, snippet);
      }
      await publish();
  };

  if (seed.kind === 'url') {
    if (!options.web || options.maxPages < 1) throw new Error('网页起点需要开启公开网页检索，并将网页上限设为至少 1。');
    const url = publicUrl(value), source = insert({ id: nodeId('concept', `url:${url}`), kind: 'concept', title: root.title, entityUrl: url,
      depth: 1, status: 'derived', excerpt: '用户指定网页，等待读取来源与概念。', bodyAvailable: false, reading: { state: 'pending' } });
    if (source) urls.set(url, source.id);
    if (source) { connect(root, source, 'seed_source', url, '用户指定公开网页'); await publish(); await processWeb(source, 0); inspected.add(source.id); }
  } else if (seed.kind === 'note') {
    if (excludedPath(value)) throw new Error('起点笔记位于排除范围，无法探索。');
    const ref = byPath.get(value) ?? { path: value, title: value.replace(/\.md$/, '').split('/').pop()! };
    query = cleanKnowledgeTitle(ref.title); root.title = query;
    const source = addRef(ref, 0);
    if (source) { connect(root, source, 'seed_source', ref.title, '用户指定已有笔记'); await publish(); await processNote(source, 0); inspected.add(source.id); }
  }
  // Existing notes are selected incrementally, without uploading their prose.
  const candidates = known.filter(ref => !excludedPath(ref.path) && !paths.has(ref.path)
    && (!options.generatedFolder || !under(ref.path, options.generatedFolder)) && !excludedContent(ref.title, options.excludeTerms))
    .sort((a, b) => scoreCandidate(query, b.title, '', rankingOptions, 'note').score - scoreCandidate(query, a.title, '', rankingOptions, 'note').score || a.path.localeCompare(b.path));
  for (const ref of candidates) {
    await guard(); if (selectedNotes >= options.maxNotes || scannedNotes >= options.scanLimit || graph.nodes.length - 1 >= options.maxConcepts) break;
    const text = await readLocal(ref.path); if (text === undefined) continue;
    const rank = scoreCandidate(query, ref.title, visibleNote(text), rankingOptions, 'note');
    if (!rank.accepted || rank.score <= 0) continue;
    const source = addRef(ref, 0); if (!source) continue;
    connect(root, source, 'keyword_match', excerptAt(visibleNote(text), query, 240) || ref.title, '已有笔记的词面匹配，相关性尚未核实');
    await processNote(source, 0); inspected.add(source.id);
  }
  if (options.web && options.searchLimit > 0 && options.maxPages > graph.stats.pagesAttempted && graph.nodes.length - 1 < options.maxConcepts) {
    const languages: Array<'zh' | 'en'> = options.searchLanguageMode === 'both' ? [options.wikiLanguage, options.wikiLanguage === 'zh' ? 'en' : 'zh'] : [options.wikiLanguage];
    if (directionTerms.length > 4) graph.warnings.push('为限制请求，本次搜索只使用前 4 个方向词；筛选与分支策略仍使用全部方向。');
    for (const language of languages) for (const phrase of searchQueries(query, directionTerms)) {
      if (graph.stats.requests >= requestBudget || graph.nodes.length - 1 >= options.maxConcepts) break;
      await search(language, phrase);
    }
  }
  while (queue.length) {
    await guard();
    queue.sort((a, b) => compareExplorationWork(a,b,options));
    const item = queue.shift()!; scheduled.delete(item.id);
    const source = graph.nodes.find(node => node.id === item.id);
    if (!source || inspected.has(source.id) || !allowed(source)) continue;
    inspected.add(source.id);
    // Once the node cap is reached, remaining bodies belong to the independent
    // reader. Do not hold the discovery task open merely to hydrate all nodes.
    if (graph.nodes.length - 1 >= options.maxConcepts) break;
    if (source.kind === 'note') await processNote(source, item.distance);
    else if (source.entityUrl && options.web && graph.stats.pagesAttempted < options.maxPages && graph.stats.requests < requestBudget)
      await processWeb(source, item.distance);
  }
  if (MAX_TOTAL_WEB_CHARS - retainedChars < 2000) graph.warnings.push('概念来源读取达到 400 万字符总容量，后续概念正文可独立补充。');
  if (graph.stats.requests >= requestBudget) graph.warnings.push('概念探索已达到网络请求预算，保留当前结果。');
  if (scannedNotes >= options.scanLimit && candidates.some(ref => !localReads.has(ref.path))) graph.warnings.push('本轮已有笔记扫描达到上限，保留已发现结果。');
  if (!graph.nodes.some(node => node.status === 'retrieved')) graph.warnings.push(NO_RETRIEVED_SOURCE_WARNING);
  hooks.progress?.(explorationSummary(graph));
  await publish(); return clone(graph);
}

export function explorationSummary(graph: KnowledgeGraph): string {
  if (graph.nodes.length <= 1) return '未找到通过筛选的相关概念或来源；请补充领域词、使用完整名称或调整筛选后继续探索。';
  if (!graph.nodes.some(node => node.kind !== 'seed' && (node.status === 'retrieved' || node.bodyAvailable)))
    return '已保留概念与候选，但尚未取得来源正文；可在正文任务查看原因或补充检索词。';
  return '概念探索已结束；已排队正文继续补充。';
}
