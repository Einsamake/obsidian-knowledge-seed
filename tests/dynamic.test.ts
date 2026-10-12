import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { Cancelled, generateGraph, type EngineAdapter } from '../src/engine';
import { completeDynamic, discoverDynamic, dynamicReadingBudgets } from '../src/dynamic';
import { addEdge, nodeId, type GraphNode, type KnowledgeGraph } from '../src/graph';

Object.assign(globalThis, { DOMParser });

const mainUrl = 'https://example.org/subject';
const childUrl = 'https://example.org/child';
function html(title: string, links: Array<{ url: string; label: string }> = [], lead?: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${lead ?? `${title}是知识研究中的一个概念，具有独立的定义和相关背景。本文保留详细正文与来源，让读者能够核查内容的真实性并获得进一步的信息。真实来源材料比词面相似更重要，不能根据简称随意混合不同领域的知识。`}</p>
    ${links.map(link => `<p>本文进一步介绍<a href="${link.url}">${link.label}</a>的基本定义和方法，相关材料与出处可以帮助读者深入了解这个被提及的概念。</p>`).join('')}</article></body></html>`;
}
function fixture(config: { pages?: Record<string, string>; notes?: Record<string, string>; search?: (query: string) => Array<{ title: string; redirecttitle?: string; snippet?: string }>; request?: (url: string) => Promise<{ status: number; text: string }> } = {}) {
  const requests: string[] = [];
  const notes = config.notes ?? {};
  const adapter: EngineAdapter = {
    request: async url => {
      requests.push(url);
      if (config.request) return config.request(url);
      if (url.includes('/w/api.php?')) return { status: 200, text: JSON.stringify({ query: { search: config.search?.(new URL(url).searchParams.get('srsearch') ?? '') ?? [] } }) };
      return { status: config.pages?.[url] ? 200 : 404, text: config.pages?.[url] ?? '', headers: { 'content-type': 'text/html' } };
    },
    listNotes: () => Object.keys(notes).map(path => ({ path, title: path.replace(/\.md$/, '').split('/').pop()! })),
    readNote: async path => notes[path], resolveLink: () => null
  };
  return { adapter, requests };
}
function graphWithConcept(title = '协方差', url?: string): KnowledgeGraph {
  const graph: KnowledgeGraph = { version: 1, seed: '统计学习', createdAt: '2026-10-08T00:00:00.000Z', nodes: [
    { id: 'seed-root', kind: 'seed', title: '统计学习', excerpt: '', status: 'derived', depth: 0 },
    { id: 'source-note', kind: 'note', title: '统计学习', locator: '统计学习.md', bodyAvailable: true, excerpt: '来源正文', status: 'retrieved', depth: 1 },
    { id: 'concept-pending', managedId: 'concept-original-owner', kind: 'concept', title, entityUrl: url,
      excerpt: '来源正文中的术语或链接名称，定义与语义关系待核实。', status: 'derived', depth: 2,
      reading: { state: 'pending', reason: '等待补全。' } }
  ], edges: [], warnings: [], stats: { requests: 0, notesScanned: 0, pagesAttempted: 0 } };
  addEdge(graph, 'source-note', 'concept-pending', 'mentions', { sourceId: 'source-note', quote: `统计学习正文提及${title}及其定义。`, method: '已有正文提及' });
  return graph;
}
function validEdges(graph: KnowledgeGraph): void {
  const ids = new Set(graph.nodes.map(node => node.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); assert.notEqual(edge.from, edge.to);
    for (const evidence of edge.evidence) { assert.ok(ids.has(evidence.sourceId)); assert.ok(evidence.quote.trim()); }
  }
}

test('adaptive source links are read before any broad seed search and retain unrelated useful names', async () => {
  const mock = fixture({ pages: { [mainUrl]: html('统计学习', [{ url: childUrl, label: '协方差' }]), [childUrl]: html('协方差') } });
  const snapshots: KnowledgeGraph[] = [];
  const graph = await discoverDynamic({ kind: 'url', value: mainUrl }, mock.adapter, { maxPages: 1, depth: 0, maxConcepts: 0, maxBodyChars: 2000, readingPace: 'fast' }, undefined, undefined, { onSnapshot: snapshot => snapshots.push(snapshot) });
  assert.deepEqual(mock.requests, [mainUrl, childUrl]);
  assert.ok(snapshots[0].nodes.some(node => node.kind === 'web' && node.article));
  assert.ok(snapshots[0].nodes.some(node => node.title === '协方差' && node.reading?.state === 'pending'));
  assert.ok(graph.nodes.some(node => node.title === '协方差' && node.reading?.state === 'ready' && node.article));
  assert.equal(graph.nodes.filter(node => node.title === '协方差').length, 1);
  assert.equal(graph.reading?.stopReason, 'complete'); validEdges(graph);
});

test('individual term lookup uses source title context, then coalesces only exact verified URL identity', async () => {
  const page = 'https://zh.wikipedia.org/wiki/%E5%8D%8F%E6%96%B9%E5%B7%AE';
  const mock = fixture({ search: () => [{ title: '协方差' }, { title: '数学分析' }], pages: { [page]: html('协方差') } });
  const original = graphWithConcept(); const before = JSON.stringify(original);
  const graph = await completeDynamic(original, mock.adapter, { readingPace: 'fast' });
  assert.match(new URL(mock.requests[0]).searchParams.get('srsearch')!, /协方差.*统计学习/);
  assert.equal(mock.requests.filter(url => !url.includes('/w/api.php?')).length, 1);
  const body = graph.nodes.find(node => node.title === '协方差')!;
  assert.equal(body.kind, 'web'); assert.equal(body.locator, page);
  assert.equal(body.managedId, 'concept-original-owner');
  assert.ok(body.mergedIds?.includes('concept-pending'));
  assert.ok(graph.edges.some(edge => edge.to === body.id && edge.evidence[0].quote.includes('协方差')));
  assert.equal(JSON.stringify(original), before); validEdges(graph);
});

test('plausible nonexact lookup matches are not attached to an unknown concept', async () => {
  const mock = fixture({ search: () => [{ title: '统计学', snippet: '包含协方差的基本定义与公式。' }] });
  const graph = await completeDynamic(graphWithConcept(), mock.adapter, { readingPace: 'fast' });
  assert.ok(mock.requests.every(url => url.includes('/w/api.php?')));
  const target = graph.nodes.find(node => node.id === 'concept-pending')!;
  assert.equal(target.reading?.state, 'no_match'); assert.equal(target.entityUrl, undefined);
  assert.equal(graph.nodes.filter(node => node.kind === 'web').length, 0);
});

test('ambiguous redirected abbreviation is not resolved by first search hit', async () => {
  const mock = fixture({ search: () => [{ title: '主成分分析', redirecttitle: 'PCA' }, { title: '常设仲裁法院', redirecttitle: 'PCA' }] });
  const graph = await completeDynamic(graphWithConcept('PCA'), mock.adapter, { readingPace: 'fast' });
  assert.equal(mock.requests.length, 1);
  assert.equal(graph.nodes.find(node => node.title === 'PCA')!.reading?.state, 'no_match');
});

test('an abbreviation disambiguation source remains readable but automatic unrelated meanings wait for explicit selection', async () => {
  const page = 'https://zh.wikipedia.org/wiki/PCA';
  const lead = 'PCA可以指：不同专业领域中的多种名称，需要根据上下文判断具体含义。这里保留消歧义页面作为来源，并允许读者选择想要了解的实际概念，而不是将所有含义混合在同一个知识领域。';
  const mock = fixture({ search: () => [{ title: 'PCA' }], pages: { [page]: html('PCA', [{ url: childUrl, label: '常设仲裁法院' }], lead), [childUrl]: html('常设仲裁法院') } });
  const graph = await discoverDynamic({ kind: 'topic', value: 'PCA' }, mock.adapter, { readingPace: 'fast' });
  assert.ok(graph.nodes.some(node => node.title === 'PCA' && node.article));
  const target = graph.nodes.find(node => node.title === '常设仲裁法院')!;
  assert.equal(target.reading?.state, 'pending'); assert.match(target.reading!.reason!, /消歧义/);
  assert.ok(!mock.requests.includes(childUrl));
  const finished = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' }, undefined, undefined, { targetIds: [target.id] });
  assert.ok(finished.nodes.some(node => node.title === '常设仲裁法院' && node.article));
});

test('stop-now returns finished sources and pending statuses without late snapshot or graph mutation', async () => {
  let finish = false;
  let release!: (result: { status: number; text: string }) => void;
  const pending = new Promise<{ status: number; text: string }>(resolve => { release = resolve; });
  const mock = fixture({ request: async () => { setTimeout(() => { finish = true; }, 10); return pending; } });
  const snapshots: KnowledgeGraph[] = [];
  const graph = await completeDynamic(graphWithConcept('协方差', childUrl), mock.adapter, { readingPace: 'fast' }, undefined, undefined,
    { shouldFinish: () => finish, onSnapshot: snapshot => snapshots.push(snapshot) });
  assert.equal(graph.reading?.stopReason, 'requested');
  assert.equal(graph.nodes.find(node => node.id === 'concept-pending')!.reading?.state, 'pending');
  const before = JSON.stringify(graph); const count = snapshots.length;
  release({ status: 200, text: html('协方差') }); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(JSON.stringify(graph), before); assert.equal(snapshots.length, count);
});

test('pace deadline returns existing content and discards a transport response after timeout', async t => {
  let release!: (result: { status: number; text: string }) => void;
  const pending = new Promise<{ status: number; text: string }>(resolve => { release = resolve; });
  let elapsed = 0;
  const current = Date.now();
  t.mock.method(Date, 'now', () => current + elapsed);
  const mock = fixture({ request: async () => { elapsed = dynamicReadingBudgets.fast.milliseconds + 1; return pending; } });
  const graph = await completeDynamic(graphWithConcept('协方差', childUrl), mock.adapter, { readingPace: 'fast' });
  assert.equal(graph.reading?.stopReason, 'time');
  assert.ok(graph.nodes.some(node => node.id === 'source-note'));
  assert.equal(graph.nodes.find(node => node.id === 'concept-pending')!.reading?.state, 'pending');
  release({ status: 200, text: html('协方差') }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(graph.nodes.filter(node => node.kind === 'web').length, 0);
});

test('Escape-style abort discards the entire operation instead of returning a partial success', async () => {
  const controller = new AbortController();
  const mock = fixture({ request: async () => { controller.abort(); return new Promise(() => {}); } });
  await assert.rejects(completeDynamic(graphWithConcept('协方差', childUrl), mock.adapter, { readingPace: 'fast' }, controller.signal), Cancelled);
});

test('targeted retry fetches one failed node and leaves unrelated pending descendants unread', async () => {
  const graph = graphWithConcept('协方差', childUrl);
  graph.nodes.find(node => node.id === 'concept-pending')!.reading = { state: 'failed', reason: 'HTTP 503' };
  graph.nodes.push({ id: 'unrelated', kind: 'concept', title: '矩阵', excerpt: '', status: 'derived', depth: 2, entityUrl: 'https://example.org/matrix', reading: { state: 'pending' } });
  const mock = fixture({ pages: { [childUrl]: html('协方差', [{ url: 'https://example.org/inner-product', label: '内积' }]) } });
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'deep' }, undefined, undefined, { targetIds: ['concept-pending'] });
  assert.deepEqual(mock.requests, [childUrl]);
  assert.equal(result.nodes.find(node => node.id === 'unrelated')!.reading?.state, 'pending');
  assert.equal(result.nodes.find(node => node.title === '内积')!.reading?.state, 'pending');
  assert.equal(result.nodes.find(node => node.title === '协方差')!.reading?.state, 'ready');
});

test('continuation skips readable existing URL sources and snapshots cannot mutate internal state', async () => {
  const graph = graphWithConcept('协方差', childUrl);
  graph.nodes.push({ id: nodeId('web', childUrl), kind: 'web', title: '协方差', locator: childUrl, excerpt: '实际正文',
    status: 'retrieved', depth: 2, article: { blocks: [{ type: 'paragraph', text: '实际正文' }], textChars: 4, totalTextChars: 4, truncated: false } });
  const mock = fixture();
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' }, undefined, undefined,
    { onSnapshot: snapshot => { snapshot.nodes.length = 0; snapshot.warnings.push('恶意修改'); } });
  assert.deepEqual(mock.requests, []);
  assert.ok(result.nodes.some(node => node.kind === 'web'));
  assert.ok(!result.warnings.includes('恶意修改')); validEdges(result);
});

test('adaptive term extraction relaxes seed word gating while manual behavior remains unchanged', async () => {
  const mock = fixture({ pages: { [mainUrl]: html('统计学习', [{ url: childUrl, label: '协方差' }, { url: 'https://example.org/english', label: 'English' }]) } });
  // The quote intentionally mentions a subject without containing the seed words.
  const manual = await generateGraph({ kind: 'url', value: mainUrl }, mock.adapter, { maxPages: 1, depth: 0, readingMode: 'manual' });
  const adaptive = await generateGraph({ kind: 'url', value: mainUrl }, mock.adapter, { maxPages: 1, depth: 0, readingMode: 'adaptive' });
  assert.ok(!manual.nodes.some(node => node.title === '协方差'));
  assert.ok(adaptive.nodes.some(node => node.title === '协方差'));
  assert.ok(!adaptive.nodes.some(node => node.title === 'English'));
});

test('source-less empty managed note seed is enriched by its title and keeps reviewed source assignment metadata', async () => {
  const page = 'https://zh.wikipedia.org/wiki/%E5%8D%8F%E6%96%B9%E5%B7%AE';
  const path = 'Knowledge Seed/概念/协方差.md';
  const mock = fixture({ notes: { [path]: '---\nknowledge_seed_id: concept-old-owner\nkind: concept\n---\n\n# 协方差\n\n来源正文中的术语或链接名称，定义与语义关系待核实。' }, search: () => [{ title: '协方差' }], pages: { [page]: html('协方差') } });
  mock.adapter.listNotes = () => [{ path, title: '协方差', managedId: 'concept-old-owner', bodyAvailable: false }];
  const graph = await discoverDynamic({ kind: 'note', value: path }, mock.adapter, { readingPace: 'fast', generatedFolder: 'Knowledge Seed' });
  assert.equal(graph.nodes.find(node => node.kind === 'seed')!.title, '协方差');
  const source = graph.nodes.find(node => node.kind === 'web')!;
  assert.equal(source.title, '协方差'); assert.equal(source.managedId, 'concept-old-owner');
  assert.equal(source.sourceResolution?.term, '协方差');
  assert.match(source.sourceResolution!.queryUrl, /^https:\/\/zh\.wikipedia\.org\/w\/api\.php\?/);
  assert.equal(graph.nodes.filter(node => node.title === '协方差' && node.kind !== 'seed').length, 1); validEdges(graph);
});

test('supplementary context source stays separate from an ambiguous root', async () => {
  const mock = fixture({ search: query => query.includes('主成分分析') ? [{ title: '主成分分析' }] : [{ title: 'PCA' }], pages: {
    'https://zh.wikipedia.org/wiki/PCA': html('PCA', [], 'PCA可以指：不同专业领域中的多种名称，需要根据上下文判断具体含义。这里保留消歧义页面作为来源，并允许读者选择想要了解的实际概念，而不是将所有含义混合在同一个知识领域。'),
    'https://zh.wikipedia.org/wiki/%E4%B8%BB%E6%88%90%E5%88%86%E5%88%86%E6%9E%90': html('主成分分析')
  } });
  const graph = await discoverDynamic({ kind: 'topic', value: 'PCA' }, mock.adapter, { readingPace: 'fast', searchTerms: ['主成分分析'] });
  const sources = graph.nodes.filter(node => node.kind === 'web');
  assert.deepEqual(sources.map(node => node.title).sort(), ['PCA', '主成分分析']);
  assert.ok(sources.every(node => !node.mergedIds?.length));
  assert.equal(graph.nodes.find(node => node.kind === 'seed')!.reading?.state, 'no_match'); validEdges(graph);
});

test('stop during local scan suppresses late progress callbacks and snapshot mutation', async () => {
  let finish = false; let resolveRead!: (text: string) => void;
  const read = new Promise<string>(resolve => { resolveRead = resolve; });
  const mock = fixture({ notes: { '统计学习.md': '统计学习' } });
  mock.adapter.readNote = async () => { setTimeout(() => { finish = true; }, 10); return read; };
  const messages: string[] = [];
  const result = await discoverDynamic({ kind: 'topic', value: '统计学习' }, mock.adapter, { web: false }, undefined,
    message => messages.push(message), { shouldFinish: () => finish });
  const count = messages.length; const before = JSON.stringify(result);
  resolveRead('统计学习正文。'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(result.reading?.stopReason, 'requested'); assert.equal(messages.length, count); assert.equal(JSON.stringify(result), before);
});

test('a requested continuation retries failures but retains ambiguity until a specific target is selected', async () => {
  const graph = graphWithConcept('协方差', childUrl);
  graph.nodes.find(node => node.id === 'concept-pending')!.reading = { state: 'failed', reason: 'HTTP 503' };
  graph.nodes.push({ id: 'ambiguous', kind: 'concept', title: 'PCA', entityUrl: 'https://example.org/ambiguous', excerpt: '', status: 'derived', depth: 2,
    reading: { state: 'no_match', reason: '对应页面包含多个含义，请补充领域词或指定具体来源。' } });
  const mock = fixture({ pages: { [childUrl]: html('协方差') } });
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' });
  assert.deepEqual(mock.requests, [childUrl]);
  assert.equal(result.nodes.find(node => node.title === '协方差')!.reading?.state, 'ready');
  assert.equal(result.nodes.find(node => node.id === 'ambiguous')!.reading?.state, 'no_match');
});

test('repeated continuation can advance beyond the first pass internal exploration depth', async () => {
  const pages: Record<string, string> = {};
  for (let index = 0; index < 6; index++) pages[`https://example.org/level-${index}`] = html(`层级概念${index}`,
    index < 5 ? [{ url: `https://example.org/level-${index + 1}`, label: `层级概念${index + 1}` }] : []);
  const mock = fixture({ pages });
  const first = await discoverDynamic({ kind: 'url', value: 'https://example.org/level-0' }, mock.adapter, { readingPace: 'fast' });
  assert.equal(first.nodes.find(node => node.title === '层级概念3')!.reading?.state, 'pending');
  const second = await completeDynamic(first, mock.adapter, { readingPace: 'fast' });
  assert.equal(second.nodes.find(node => node.title === '层级概念3')!.reading?.state, 'ready');
  assert.ok(second.nodes.filter(node => node.kind === 'web').length > first.nodes.filter(node => node.kind === 'web').length);
  assert.equal(mock.requests.filter(url => url === 'https://example.org/level-0').length, 1);
});

test('adaptive bodies preserve more than two thousand characters and whole paragraphs regardless of legacy body target', async () => {
  const paragraph = '这是一段完整而且需要保留的源文知识说明，内容具有可追溯来源，段落不会被截成片段。'.repeat(25);
  const body = `<!doctype html><html><head><title>完整正文</title></head><body><article><h1>完整正文</h1>${Array.from({ length: 4 }, () => `<p>${paragraph}</p>`).join('')}</article></body></html>`;
  const mock = fixture({ pages: { [mainUrl]: body } });
  const graph = await discoverDynamic({ kind: 'url', value: mainUrl }, mock.adapter, { readingPace: 'fast', maxBodyChars: 2000 });
  const article = graph.nodes.find(node => node.kind === 'web')!.article!;
  assert.ok(article.textChars > 2000); assert.equal(article.truncated, false);
  assert.equal(article.blocks.filter(block => block.type === 'paragraph').length, 4);
  for (const block of article.blocks.filter(block => block.type === 'paragraph')) assert.equal(block.text, paragraph);
});

test('URL discovery ranks by the article topic and keeps useful pending names while omitting navigation and identifiers', async () => {
  const branch = 'https://example.org/branch', focused = 'https://example.org/focused';
  const mock = fixture({ pages: {
    [mainUrl]: html('预测编码', [{ url: branch, label: '烹饪方法' }, { url: focused, label: '预测编码理论' },
      { url: 'https://example.org/language', label: 'English' }, { url: 'https://doi.org/10.1038/s41583-020-00396-5', label: '10.1038/s41583-020-00396-5' }]),
    [focused]: html('预测编码理论'), [branch]: html('烹饪方法')
  } });
  let finish = false; const snapshots: KnowledgeGraph[] = [];
  const graph = await discoverDynamic({ kind: 'url', value: mainUrl }, mock.adapter, { readingPace: 'fast' }, undefined, undefined,
    { shouldFinish: () => finish, onSnapshot: snapshot => { snapshots.push(snapshot); if (snapshot.nodes.some(node => node.article && node.title === '预测编码理论')) finish = true; } });
  assert.deepEqual(mock.requests, [mainUrl, focused]);
  assert.ok(snapshots[0].nodes.some(node => node.title === '烹饪方法' && node.reading?.state === 'pending'));
  assert.ok(graph.nodes.some(node => node.title === '烹饪方法' && node.reading?.state === 'pending'));
  assert.ok(!graph.nodes.some(node => node.title === 'English' || node.title.startsWith('10.1038'))); validEdges(graph);
});

test('reading prioritizes a shallow concept lookup before a deeper linked branch', async () => {
  const graph = graphWithConcept();
  const deeper = 'https://example.org/deeper';
  graph.nodes.push({ id: 'deeper', kind: 'concept', title: '统计学习理论', entityUrl: deeper, excerpt: '', status: 'derived', depth: 3,
    reading: { state: 'pending' } });
  const page = 'https://zh.wikipedia.org/wiki/%E5%8D%8F%E6%96%B9%E5%B7%AE';
  const mock = fixture({ search: () => [{ title: '协方差' }], pages: { [page]: html('协方差'), [deeper]: html('统计学习理论') } });
  let finish = false;
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' }, undefined, undefined,
    { shouldFinish: () => finish, onSnapshot: snapshot => { if (snapshot.nodes.some(node => node.title === '协方差' && node.article)) finish = true; } });
  assert.match(mock.requests[0], /\/w\/api\.php\?/);
  assert.equal(mock.requests[1], page); assert.ok(!mock.requests.includes(deeper));
  assert.equal(result.nodes.find(node => node.id === 'deeper')!.reading?.state, 'pending');
});

test('multi-source mentions take priority over a same-depth incidental link', async () => {
  const graph = graphWithConcept('矩阵', 'https://example.org/matrix');
  graph.nodes.push({ id: 'source-two', kind: 'note', title: '另一份笔记', locator: '第二.md', bodyAvailable: true,
    excerpt: '', status: 'retrieved', depth: 1 });
  graph.nodes.push({ id: 'shared', kind: 'concept', title: '协方差', entityUrl: childUrl, excerpt: '', status: 'derived', depth: 2, reading: { state: 'pending' } });
  addEdge(graph, 'source-note', 'shared', 'mentions', { sourceId: 'source-note', quote: '正文讨论协方差。', method: '明确提及' });
  addEdge(graph, 'source-two', 'shared', 'mentions', { sourceId: 'source-two', quote: '另一篇正文也讨论协方差。', method: '明确提及' });
  // Equal lexical scores; corroborating mentions control priority without
  // asserting semantic importance or inventing an edge.
  graph.edges[0].evidence[0].quote = '正文讨论矩阵。';
  const mock = fixture({ pages: { [childUrl]: html('协方差') } }); let finish = false;
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' }, undefined, undefined,
    { shouldFinish: () => finish, onSnapshot: snapshot => { if (snapshot.nodes.some(node => node.title === '协方差' && node.article)) finish = true; } });
  assert.deepEqual(mock.requests, [childUrl]); assert.equal(result.nodes.find(node => node.title === '矩阵')!.reading?.state, 'pending');
});

test('repeated unsuccessful title lookups share requests within a pass and explicit retry remains available', async () => {
  const graph = graphWithConcept();
  graph.nodes.push({ id: 'another-owner', kind: 'concept', title: '协方差', locator: '另一处/协方差.md', managedId: 'another-owner',
    bodyAvailable: false, excerpt: '', status: 'derived', depth: 2, reading: { state: 'pending' } });
  addEdge(graph, 'source-note', 'another-owner', 'mentions', { sourceId: 'source-note', quote: '统计学习提及协方差。', method: '明确提及' });
  const mock = fixture();
  const first = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' });
  assert.equal(mock.requests.length, 2);
  assert.equal(first.nodes.filter(node => node.reading?.state === 'no_match').length, 2);
  await completeDynamic(first, mock.adapter, { readingPace: 'fast' });
  assert.equal(mock.requests.length, 4);
});

test('a failed contextual query safely falls back while preserving exact source identity', async () => {
  const page = 'https://zh.wikipedia.org/wiki/%E5%8D%8F%E6%96%B9%E5%B7%AE';
  const mock = fixture({ request: async url => {
    if (!url.includes('/w/api.php?')) return { status: 200, text: html('协方差') };
    const query = new URL(url).searchParams.get('srsearch')!;
    return query.includes('统计学习') ? { status: 503, text: '' } : { status: 200, text: JSON.stringify({ query: { search: [{ title: '协方差' }] } }) };
  } });
  const result = await completeDynamic(graphWithConcept(), mock.adapter, { readingPace: 'fast' });
  assert.equal(mock.requests.length, 3); assert.equal(mock.requests[2], page);
  assert.equal(result.nodes.find(node => node.title === '协方差')!.reading?.state, 'ready');
});

test('search service failure is distinguishable from a confirmed empty search', async () => {
  const mock = fixture({ request: async () => ({ status: 429, text: '' }) });
  const result = await completeDynamic(graphWithConcept(), mock.adapter, { readingPace: 'fast' });
  assert.equal(mock.requests.length, 2);
  const target = result.nodes.find(node => node.id === 'concept-pending')!;
  assert.equal(target.reading?.state, 'failed'); assert.match(target.reading!.reason!, /检索未完成.*429/);
});

test('explicit disambiguation source keeps actual body but marks its unresolved meaning', async () => {
  const lead = 'PCA可以指：不同专业领域中的多种名称，需要根据上下文判断具体含义。这里保留消歧义页面作为来源，并允许读者选择想要了解的实际概念，而不是将所有含义混合在同一个知识领域。';
  const mock = fixture({ pages: { [childUrl]: html('PCA', [{ url: 'https://example.org/meaning', label: '常设仲裁法院' }], lead) } });
  const result = await completeDynamic(graphWithConcept('PCA', childUrl), mock.adapter, { readingPace: 'fast' });
  const source = result.nodes.find(node => node.kind === 'web')!;
  assert.ok(source.article); assert.equal(source.reading?.state, 'no_match'); assert.match(source.reading.reason!, /多个含义/);
  assert.equal(result.nodes.find(node => node.title === '常设仲裁法院')!.reading?.state, 'pending');
  assert.deepEqual(mock.requests, [childUrl]); validEdges(result);
});

test('another owned source does not falsely make an empty managed concept readable', async () => {
  const graph = graphWithConcept('协方差', childUrl);
  const concept = graph.nodes.find(node => node.id === 'concept-pending')!;
  concept.locator = 'Knowledge Seed/概念/协方差.md'; concept.bodyAvailable = false;
  graph.nodes.push({ id: 'web-existing', managedId: 'web-existing', kind: 'web', title: '协方差', locator: childUrl,
    excerpt: '已有详细正文', status: 'retrieved', depth: 2, article: { blocks: [{ type: 'paragraph', text: '已有详细正文' }], textChars: 6, totalTextChars: 6, truncated: false } });
  const mock = fixture();
  const result = await completeDynamic(graph, mock.adapter, { readingPace: 'fast' });
  assert.deepEqual(mock.requests, []);
  const unresolved = result.nodes.find(node => node.id === 'concept-pending')!;
  assert.equal(unresolved.bodyAvailable, false); assert.equal(unresolved.article, undefined);
  assert.equal(unresolved.reading?.state, 'no_match'); assert.match(unresolved.reading!.reason!, /已有独立笔记.*合并/);
  assert.equal(result.nodes.find(node => node.id === 'web-existing')!.reading?.state, 'ready');
});

test('a failed primary language search can recover from an exact bilingual redirect', async () => {
  const page = 'https://en.wikipedia.org/wiki/Covariance';
  const mock = fixture({ request: async url => {
    if (url === page) return { status: 200, text: html('Covariance') };
    return new URL(url).hostname === 'zh.wikipedia.org' ? { status: 503, text: '' }
      : { status: 200, text: JSON.stringify({ query: { search: [{ title: 'Covariance', redirecttitle: '协方差' }] } }) };
  } });
  const result = await completeDynamic(graphWithConcept(), mock.adapter, { readingPace: 'fast', searchLanguageMode: 'both' });
  assert.equal(mock.requests.length, 4); assert.equal(mock.requests.at(-1), page);
  const source = result.nodes.find(node => node.kind === 'web')!;
  assert.equal(source.reading?.state, 'ready'); assert.equal(source.sourceResolution?.term, '协方差');
  assert.match(source.sourceResolution!.queryUrl, /^https:\/\/en\.wikipedia\.org\//); validEdges(result);
});
