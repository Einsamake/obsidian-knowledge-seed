import { addEdge, addNode, excerptAt, nodeId, normalizeText, usefulConcept, type GraphNode, type KnowledgeGraph, type Relation } from './graph';
import { fetchWebDocument, publicUrl, type WebDocument } from './web';
import { cleanKnowledgeTitle, isNoiseLabel } from './titles';
import { excludedContent, plainSearchSnippet, scoreCandidate, scoreSearchCandidate, searchQueries, type RelevanceMode } from './relevance';
import { coalesceGraph } from './dedup';

export type Seed = { kind: 'url' | 'topic' | 'note'; value: string };
export interface NoteRef { path: string; title: string; managedId?: string; sourceUrl?: string; bodyAvailable?: boolean }
export interface NoteLink { target: string; label?: string; quote: string; endOffset?: number }
export type ExplorationStrategy = 'radial' | 'focused' | 'breadth' | 'depth' | 'custom';
export interface DirectionRule { term: string; weight: number; depth?: number }
export interface EngineAdapter {
  request(url: string): Promise<{ text: string; status: number; headers?: Record<string, string> }>;
  listNotes(): NoteRef[];
  readNote(path: string): Promise<string>;
  resolveLink(link: string, from: string): string | null;
  /** Native indexed links; undefined means the note has not been indexed yet. */
  noteLinks?(path: string): NoteLink[] | undefined;
}
export interface Options {
  /** Manual retains legacy bounded discovery; adaptive prioritizes content within a time window. */
  readingMode?: 'adaptive' | 'manual'; readingPace?: 'fast' | 'balanced' | 'deep';
  web: boolean; wikiLanguage: 'zh' | 'en'; maxPages: number; depth: number;
  maxNotes: number; maxConcepts: number; scanLimit: number; excludeFolders: string[]; generatedFolder?: string;
  searchLimit: number; linkLimit: number; maxBodyChars: number; maxNoteChars: number;
  relevance: RelevanceMode; searchTerms: string[]; excludeTerms: string[]; searchLanguageMode: 'primary' | 'both';
  /** Incremental discovery allocation. Missing values preserve the legacy radial policy. */
  explorationStrategy?: ExplorationStrategy; breadthDecay?: number; directionDepthBoost?: number; offDirectionDepth?: number;
  directionRules?: DirectionRule[];
}
export const defaults: Options = { readingMode: 'manual', readingPace: 'balanced', web: true, wikiLanguage: 'zh', maxPages: 5, depth: 1,
  maxNotes: 8, maxConcepts: 16, scanLimit: 250, excludeFolders: ['Templates'],
  searchLimit: 12, linkLimit: 12, maxBodyChars: 48000, maxNoteChars: 20000,
  relevance: 'balanced', searchTerms: [], excludeTerms: [], searchLanguageMode: 'primary',
  explorationStrategy: 'radial', breadthDecay: 1, directionDepthBoost: 2, offDirectionDepth: 1, directionRules: [] };
export const MAX_TOTAL_WEB_CHARS = 4_000_000;
export function clampOptions(value: Partial<Options>): Options {
  const number = (x: number | undefined, fallback: number, max: number) => Number.isFinite(x) ? Math.max(0, Math.min(max, Math.floor(x!))) : fallback;
  return { ...defaults, ...value,
    readingMode: value.readingMode === 'adaptive' ? 'adaptive' : 'manual',
    readingPace: value.readingPace === 'fast' || value.readingPace === 'deep' ? value.readingPace : 'balanced',
    explorationStrategy: ['focused','breadth','depth','custom'].includes(value.explorationStrategy as string) ? value.explorationStrategy : 'radial',
    breadthDecay: number(value.breadthDecay, 1, 4), directionDepthBoost: number(value.directionDepthBoost, 2, 20),
    offDirectionDepth: number(value.offDirectionDepth, 1, 20),
    directionRules: Array.isArray(value.directionRules) ? value.directionRules.filter(rule => rule && typeof rule === 'object'
      && !Array.isArray(rule) && typeof rule.term === 'string' && rule.term.trim()).slice(0, 20).map(rule => ({
        term: rule.term.trim().slice(0, 180), weight: Math.max(1, number(rule.weight, 1, 10)),
        ...(rule.depth !== undefined ? {depth:number(rule.depth, 0, 20)} : {}) })) : [],
    web: typeof value.web === 'boolean' ? value.web : defaults.web,
    wikiLanguage: value.wikiLanguage === 'en' ? 'en' : 'zh',
    maxPages: number(value.maxPages, defaults.maxPages, 500), depth: number(value.depth, defaults.depth, 20),
    maxNotes: number(value.maxNotes, defaults.maxNotes, 500), maxConcepts: number(value.maxConcepts, defaults.maxConcepts, 1000),
    scanLimit: Math.max(1, number(value.scanLimit, defaults.scanLimit, 50000)),
    searchLimit: number(value.searchLimit, defaults.searchLimit, 100), linkLimit: number(value.linkLimit, defaults.linkLimit, 100),
    maxBodyChars: Math.max(2000, number(value.maxBodyChars, defaults.maxBodyChars, 200000)),
    maxNoteChars: Math.max(80, number(value.maxNoteChars, defaults.maxNoteChars, 200000)),
    relevance: value.relevance === 'strict' || value.relevance === 'broad' ? value.relevance : 'balanced',
    searchLanguageMode: value.searchLanguageMode === 'both' ? 'both' : 'primary',
    searchTerms: Array.isArray(value.searchTerms) ? [...new Set(value.searchTerms.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 180)).filter(Boolean))].slice(0, 20) : [],
    excludeTerms: Array.isArray(value.excludeTerms) ? [...new Set(value.excludeTerms.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 180)).filter(Boolean))].slice(0, 100) : [],
    excludeFolders: Array.isArray(value.excludeFolders) ? value.excludeFolders.filter(x => typeof x === 'string' && x.trim()) : defaults.excludeFolders,
    generatedFolder: typeof value.generatedFolder === 'string' ? value.generatedFolder.trim().replace(/\\/g, '/').replace(/\/$/, '') || undefined : undefined };
}
export class Cancelled extends Error { constructor() { super('已取消，尚未写入文件。'); } }
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Cancelled(); }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

const mask = (value: string) => value.replace(/[^\n]/g, ' ');
const escapedAt = (text: string, offset: number) => {
  let escapes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) escapes++;
  return Boolean(escapes % 2);
};
function maskSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const span of spans.sort((a,b) => a.start - b.start)) {
    chunks.push(text.slice(cursor, span.start), mask(text.slice(span.start, span.end)));
    cursor = span.end;
  }
  return chunks.join('') + text.slice(cursor);
}

function maskNoteCode(text: string): string {
  let visible = text;
  let fence: { character: string; length: number } | undefined;
  visible = visible.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return mask(line);
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return mask(line); }
    return /^(?: {4}|\t)/.test(line) ? mask(line) : line;
  }).join('\n');
  const ticks = [...visible.matchAll(/`+/g)];
  const spans: Array<{ start: number; end: number }> = [];
  const nextByLength = new Map<number, number>(), next = new Array<number | undefined>(ticks.length);
  for (let i = ticks.length - 1; i >= 0; i--) {
    next[i] = nextByLength.get(ticks[i][0].length);
    nextByLength.set(ticks[i][0].length, i);
  }
  for (let i = 0; i < ticks.length; i++) {
    const end = next[i];
    if (end === undefined) continue;
    spans.push({ start: ticks[i].index!, end: ticks[end].index! + ticks[end][0].length }); i = end;
  }
  return maskSpans(visible, spans);
}

/** Ignore hidden note comments without treating literal delimiters in code as comments. */
export function visibleNoteContent(text: string): string {
  let visible = text.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, mask);
  const spans: Array<{ start: number; end: number }> = [];
  const delimiter = (start: number): number => {
    let index = visible.indexOf('%%', start);
    while (index >= 0 && escapedAt(visible, index)) index = visible.indexOf('%%', index + 2);
    return index;
  };
  for (let cursor = 0; cursor < visible.length;) {
    if (!cursor || visible[cursor - 1] === '\n') {
      const lineEnd = visible.indexOf('\n', cursor), end = lineEnd < 0 ? visible.length : lineEnd + 1;
      const line = visible.slice(cursor, end);
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
      if (fence) {
        cursor = end;
        while (cursor < visible.length) {
          const nextLineEnd = visible.indexOf('\n', cursor), next = nextLineEnd < 0 ? visible.length : nextLineEnd + 1;
          const closing = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(visible.slice(cursor, next));
          cursor = next;
          if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length && !closing[2].trim()) break;
        }
        continue;
      }
      if (/^(?: {4}|\t)/.test(line)) { cursor = end; continue; }
    }
    if (visible[cursor] === '`' && !escapedAt(visible, cursor)) {
      const run = /^`+/.exec(visible.slice(cursor))![0];
      const closing = /`+/g; closing.lastIndex = cursor + run.length;
      let match: RegExpExecArray | null;
      while ((match = closing.exec(visible))) if (match[0].length === run.length) break;
      cursor = match ? match.index + match[0].length : cursor + run.length;
      continue;
    }
    if (visible.startsWith('<!--', cursor)) {
      const close = visible.indexOf('-->', cursor + 4), end = close < 0 ? visible.length : close + 3;
      spans.push({start: cursor, end}); cursor = end; continue;
    }
    if (visible.startsWith('%%', cursor) && !escapedAt(visible, cursor)) {
      const close = delimiter(cursor + 2), end = close < 0 ? visible.length : close + 2;
      spans.push({start: cursor, end}); cursor = end; continue;
    }
    cursor++;
  }
  return maskSpans(visible, spans);
}

/** Native indexing stays authoritative, but stale entries need current, visible evidence. */
export function filterVisibleNoteLinks(text: string, links: NoteLink[]): NoteLink[] {
  const visible = maskNoteCode(visibleNoteContent(text));
  return links.filter(link => {
    if (!link.quote) return false;
    if (link.endOffset !== undefined) {
      const start = link.endOffset - link.quote.length;
      return Number.isInteger(start) && start >= 0 && link.endOffset <= visible.length
        && visible.slice(start, link.endOffset) === link.quote && !escapedAt(visible, start);
    }
    let start = visible.indexOf(link.quote);
    while (start >= 0 && escapedAt(visible, start)) start = visible.indexOf(link.quote, start + 1);
    return start >= 0;
  });
}

export function fallbackNoteLinks(text: string): NoteLink[] {
  const visible = maskNoteCode(visibleNoteContent(text));
  const links: NoteLink[] = [];
  for (const match of visible.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    let escapes = 0;
    for (let i = match.index! - 1; i >= 0 && visible[i] === '\\'; i--) escapes++;
    if (escapes % 2 || text.slice(match.index!, match.index! + match[0].length) !== match[0]) continue;
    const [target, label] = match[1].split('|'); links.push({ target, label, quote: match[0] });
  }
  return links;
}

export async function generateGraph(seed: Seed, adapter: EngineAdapter, rawOptions: Partial<Options>, signal?: AbortSignal, progress = (_message: string) => {}): Promise<KnowledgeGraph> {
  if (!seed.value.trim()) throw new Error('请输入网页地址、知识主题或笔记路径。');
  checkAbort(signal);
  const options = clampOptions(rawOptions), value = seed.value.trim();
  const knownNotes = adapter.listNotes();
  const notesByPath = new Map(knownNotes.map(ref => [ref.path, ref]));
  const underFolder = (path: string, folder: string) => {
    const normalized = folder.trim().replace(/\\/g, '/').replace(/\/$/, '');
    return Boolean(normalized) && (path === normalized || path.startsWith(normalized + '/'));
  };
  const userExcluded = (path: string) => path.split('/').some(p => p.startsWith('.'))
    || options.excludeFolders.some(folder => underFolder(path, folder));
  const graph: KnowledgeGraph = { version: 1, seed: value, createdAt: new Date().toISOString(),
    nodes: [], edges: [], warnings: [], stats: { pagesAttempted: 0, notesScanned: 0, requests: 0 } };
  const root = addNode(graph, { id: nodeId('seed', `${seed.kind}:${value}`), kind: 'seed', title: value,
    excerpt: '自动发现的来源与概念；匹配和提及不表示因果关系。', depth: 0, status: 'derived' });
  const request = async (url: string) => {
    checkAbort(signal);
    if (graph.stats.requests >= options.maxPages * 3 + 12) throw new Error('已达到本次网络请求预算。');
    graph.stats.requests++;
    let abort: (() => void) | undefined;
    try {
      const result = signal ? await Promise.race([adapter.request(publicUrl(url)), new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Cancelled()); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]) : await adapter.request(publicUrl(url));
      checkAbort(signal); return result;
    } finally { if (signal && abort) signal.removeEventListener('abort', abort); }
  };
  let query = value;
  const queue: Array<{ url: string; title?: string; parent: string; relation: Relation; quote: string; depth: number; queryUrl?: string; score: number }> = [];
  const docs = new Map<string, WebDocument>();
  let retainedWebChars = 0;
  const noteBodies = new Map<string, string>();
  const noteLinkSnapshots = new Map<string, NoteLink[]>();
  let filteredWeb = 0;
  const conceptTargets = new Map<string, Set<string>>();
  const enqueueLinks = (source: GraphNode, doc: WebDocument, depth: number) => {
    const links = doc.links.map(link => ({ link, rank: scoreCandidate(query, link.label, link.quote, options) }))
      .filter(item => item.rank.accepted)
      .sort((a, b) => b.rank.score - a.rank.score).slice(0, options.linkLimit);
    for (const { link, rank } of links) queue.push({ url: link.url, title: link.label, parent: source.id,
      relation: 'links_to', quote: link.quote, depth, score: rank.score });
  };
  const linksFor = (path: string): NoteLink[] => {
    if (noteLinkSnapshots.has(path)) return noteLinkSnapshots.get(path)!;
    const text = noteBodies.get(path) ?? '';
    const native = adapter.noteLinks?.(path);
    // Even a native empty list is authoritative. Recheck literal evidence in
    // the analyzed prefix so a stale index cannot invent a source quotation.
    const links = (native === undefined ? fallbackNoteLinks(text) : filterVisibleNoteLinks(text, native))
      .filter(link => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.target.trim()));
    noteLinkSnapshots.set(path, links); return links;
  };
  const addConcepts = (source: GraphNode, labels: Array<{ label: string; quote: string; identity?: string; url?: string }>, text: string, resolveExisting = true) => {
    for (const item of [...labels].sort((a, b) => scoreCandidate(query, b.label, b.quote, options).score - scoreCandidate(query, a.label, a.quote, options).score)) {
      const label = item.label.trim();
      const rank = scoreCandidate(query, label, item.quote, options);
      if (resolveExisting && (rank.reason === 'navigation' || (!rank.accepted && options.readingMode !== 'adaptive'))) filteredWeb++;
      if (!usefulConcept(label) || isNoiseLabel(label) || excludedContent(label, options.excludeTerms)
        || (resolveExisting && rank.reason === 'navigation')
        || (resolveExisting && !rank.accepted && options.readingMode !== 'adaptive')
        || (resolveExisting && normalizeText(label) === normalizeText(source.title)) || !normalizeText(text).includes(normalizeText(label))) continue;
      const resolved = resolveExisting ? adapter.resolveLink(label, source.kind === 'note' ? source.locator! : seed.kind === 'note' ? value : '') : null;
      let ref = resolved ? notesByPath.get(resolved) : undefined;
      if (item.url && ref?.managedId && ref.sourceUrl && publicUrl(ref.sourceUrl) !== publicUrl(item.url)) ref = undefined;
      // A hidden/user-excluded file is neither read nor silently reused.
      if (ref && userExcluded(ref.path)) continue;
      const reused = ref ? graph.nodes.find(n => n.locator === ref.path && (n.kind === 'note' || n.kind === 'concept')) : undefined;
      const id = reused?.id ?? nodeId('concept', ref ? ref.path : item.url ? `url:${publicUrl(item.url)}` : item.identity ?? label);
      if (!graph.nodes.some(n => n.id === id) && graph.nodes.filter(n => n.kind === 'concept').length >= options.maxConcepts) break;
      const concept = reused ?? addNode(graph, { id, kind: 'concept', title: ref?.title ?? label,
        locator: ref?.path, managedId: ref?.managedId,
        ...(ref ? {bodyAvailable:ref.bodyAvailable ?? true} : {}),
        excerpt: ref ? '正文提及的已有笔记；本次未读取该笔记正文，定义与语义关系待核实。' : '来源正文中的术语或链接名称，定义与语义关系待核实。', status: 'derived', depth: source.depth + 1 });
      if (item.url) {
        const targets = conceptTargets.get(concept.id) ?? new Set<string>(); targets.add(publicUrl(item.url)); conceptTargets.set(concept.id, targets);
        concept.entityUrl = targets.size === 1 ? [...targets][0] : undefined;
      }
      addEdge(graph, source.id, concept.id, 'mentions', { sourceId: source.id, quote: excerptAt(item.quote, label, 180), method: '来源文本中出现该名称；不是模型推断' });
    }
  };
  const addNote = (ref: NoteRef, fullText: string, depth: number) => {
    const text = fullText.slice(0, options.maxNoteChars);
    noteBodies.set(ref.path, text);
    if (fullText.length > options.maxNoteChars) graph.warnings.push(`笔记仅分析前 ${options.maxNoteChars} 字符：${ref.path}`);
    const reused = graph.nodes.find(n => n.locator === ref.path && (n.kind === 'note' || n.kind === 'concept'));
    return addNode(graph, { id: reused?.id ?? nodeId('note', ref.path), kind: 'note', title: ref.title, locator: ref.path, managedId: ref.managedId,
      excerpt: excerptAt(visibleNoteContent(text), query, 800),
      retrievedAt: graph.createdAt, status: 'retrieved', depth, truncated: fullText.length > options.maxNoteChars });
  };
  if (seed.kind === 'url') {
    queue.push({ url: publicUrl(value), parent: root.id, relation: 'seed_source', quote: value, depth: 0, score: 100 });
    if (!options.web || options.maxPages < 1) throw new Error('网页起点需要开启公开网页检索，并将网页上限设为至少 1。');
    const first = queue.shift()!;
    graph.stats.pagesAttempted++;
    progress('读取起点网页…');
    const doc = await fetchWebDocument(first.url, request, signal, options.maxBodyChars);
    retainedWebChars += doc.article.textChars;
    const source = addNode(graph, { id: nodeId('web', doc.url), kind: 'web', title: doc.title, sourceTitle: doc.sourceTitle,
      locator: doc.url, excerpt: doc.text.slice(0, 900), article: doc.article, retrievedAt: doc.retrievedAt, depth: 1,
      status: 'retrieved', truncated: doc.truncated });
    root.title = cleanKnowledgeTitle(doc.title);
    docs.set(source.id, doc); query = root.title;
    addEdge(graph, root.id, source.id, 'seed_source', { sourceId: source.id, quote: doc.sourceTitle ?? doc.title, method: '用户指定网页' });
    addConcepts(source, doc.links, doc.text);
    if (doc.truncated) graph.warnings.push(`网页正文已截断：${doc.title}`);
    if (options.depth > 0) enqueueLinks(source, doc, 1);
  } else if (seed.kind === 'note') {
    progress('读取起点笔记…');
    const text = await adapter.readNote(value); checkAbort(signal);
    const ref = notesByPath.get(value) ?? { path: value, title: value.replace(/\.md$/, '').split('/').pop()! };
    query = ref.title; root.title = ref.title;
    const source = addNote(ref, text, 1);
    addEdge(graph, root.id, source.id, 'seed_source', { sourceId: source.id, quote: ref.title, method: '用户指定笔记' });
  }
  if (options.web && options.searchLimit > 0 && options.maxPages > graph.stats.pagesAttempted) {
    const languages = options.searchLanguageMode === 'both' ? [options.wikiLanguage, options.wikiLanguage === 'zh' ? 'en' : 'zh'] : [options.wikiLanguage];
    const candidates = new Map<string, typeof queue[number]>();
    const queries = searchQueries(query, options.searchTerms);
    if (options.searchTerms.length > 4) graph.warnings.push('为限制请求，本次搜索只使用前 4 个补充检索词；筛选仍使用全部词项。');
    for (const language of languages) for (const search of queries) {
      checkAbort(signal); progress(`检索${language === 'zh' ? '中文' : '英文'}百科：${search}…`);
      try {
        const endpoint = `https://${language}.wikipedia.org/w/api.php?` + new URLSearchParams({
          action: 'query', list: 'search', srsearch: search, srnamespace: '0', srprop: 'snippet|redirecttitle',
          srlimit: String(options.searchLimit), srsort: 'relevance', format: 'json', utf8: '1', origin: '*' });
        const response = await request(endpoint);
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const result = JSON.parse(response.text);
        if (result.error) throw new Error(result.error.info ?? '百科搜索失败');
        for (const item of (Array.isArray(result.query?.search) ? result.query.search : []).slice(0, options.searchLimit)) {
          if (typeof item.title !== 'string') continue;
          const title = item.title, snippet = plainSearchSnippet(typeof item.snippet === 'string' ? item.snippet : '');
          const rank = scoreSearchCandidate(query, title, `${snippet} ${typeof item.redirecttitle === 'string' ? item.redirecttitle : ''}`, options);
          if (!rank.accepted) { filteredWeb++; continue; }
          const url = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
          const candidate = { url, title, parent: root.id, relation: 'search_match' as const,
            quote: `检索词：${search}；API 返回标题：${title}${rank.expandedTerm ? '；按核心词匹配：' + rank.expandedTerm : ''}${snippet ? '；API 摘要：' + snippet : ''}`,
            depth: 0, queryUrl: endpoint, score: rank.score + (language === options.wikiLanguage ? 0.1 : 0) };
          if (!candidates.has(url) || candidates.get(url)!.score < candidate.score) candidates.set(url, candidate);
        }
      } catch (e) { checkAbort(signal); graph.warnings.push(`公开百科检索失败（${language}，${search}）：${errorText(e)}`); }
    }
    const selected = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, options.searchLimit);
    queue.push(...selected);
    if (!selected.length) graph.warnings.push(`公开百科未找到通过筛选的“${query}”；可补充检索词、放宽筛选或切换语言。`);
  }
  const visited = new Set([...docs.values()].map(d => d.url));
  while (queue.length && graph.stats.pagesAttempted < options.maxPages) {
    checkAbort(signal);
    if (MAX_TOTAL_WEB_CHARS - retainedWebChars < 2000) {
      graph.warnings.push('已达到本次 400 万网页正文字符容量；停止读取后续网页，可拆分探索任务。'); break;
    }
    queue.sort((a, b) => Number(b.relation === 'search_match') - Number(a.relation === 'search_match') || b.score - a.score || a.depth - b.depth);
    const item = queue.shift()!;
    let url: string;
    try { url = publicUrl(item.url); } catch { continue; }
    if (visited.has(url)) {
      const existing = graph.nodes.find(n => n.locator === url);
      if (existing) addEdge(graph, item.parent, existing.id, item.relation, { sourceId: item.relation === 'links_to' ? item.parent : existing.id, quote: excerptAt(item.quote, item.title ?? '', 180), locator: item.queryUrl, method: item.relation === 'links_to' ? '正文超链接' : '百科搜索 API 返回记录，非网页原文（相关性待确认）' });
      continue;
    }
    visited.add(url); graph.stats.pagesAttempted++;
    progress(`读取网页 ${graph.stats.pagesAttempted}/${options.maxPages}：${item.title ?? url}…`);
    try {
      const doc = await fetchWebDocument(url, request, signal, options.maxBodyChars, Math.min(1_000_000, MAX_TOTAL_WEB_CHARS - retainedWebChars)); checkAbort(signal);
      const rank = item.relation === 'search_match'
        ? scoreSearchCandidate(query, doc.title, doc.text, options)
        : scoreCandidate(query, doc.title, doc.text, options, 'search');
      if (rank.reason === 'navigation' || excludedContent(doc.title, options.excludeTerms)
        || (item.relation === 'search_match' && !rank.accepted)
        || (item.relation === 'links_to' && options.relevance === 'strict' && !rank.accepted)) { filteredWeb++; continue; }
      const source = addNode(graph, { id: nodeId('web', doc.url), kind: 'web', title: doc.title, sourceTitle: doc.sourceTitle, locator: doc.url,
        excerpt: doc.text.slice(0, 900), article: doc.article, retrievedAt: doc.retrievedAt, depth: item.depth + 1, status: 'retrieved', truncated: doc.truncated });
      docs.set(source.id, doc);
      retainedWebChars += doc.article.textChars;
      addEdge(graph, item.parent, source.id, item.relation, { sourceId: item.relation === 'links_to' ? item.parent : source.id,
        quote: excerptAt(item.quote, item.title ?? '', 180), locator: item.queryUrl, method: item.relation === 'links_to' ? '正文超链接' : '百科搜索 API 返回记录，非网页原文（相关性待确认）' });
      addConcepts(source, doc.links, doc.text);
      if (doc.truncated) graph.warnings.push(`网页正文已截断：${doc.title}`);
      if (item.depth < options.depth) enqueueLinks(source, doc, item.depth + 1);
    } catch (e) { checkAbort(signal); graph.warnings.push(`网页读取失败 ${url}：${errorText(e)}`); }
  }
  // Follow actual note links breadth-first. Explicit links may cross the
  // automatic generated-folder exclusion, never user exclusions or budgets.
  const selectedNotes = new Set<string>(), inspected = new Set<string>();
  const readBodies = new Map<string, string>();
  let scanAttempts = 0, filteredNotes = 0;
  const frontier: Array<{ path: string; hop: number }> = [];
  if (seed.kind === 'note') { selectedNotes.add(value); inspected.add(value); frontier.push({ path: value, hop: 0 }); }
  const selectedCount = () => selectedNotes.size - (seed.kind === 'note' ? 1 : 0);
  const readCandidate = async (ref: NoteRef): Promise<string | undefined> => {
    if (readBodies.has(ref.path)) return readBodies.get(ref.path);
    if (inspected.has(ref.path) || scanAttempts >= options.scanLimit) return undefined;
    inspected.add(ref.path); scanAttempts++; checkAbort(signal);
    try {
      const text = await adapter.readNote(ref.path); checkAbort(signal); graph.stats.notesScanned++;
      readBodies.set(ref.path, text);
      if (text.length > options.maxNoteChars) graph.warnings.push(`扫描仅使用前 ${options.maxNoteChars} 字符：${ref.path}`);
      return text;
    } catch (e) { checkAbort(signal); graph.warnings.push(`笔记读取失败 ${ref.path}：${errorText(e)}`); return undefined; }
  };
  const traverse = async () => {
    while (frontier.length && selectedCount() < options.maxNotes && scanAttempts < options.scanLimit) {
      checkAbort(signal);
      const current = frontier.shift()!;
      if (current.hop >= options.depth) continue;
      const links = linksFor(current.path).map(link => ({ link, path: adapter.resolveLink(link.target.split('#')[0].trim(), current.path) }))
        .filter(item => item.path && notesByPath.has(item.path) && !userExcluded(item.path)
          && !excludedContent(notesByPath.get(item.path)!.title, options.excludeTerms))
        .slice(0, options.linkLimit);
      for (const { path } of links) {
        if (!path || selectedNotes.has(path) || selectedCount() >= options.maxNotes || scanAttempts >= options.scanLimit) continue;
        const ref = notesByPath.get(path)!;
        if (excludedContent(ref.title, options.excludeTerms)) { filteredNotes++; continue; }
        const text = await readCandidate(ref);
        if (text === undefined) continue;
        addNote(ref, text, current.hop + 2); selectedNotes.add(path);
        frontier.push({ path, hop: current.hop + 1 });
      }
    }
  };
  await traverse();
  const allNotes = knownNotes.filter(ref => !userExcluded(ref.path) && !selectedNotes.has(ref.path)
    && (!options.generatedFolder || !underFolder(ref.path, options.generatedFolder))
    && !excludedContent(ref.title, options.excludeTerms));
  allNotes.sort((a, b) => scoreCandidate(query, b.title, '', options, 'note').score
    - scoreCandidate(query, a.title, '', options, 'note').score || a.path.localeCompare(b.path));
  const ranked: Array<{ ref: NoteRef; text: string; score: number }> = [];
  if (options.maxNotes > selectedCount()) {
    progress(`在已有笔记中寻找相关内容（扫描预算 ${options.scanLimit} 篇）…`);
    for (const ref of allNotes) {
      if (scanAttempts >= options.scanLimit) break;
      const text = await readCandidate(ref);
      if (text === undefined) continue;
      const rank = scoreCandidate(query, ref.title, visibleNoteContent(text.slice(0, options.maxNoteChars)), options, 'note');
      // Broad mode still requires a lexical signal for a vault keyword match;
      // explicit real links are the path for deliberately unrelated neighbors.
      if (rank.accepted && rank.score > 0) ranked.push({ ref, text, score: rank.score });
      else filteredNotes++;
    }
    if (scanAttempts >= options.scanLimit && allNotes.some(ref => !inspected.has(ref.path)))
      graph.warnings.push(`仅扫描了 ${scanAttempts}/${allNotes.length + selectedCount()} 篇候选笔记；未检索其余笔记。`);
    ranked.sort((a, b) => b.score - a.score || a.ref.path.localeCompare(b.ref.path));
    for (const item of ranked.slice(0, options.maxNotes - selectedCount())) {
      const source = addNote(item.ref, item.text, 1); selectedNotes.add(item.ref.path);
      const titleMatch = scoreCandidate(query, item.ref.title, '', options, 'note').score > 0;
      const evidenceTerm = [query, ...options.searchTerms].find(term => normalizeText(`${item.ref.title}\n${item.text.slice(0, options.maxNoteChars)}`).includes(normalizeText(term))) ?? query;
      addEdge(graph, root.id, source.id, 'keyword_match', { sourceId: source.id,
        quote: titleMatch ? item.ref.title : excerptAt(visibleNoteContent(item.text.slice(0, options.maxNoteChars)), evidenceTerm, 180),
        method: `${titleMatch ? '笔记标题' : '前 ' + options.maxNoteChars + ' 字符正文'}词项匹配，筛选得分 ${item.score.toFixed(1)}，相关性待确认` });
      frontier.push({ path: item.ref.path, hop: 0 });
    }
    await traverse();
  }
  if (frontier.some(item => item.hop < options.depth) && (scanAttempts >= options.scanLimit || selectedCount() >= options.maxNotes))
    graph.warnings.push(`本地沿链扩展达到${scanAttempts >= options.scanLimit ? '扫描' : '笔记'}预算；尚有链接未继续读取。`);
  // Resolve native internal links (including Markdown links) between selected notes.
  for (const source of graph.nodes.filter(n => n.kind === 'note')) {
    const text = noteBodies.get(source.locator!) ?? '';
    for (const link of linksFor(source.locator!)) {
      const target = link.target.split('#')[0].trim();
      if (!target) continue;
      const path = adapter.resolveLink(target, source.locator!);
      const destination = graph.nodes.find(n => n.kind === 'note' && n.locator === path);
      if (destination) addEdge(graph, source.id, destination.id, 'wiki_link', { sourceId: source.id, quote: link.quote, method: '已存在的 Obsidian 内部链接' });
      // A resolvable real file remains that file even when selection limits
      // exclude it; never create a concept clone under its name or alias.
      // A wikilink alias is display text, not another target to resolve. Keep
      // unresolved concepts identified by their raw target, including folders.
      if (!path) addConcepts(source, [{ label: link.label?.trim() || target.split('/').pop()!, quote: link.quote, identity: target }], text, false);
    }
  }
  if (!graph.nodes.some(n => n.status === 'retrieved')) graph.warnings.push('未成功获取任何来源；本次只有起点。请检查网络、关键词和笔记范围。');
  if (filteredWeb || filteredNotes) graph.warnings.push(`词项与排除规则筛除了 ${filteredWeb} 条网页或术语候选、${filteredNotes} 篇笔记候选；筛选为词面规则，不是语义核验。`);
  if (options.relevance === 'strict' && !graph.nodes.some(node => node.kind === 'concept') && graph.nodes.some(node => node.kind === 'web'))
    graph.warnings.push('聚焦模式未保留术语候选；可添加明确的相关检索词或切换平衡模式。已读取来源与起点关系仍保留。');
  const consolidated = coalesceGraph(graph);
  checkAbort(signal); progress(`发现 ${consolidated.nodes.length} 个节点、${consolidated.edges.length} 条关系，等待预览。`);
  return consolidated;
}
