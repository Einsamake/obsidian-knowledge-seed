import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { Cancelled, clampOptions, fallbackNoteLinks, filterVisibleNoteLinks, generateGraph, visibleNoteContent, type EngineAdapter, type Options } from '../src/engine';

test('saved strategy settings clamp to finite ceilings and clone nested rules without changing legacy defaults', () => {
  const rules=[{term:' Statistics ',weight:99,depth:999},{term:'Applications',weight:3}];
  const options=clampOptions({explorationStrategy:'custom',breadthDecay:999,directionDepthBoost:999,offDirectionDepth:-1,directionRules:rules});
  assert.equal(options.breadthDecay,4);assert.equal(options.directionDepthBoost,20);assert.equal(options.offDirectionDepth,0);
  assert.deepEqual(options.directionRules,[{term:'Statistics',weight:10,depth:20},{term:'Applications',weight:3}]);
  options.directionRules![0].weight=1;assert.equal(rules[0].weight,99);assert.equal(rules[0].term,' Statistics ');
  assert.equal(clampOptions({}).explorationStrategy,'radial');
  assert.equal(clampOptions({explorationStrategy:['focused'] as never}).explorationStrategy,'radial');
  assert.equal(clampOptions({breadthDecay:NaN,directionDepthBoost:Infinity}).breadthDecay,1);
  assert.equal(clampOptions({breadthDecay:NaN,directionDepthBoost:Infinity}).directionDepthBoost,2);
});
import type { KnowledgeGraph } from '../src/graph';

Object.assign(globalThis, { DOMParser });

const offline: Partial<Options> = { web: false, maxNotes: 8, maxConcepts: 16, generatedFolder: 'Knowledge Seed' };

test('hidden Obsidian comments cannot become fallback links or local keyword evidence', async () => {
  const fixture = mock({ notes: { 'Graph.md': 'Graph [[Visible]]\n%% [[PrivateOne]] %%\n%%\n[[PrivateTwo]]\n%%\n`%%`\n```\n%%\n```\n\\%% [[EscapedDelimiter]] \\%%\n[[AfterCode]]\n%% [[UnclosedPrivate]]' } });
  const graph = await generateGraph({ kind: 'note', value: 'Graph.md' }, fixture.adapter, { ...offline, depth: 2 });
  for (const name of ['Visible', 'EscapedDelimiter', 'AfterCode']) assert.ok(graph.nodes.some(node => node.title === name), name);
  for (const name of ['PrivateOne', 'PrivateTwo', 'UnclosedPrivate']) assert.ok(!graph.nodes.some(node => node.title === name), name);
  const hidden = mock({ notes: { 'Unrelated.md': 'Ordinary visible prose.\n%% SecretResearch [[PrivateTerm]] %%' } });
  const topic = await generateGraph({ kind: 'topic', value: 'SecretResearch' }, hidden.adapter, offline);
  assert.equal(topic.nodes.length, 1);
});

test('stale native indexed links must still occur in current visible prose', async () => {
  const fixture = mock({ notes: { 'Graph.md': 'Graph [[Visible]]\n```\n[[CodeOnly]]\n```\n%% [[Private]] %%\n<!-- [[HtmlHidden]] -->\n\\[[Escaped]]' } });
  fixture.adapter.noteLinks = () => ['Visible', 'CodeOnly', 'Private', 'HtmlHidden', 'Escaped'].map(target => ({ target, quote: `[[${target}]]` }));
  const graph = await generateGraph({ kind: 'note', value: 'Graph.md' }, fixture.adapter, { ...offline, depth: 2 });
  assert.ok(graph.nodes.some(node => node.title === 'Visible'));
  for (const name of ['CodeOnly', 'Private', 'HtmlHidden', 'Escaped']) assert.ok(!graph.nodes.some(node => node.title === name), name);
});

test('comment content cannot open code spans that hide following real prose', () => {
  const text = '%%\n```\n%%\n[[VisibleAfterComment]]\n<!-- ` -->\n[[VisibleAfterHtml]]\n`%%`\n[[AfterLiteral]]';
  const visible = visibleNoteContent(text);
  for (const quote of ['[[VisibleAfterComment]]', '[[VisibleAfterHtml]]', '[[AfterLiteral]]']) assert.ok(visible.includes(quote));
  assert.equal(filterVisibleNoteLinks(text, [{ target: 'VisibleAfterComment', quote: '[[VisibleAfterComment]]' }]).length, 1);
});

test('indexed prose links preserve Markdown links, exact offsets and authoritative empty indexes', async () => {
  const text = 'Graph [Actual](Known.md) [[Visible]]\n%% [[Visible]] %%';
  const links = [{ target: 'Known', quote: '[Actual](Known.md)', endOffset: text.indexOf('[Actual]') + '[Actual](Known.md)'.length },
    { target: 'Visible', quote: '[[Visible]]', endOffset: text.lastIndexOf('[[Visible]]') + '[[Visible]]'.length }];
  assert.deepEqual(filterVisibleNoteLinks(text, links).map(link => link.target), ['Known']);
  const fixture = mock({ notes: { 'Graph.md': text } }); fixture.adapter.noteLinks = () => [];
  const graph = await generateGraph({kind: 'note', value: 'Graph.md'}, fixture.adapter, offline);
  assert.ok(!graph.nodes.some(node => node.title === 'Visible'));
});

test('many inline code spans remain inert without losing trailing prose or mixed delimiter lengths', () => {
  const text = '`[[CodeOnly]]` '.repeat(10000) + '`` a ` [[NestedCode]] `` [[Visible]] %% [[Hidden]] %% [[AfterComment]]';
  assert.deepEqual(fallbackNoteLinks(text).map(link => link.target), ['Visible', 'AfterComment']);
});
test('existing note preview excerpts exclude properties and hidden ownership comments', async () => {
  const path = '可读笔记.md';
  const fixture = mock({ notes: { [path]: '---\nknowledge_seed_id: "web-hidden"\nsource: "https://example.org/private-metadata"\n---\n\n<!-- knowledge-seed:article:web-hidden:hash -->\n# 可读笔记\n\n正文说明可读笔记的知识与来源。' } });
  const graph = await generateGraph({kind:'note',value:path}, fixture.adapter, {...offline,maxNotes:0});
  const note = graph.nodes.find(node => node.kind === 'note')!;
  assert.match(note.excerpt, /正文说明/);
  assert.doesNotMatch(note.excerpt, /knowledge_seed_id|source:|knowledge-seed:article/);
});
function html(title: string, links: Array<{ url: string; label: string }> = []): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>
    <p>知识图谱使用实体和关系组织知识，必须将来源、引用与语义相似的候选关系分别记录。这是一段足够完整的中文正文，描述可追溯来源与读者核查的重要性。所有自动生成的概念都应从可检验的真实材料中获得，并保留获取时间。</p>
    ${links.map(link => `<p>此处的<a href="${link.url}">${link.label}</a>是正文引用的相关资料，这些资料能够提供进一步的具体说明与证据。</p>`).join('')}
    </article></body></html>`;
}

function mock(options: {
  search?: Array<string | { title: string; snippet?: string }>;
  pages?: Record<string, string>;
  notes?: Record<string, string>;
  requestError?: Error;
  unreadable?: string[];
  onRequest?: (url: string) => void;
} = {}): { adapter: EngineAdapter; requests: string[]; reads: string[] } {
  const requests: string[] = [], reads: string[] = [];
  const notes = options.notes ?? {};
  const adapter: EngineAdapter = {
    request: async (url) => {
      requests.push(url);
      options.onRequest?.(url);
      if (options.requestError) throw options.requestError;
      if (url.includes('/w/api.php?')) return { status: 200, text: JSON.stringify({ query: { search: (options.search ?? []).map(item => typeof item === 'string' ? { title: item } : item) } }), headers: { 'content-type': 'application/json' } };
      const page = options.pages?.[url];
      return { status: page ? 200 : 404, text: page ?? '', headers: { 'content-type': 'text/html' } };
    },
    listNotes: () => Object.keys(notes).map(path => ({ path, title: path.split('/').pop()!.replace(/\.md$/, '') })),
    readNote: async (path) => {
      reads.push(path);
      if (options.unreadable?.includes(path) || !(path in notes)) throw new Error('无法读取笔记');
      return notes[path];
    },
    resolveLink: (link) => Object.keys(notes).find(path => path === `${link}.md` || path.replace(/\.md$/, '') === link || path.split('/').pop() === `${link}.md`) ?? null,
  };
  return { adapter, requests, reads };
}

function assertEvidence(graph: KnowledgeGraph): void {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const edge of graph.edges) {
    assert.ok(nodes.has(edge.from));
    assert.ok(nodes.has(edge.to));
    assert.notEqual(edge.from, edge.to);
    assert.ok(edge.evidence.length > 0);
    for (const evidence of edge.evidence) {
      assert.equal(nodes.get(evidence.sourceId)?.status, 'retrieved');
      assert.ok(evidence.quote.trim());
      assert.ok(evidence.method.trim());
    }
  }
}

test('topic searches Wikipedia and preserves search candidates as distinct evidence types', async () => {
  const fixture = mock({ search: ['知识图谱', 'Semantic network'], pages: {
    'https://zh.wikipedia.org/wiki/%E7%9F%A5%E8%AF%86%E5%9B%BE%E8%B0%B1': html('知识图谱'),
    'https://zh.wikipedia.org/wiki/Semantic_network': html('Semantic network'),
  } });
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, { maxPages: 2, depth: 0, searchTerms: ['Semantic network'] });
  assert.equal(graph.nodes.filter(node => node.kind === 'web').length, 2);
  assert.equal(graph.edges.filter(edge => edge.relation === 'search_match').length, 2);
  assert.equal(graph.stats.pagesAttempted, 2);
  assert.equal(graph.stats.requests, 5);
  const search = new URL(fixture.requests[0]);
  assert.equal(search.hostname, 'zh.wikipedia.org');
  assert.equal(search.searchParams.get('srsearch'), '知识图谱');
  assert.ok(graph.edges.every(edge => edge.relation === 'search_match'));
  assert.ok(graph.edges.every(edge => edge.evidence[0].method.includes('相关性待确认')));
  assertEvidence(graph);
});

test('Chinese vault matching finds body and title matches and obeys note limits', async () => {
  const fixture = mock({ notes: {
    '研究/知识图谱.md': '标题对应一个知识图谱的研究记录。',
    '研究/论文阅读.md': '这篇论文讨论知识图谱中的证据与来源。',
    '研究/食谱.md': '红烧肉的做法。',
  } });
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, { ...offline, maxNotes: 2 });
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'note').map(node => node.locator), ['研究/知识图谱.md', '研究/论文阅读.md']);
  assert.equal(graph.stats.notesScanned, 3);
  assert.equal(fixture.requests.length, 0);
  assert.ok(graph.edges.every(edge => edge.relation === 'keyword_match'));
  assertEvidence(graph);
});

test('excluded and hidden folders never get read, while similarly named folders remain eligible', async () => {
  const fixture = mock({ notes: {
    'Knowledge Seed/知识图谱.md': '知识图谱',
    'Templates/知识图谱.md': '知识图谱',
    '.obsidian/知识图谱.md': '知识图谱',
    '研究/.private/知识图谱.md': '知识图谱',
    'Knowledge Seed Extra/知识图谱.md': '知识图谱',
    '研究/知识图谱.md': '知识图谱',
  } });
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, offline);
  assert.deepEqual(new Set(fixture.reads), new Set(['Knowledge Seed Extra/知识图谱.md', '研究/知识图谱.md']));
  assert.equal(graph.nodes.filter(node => node.kind === 'note').length, 2);
  const excluded = mock({ notes: { '私人/知识图谱.md': '知识图谱', '公开/知识图谱.md': '知识图谱' } });
  await generateGraph({ kind: 'topic', value: '知识图谱' }, excluded.adapter, { ...offline, excludeFolders: ['私人/'] });
  assert.deepEqual(excluded.reads, ['公开/知识图谱.md']);
});

test('web budgets exceed former limits while retaining configurable attempts and a hard ceiling of 500', async () => {
  const search = Array.from({ length: 30 }, (_, index) => `Page ${index}`);
  const pages = Object.fromEntries(search.map(title => [`https://en.wikipedia.org/wiki/${title.replaceAll(' ', '_')}`, html(title)]));
  const fixture = mock({ search, pages });
  const graph = await generateGraph({ kind: 'topic', value: 'knowledge' }, fixture.adapter, { maxPages: 25, searchLimit: 100, relevance: 'broad', depth: 0, maxNotes: 0, wikiLanguage: 'en' });
  assert.equal(clampOptions({ maxPages: 999 }).maxPages, 500);
  assert.equal(graph.stats.pagesAttempted, 25);
  assert.equal(graph.nodes.filter(node => node.kind === 'web').length, 25);
  assert.equal(fixture.requests.length, 27);
});

test('web depth is configurable beyond two hops and clamps at twenty', async () => {
  const pages = Object.fromEntries(Array.from({ length: 25 }, (_, index) => {
    const n = index + 1;
    return [`https://example.com/page${n}`, html(`知识主题 ${n}`, [{ url: `/page${n + 1}`, label: `延伸资料 ${n + 1}` }])];
  }));
  const fixture = mock({ pages });
  const graph = await generateGraph({ kind: 'url', value: 'https://example.com/page1' }, fixture.adapter, { maxPages: 100, depth: 4, relevance: 'broad', maxNotes: 0 });
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'web').map(node => node.locator), [
    'https://example.com/page1', 'https://example.com/page2', 'https://example.com/page3', 'https://example.com/page4', 'https://example.com/page5',
  ]);
  assert.equal(fixture.requests.filter(url => !url.includes('/w/api.php?')).length, 5);
  const bounded = mock({ pages });
  const deeper = await generateGraph({ kind: 'url', value: 'https://example.com/page1' }, bounded.adapter, { maxPages: 100, depth: 999, relevance: 'broad', maxNotes: 0 });
  assert.equal(deeper.stats.pagesAttempted, 21);
  assertEvidence(graph);
});

test('repeated and fragment-variant URLs are retrieved once and keep source link relationships', async () => {
  const a = 'https://example.com/a', b = 'https://example.com/b';
  const fixture = mock({ pages: {
    [a]: html('知识图谱', [{ url: `${b}#one`, label: '证据概念' }, { url: `${b}#two`, label: '同一证据' }]),
    [b]: html('证据来源', [{ url: `${a}#back`, label: '知识图谱' }]),
  } });
  const graph = await generateGraph({ kind: 'url', value: `${a}#start` }, fixture.adapter, { maxPages: 5, depth: 2, relevance: 'broad', maxNotes: 0 });
  assert.equal(fixture.requests.filter(url => url === a).length, 1);
  assert.equal(fixture.requests.filter(url => url === b).length, 1);
  assert.equal(graph.stats.pagesAttempted, 2);
  const webNodes = graph.nodes.filter(node => node.kind === 'web');
  assert.equal(new Set(webNodes.map(node => node.locator)).size, webNodes.length);
  assert.equal(graph.edges.filter(edge => edge.relation === 'links_to').length, 2);
  assertEvidence(graph);
});

test('cancellation rejects generation before calls and after a request completes', async () => {
  const aborted = new AbortController(); aborted.abort();
  const fixture = mock();
  await assert.rejects(generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, {}, aborted.signal), Cancelled);
  assert.equal(fixture.requests.length, 0);
  const during = new AbortController();
  const inFlight = mock({ onRequest: () => during.abort() });
  await assert.rejects(generateGraph({ kind: 'topic', value: '知识图谱' }, inFlight.adapter, {}, during.signal), Cancelled);
  assert.equal(inFlight.requests.length, 1);
});

test('network failure yields explicit no-source warnings and no falsely retrieved nodes', async () => {
  const fixture = mock({ requestError: new Error('network unavailable') });
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, { maxNotes: 0 });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].kind, 'seed');
  assert.equal(graph.nodes[0].status, 'derived');
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.warnings.some(warning => warning.includes('network unavailable')));
  assert.ok(graph.warnings.some(warning => warning.includes('未成功获取任何来源')));
  await assert.rejects(generateGraph({ kind: 'url', value: 'https://example.com/a' }, fixture.adapter, {}), /network unavailable/);
});

test('failed candidate pages consume the bounded attempt count and do not produce source nodes', async () => {
  const fixture = mock({ search: ['Missing 1', 'Missing 2', 'Missing 3'] });
  const graph = await generateGraph({ kind: 'topic', value: 'knowledge' }, fixture.adapter, { maxPages: 2, relevance: 'broad', maxNotes: 0, wikiLanguage: 'en' });
  assert.equal(graph.stats.pagesAttempted, 2);
  assert.equal(graph.nodes.filter(node => node.status === 'retrieved').length, 0);
  assert.equal(graph.warnings.filter(warning => warning.includes('HTTP 404')).length, 2);
});

test('existing Obsidian wikilinks connect selected note sources and retain their literal citation', async () => {
  const fixture = mock({ notes: {
    '知识图谱.md': '知识图谱参考 [[知识图谱证据#核查|证据方法]]，已有链接应保留来源。',
    '知识图谱证据.md': '知识图谱证据的研究记录。参考 [[知识图谱]]。',
  } });
  const graph = await generateGraph({ kind: 'note', value: '知识图谱.md' }, fixture.adapter, offline);
  const linked = graph.edges.filter(edge => edge.relation === 'wiki_link');
  assert.equal(linked.length, 2);
  assert.ok(linked.some(edge => edge.evidence[0].quote === '[[知识图谱证据#核查|证据方法]]'));
  assert.ok(linked.some(edge => edge.evidence[0].quote === '[[知识图谱]]'));
  assert.equal(fixture.reads.filter(path => path === '知识图谱.md').length, 1);
  assertEvidence(graph);
});

test('URL seeds require public addresses and enabled nonzero web limits; empty seeds fail without calls', async () => {
  const fixture = mock({ pages: { 'https://example.com/a': html('知识图谱起点') } });
  const graph = await generateGraph({ kind: 'url', value: ' https://example.com/a#fragment ' }, fixture.adapter, { maxPages: 1, depth: 0, maxNotes: 0 });
  assert.equal(graph.nodes[0].title, '知识图谱起点');
  assert.equal(graph.nodes.filter(node => node.kind === 'web').length, 1);
  assert.equal(graph.edges[0].relation, 'seed_source');
  assert.deepEqual(fixture.requests, ['https://example.com/a']);
  assertEvidence(graph);
  for (const options of [{ web: false }, { maxPages: 0 }]) {
    await assert.rejects(generateGraph({ kind: 'url', value: 'https://example.com/a' }, fixture.adapter, options), /网页起点需要/);
  }
  await assert.rejects(generateGraph({ kind: 'url', value: 'http://localhost/a' }, fixture.adapter, {}), /不允许/);
  for (const kind of ['topic', 'url', 'note'] as const) {
    await assert.rejects(generateGraph({ kind, value: ' \n ' }, fixture.adapter, {}), /请输入/);
  }
  assert.equal(fixture.requests.length, 1);
});

test('bounded vault scanning reports incomplete coverage and note read failures', async () => {
  const fixture = mock({ notes: { 'a.md': '知识图谱', 'b.md': '知识图谱', 'c.md': '知识图谱' }, unreadable: ['a.md'] });
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, fixture.adapter, { ...offline, scanLimit: 2 });
  assert.equal(fixture.reads.length, 2);
  assert.ok(graph.warnings.some(warning => warning.includes('仅扫描了 2/3')));
  assert.ok(graph.warnings.some(warning => warning.includes('笔记读取失败')));
  assert.equal(graph.stats.notesScanned, 1);
});

function brainPage(links: Array<{ label: string; context: string; url?: string }> = []): string {
  return `<!doctype html><html><head><title>预测编码 - 维基百科</title></head><body><article><h1>预测编码</h1>
    <p>${'预测编码理论讨论神经系统如何利用感觉输入修正内部预测，研究需要区分实际引用与词面候选。'.repeat(6)}</p>
    ${links.map((link, index) => `<p>${link.context} <a href="${link.url ?? 'https://example.org/reference-' + index}">${link.label}</a> ${link.context}</p>`).join('')}
    </article></body></html>`;
}

test('brain-science concept filtering genuinely changes the saved candidate set in each mode', async () => {
  const source = 'https://example.org/brain';
  const page = brainPage([
    { label: '预测编码理论', context: '这段介绍预测编码理论' },
    { label: '预测误差', context: '预测编码理论引用预测误差，也区分烹饪话题' },
    { label: '烹饪方法', context: '这一旁支只有食物和烹饪' },
    { label: 'English', context: '预测编码页面的语言导航' },
    { label: '编辑', context: '预测编码页面编辑入口' },
  ]);
  const results: Record<string, string[]> = {};
  for (const relevance of ['strict', 'balanced', 'broad'] as const) {
    const fixture = mock({ pages: { [source]: page } });
    const graph = await generateGraph({ kind: 'url', value: source }, fixture.adapter, { maxPages: 1, maxNotes: 0, relevance });
    results[relevance] = graph.nodes.filter(node => node.kind === 'concept').map(node => node.title).sort();
    assert.equal(graph.edges.filter(edge => edge.relation === 'seed_source').length, 1);
    assertEvidence(graph);
  }
  assert.deepEqual(results.strict, ['预测编码理论']);
  assert.deepEqual(results.balanced, ['预测编码理论', '预测误差']);
  assert.deepEqual(results.broad, ['烹饪方法', '预测编码理论', '预测误差']);
  const excluded = mock({ pages: { [source]: page } });
  const graph = await generateGraph({ kind: 'url', value: source }, excluded.adapter, { maxPages: 1, maxNotes: 0, relevance: 'broad', excludeTerms: ['烹饪'] });
  assert.ok(graph.nodes.some(node => node.title === '预测误差'));
  assert.ok(!graph.nodes.some(node => node.title === '烹饪方法'));
});

test('ranked Wikipedia results take page budget before a source language link or unrelated branch', async () => {
  const source = 'https://example.org/brain', wiki = 'https://zh.wikipedia.org/wiki/%E9%A2%84%E6%B5%8B%E7%BC%96%E7%A0%81';
  const fixture = mock({ search: [
    { title: 'English', snippet: '预测编码页面的语言导航' },
    { title: '烹饪方法', snippet: '食物的准备' },
    { title: '预测编码', snippet: '<span class="searchmatch">预测编码</span>与神经科学' },
  ], pages: { [source]: brainPage([
    { label: 'English', context: '预测编码的语言入口', url: 'https://en.wikipedia.org/wiki/English_language' },
    { label: '预测误差', context: '预测编码明确引用', url: 'https://example.org/error' },
  ]), [wiki]: brainPage() } });
  const graph = await generateGraph({ kind: 'url', value: source }, fixture.adapter, { maxPages: 2, depth: 4, maxNotes: 0 });
  assert.deepEqual(fixture.requests.filter(url => !url.includes('/w/api.php?')), [source, wiki]);
  const evidence = graph.edges.find(edge => edge.relation === 'search_match')!.evidence[0];
  assert.ok(evidence.locator?.includes('srprop=snippet%7Credirecttitle'));
  assert.ok(evidence.quote.includes('API 摘要：预测编码与神经科学') || evidence.quote.includes('API 摘要：预测编码 与神经科学'));
  assert.ok(evidence.method.includes('非网页原文'));
});

test('optional bilingual user-term searches remain bounded and deduplicate retrieved pages', async () => {
  const zh = 'https://zh.wikipedia.org/wiki/%E9%A2%84%E6%B5%8B%E7%BC%96%E7%A0%81';
  const en = 'https://en.wikipedia.org/wiki/Predictive_coding';
  const fixture = mock({ pages: { [zh]: brainPage(), [en]: html('Predictive coding') } });
  const original = fixture.adapter.request;
  fixture.adapter.request = async url => {
    if (!url.includes('/w/api.php?')) return original(url);
    fixture.requests.push(url);
    const title = new URL(url).hostname.startsWith('zh.') ? '预测编码' : 'Predictive coding';
    return { status: 200, text: JSON.stringify({ query: { search: [{ title, snippet: title }] } }) };
  };
  const graph = await generateGraph({ kind: 'topic', value: '预测编码' }, fixture.adapter, {
    wikiLanguage: 'zh', searchLanguageMode: 'both', searchTerms: ['Predictive coding'], searchLimit: 2, maxPages: 2, maxNotes: 0, depth: 0,
  });
  assert.equal(fixture.requests.filter(url => url.includes('/w/api.php?')).length, 6);
  assert.deepEqual(new Set(graph.nodes.filter(node => node.kind === 'web').map(node => node.locator)), new Set([zh, en]));
  assert.equal(graph.stats.pagesAttempted, 2);
  assert.equal(graph.stats.requests, 8);
});

test('searchLimit zero permits document-link expansion without issuing search requests', async () => {
  const a = 'https://example.org/a', b = 'https://example.org/b';
  const fixture = mock({ pages: { [a]: brainPage([{ label: '预测误差', context: '预测编码引用这个机制', url: b }]), [b]: brainPage() } });
  const graph = await generateGraph({ kind: 'url', value: a }, fixture.adapter, { searchLimit: 0, maxPages: 3, depth: 3, maxNotes: 0 });
  assert.deepEqual(fixture.requests, [a, b]);
  assert.equal(graph.stats.pagesAttempted, 2);
});

test('strict mode keeps the real source connected when all sibling concepts are rejected', async () => {
  const source = 'https://example.org/brain';
  const fixture = mock({ pages: { [source]: brainPage([{ label: '预测误差', context: '预测编码引用该机制' }]) } });
  const graph = await generateGraph({ kind: 'url', value: source }, fixture.adapter, { relevance: 'strict', maxPages: 1, maxNotes: 0 });
  assert.equal(graph.nodes.filter(node => node.kind === 'concept').length, 0);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relation, 'seed_source');
  assert.ok(graph.warnings.some(warning => warning.includes('切换平衡模式')));
});

test('expanded option bounds stay finite and sanitize untrusted lists', () => {
  const bounded = clampOptions({ maxPages: 9999, depth: 9999, maxNotes: 9999, maxConcepts: 9999,
    scanLimit: 999999, searchLimit: 999, linkLimit: 999, maxBodyChars: 1, maxNoteChars: 999999,
    searchTerms: ['brain', 'brain', '', ...Array.from({ length: 30 }, (_, n) => `term ${n}`)] });
  assert.equal(bounded.maxPages, 500); assert.equal(bounded.depth, 20); assert.equal(bounded.maxNotes, 500);
  assert.equal(bounded.maxConcepts, 1000); assert.equal(bounded.scanLimit, 50000);
  assert.equal(bounded.searchLimit, 100); assert.equal(bounded.linkLimit, 100);
  assert.equal(bounded.maxBodyChars, 2000); assert.equal(bounded.maxNoteChars, 200000);
  assert.equal(bounded.searchTerms.length, 20);
});
