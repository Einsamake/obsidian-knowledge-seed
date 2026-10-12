import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { generateGraph, type EngineAdapter, type NoteRef } from '../src/engine';
import { filterGraph, nodeId, type KnowledgeGraph } from '../src/graph';
import { exportGraph } from '../src/export';

Object.assign(globalThis, { DOMParser });

function adapterFixture(notes: Array<NoteRef & { body: string }>, pages: Record<string, string> = {}) {
  const requests: string[] = [], reads: string[] = [];
  const adapter: EngineAdapter = {
    listNotes: () => notes.map(({ body: _body, ...ref }) => ref),
    readNote: async path => {
      reads.push(path);
      const note = notes.find(item => item.path === path);
      if (!note) throw new Error('Missing note');
      return note.body;
    },
    resolveLink: link => notes.find(item => item.path.replace(/\.md$/, '') === link
      || item.path.split('/').pop()!.replace(/\.md$/, '') === link
      || item.title === link)?.path ?? null,
    request: async url => {
      requests.push(url);
      if (url.includes('/w/api.php?')) return { status: 200, text: '{"query":{"search":[]}}', headers: { 'content-type': 'application/json' } };
      return { status: pages[url] ? 200 : 404, text: pages[url] ?? '', headers: { 'content-type': 'text/html' } };
    },
  };
  return { adapter, requests, reads };
}

function page(labels: string[]) {
  return `<!doctype html><html><head><title>预测编码</title></head><body><article><h1>预测编码</h1>
    <p>预测编码通过对输入信息的预测和误差调整来组织知识。这段正文足够长，包含模型、输入、预测误差与信息处理的说明，需要保留具体来源才能验证其提出的各项名称和术语。本文提供真实链接，相关性仍需人工判断。</p>
    ${labels.map((label, index) => `<p>预测编码理论中出现的<a href="https://example.org/reference-${index}">${label}</a>是正文引用的一项相关说明，本文对该名称进行了明确的提及。</p>`).join('')}
    </article></body></html>`;
}

test('continuing a managed concept searches its restored title and carries the original identity', async () => {
  const path = 'Knowledge Seed/old/nodes/预测误差-concept-aabbee.md';
  const fixture = adapterFixture([{ path, title: '预测误差', managedId: 'concept-original', body: '这是已经生成的概念起点。' }]);
  const graph = await generateGraph({ kind: 'note', value: path }, fixture.adapter, { generatedFolder: 'Knowledge Seed', maxPages: 1, maxNotes: 0 });
  assert.equal(new URL(fixture.requests[0]).searchParams.get('srsearch'), '预测误差');
  assert.equal(graph.nodes[0].title, '预测误差');
  const source = graph.nodes.find(node => node.locator === path)!;
  assert.equal(source.managedId, 'concept-original');
  assert.equal(source.title, '预测误差');
});

test('an explicit generated link continues the old map without scanning unrelated generated notes', async () => {
  const seed = 'Knowledge Seed/old/nodes/起点.md';
  const linked = 'Knowledge Seed/old/nodes/来源.md';
  const fixture = adapterFixture([
    { path: seed, title: '预测编码', managedId: 'seed-old', body: '参考 [[Knowledge Seed/old/nodes/来源]]，另有 [[私人/机密]] 与 [[.hidden/隐藏]]。' },
    { path: linked, title: '已有来源', managedId: 'source-old', body: '真实来源正文。' },
    { path: 'Knowledge Seed/unrelated/预测编码.md', title: '预测编码', body: '这篇自动生成的文件不该参与词项扫描。' },
    { path: 'Knowledge Seed Extra/相关.md', title: '预测编码的研究', body: '此目录是合法普通目录。' },
    { path: '私人/机密.md', title: '机密', body: '禁止读取。' },
    { path: '.hidden/隐藏.md', title: '隐藏', body: '禁止读取。' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: seed }, fixture.adapter, {
    web: false, depth: 1, maxNotes: 5, generatedFolder: 'Knowledge Seed', excludeFolders: ['私人'],
  });
  assert.ok(fixture.reads.includes(linked));
  assert.ok(fixture.reads.includes('Knowledge Seed Extra/相关.md'));
  assert.ok(!fixture.reads.some(path => path.includes('unrelated') || path.startsWith('私人/') || path.startsWith('.hidden/')));
  const old = graph.nodes.find(node => node.locator === linked)!;
  assert.equal(old.managedId, 'source-old');
  assert.ok(graph.edges.some(edge => edge.relation === 'wiki_link' && edge.to === old.id));
  assert.ok(!graph.nodes.some(node => node.kind === 'concept' && ['来源', '机密', '隐藏'].includes(node.title)));
});

test('user exclusions cannot be bypassed by explicit links inside the generated folder', async () => {
  const seed = 'Knowledge Seed/old/起点.md';
  const target = 'Knowledge Seed/old/来源.md';
  const fixture = adapterFixture([
    { path: seed, title: '预测编码', body: `参考 [[${target.replace(/\.md$/, '')}]]` },
    { path: target, title: '来源', body: '预测编码' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: seed }, fixture.adapter, {
    web: false, depth: 1, generatedFolder: 'Knowledge Seed', excludeFolders: ['Knowledge Seed/old'],
  });
  assert.deepEqual(fixture.reads, [seed]);
  assert.ok(!graph.nodes.some(node => node.locator === target || node.kind === 'concept'));
});

test('existing wikilink targets never become concept clones when selection limits omit the file', async () => {
  const fixture = adapterFixture([
    { path: '起点.md', title: '预测编码', body: '参考 [[实际笔记#节|别名]] 与 [[待定义概念]]。' },
    { path: '实际笔记.md', title: '已有对象', body: '它是现有文件。' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, maxNotes: 0, maxConcepts: 10 });
  assert.deepEqual(fixture.reads, ['起点.md']);
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'concept').map(node => node.title), ['待定义概念']);
});

test('an unresolved wikilink alias never redirects its concept to an unrelated existing note', async () => {
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: '参考 [[缺失词条|预测误差]]。' },
    { path: '预测误差.md', title: '预测误差', body: '这个同名文件不是双链的目标。' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, maxNotes: 0 });
  const concept = graph.nodes.find(node => node.kind === 'concept')!;
  assert.equal(concept.id, nodeId('concept', '缺失词条'));
  assert.equal(concept.title, '预测误差');
  assert.equal(concept.locator, undefined);
  assert.ok(!graph.nodes.some(node => node.locator === '预测误差.md'));
  assert.deepEqual(fixture.reads, ['起点.md']);
  const bundle = exportGraph(graph, 'Knowledge Seed', 'alias-regression');
  const conceptFile = bundle.files.find(file => file.path === bundle.nodePaths[concept.id])!;
  assert.ok(conceptFile.content.includes('[[起点|起点]]'), 'the generated concept supplies the real native backlink');
  assert.ok(bundle.nodePaths[concept.id].startsWith('Knowledge Seed/概念/'));
});

test('unresolved wikilinks with the same display alias retain distinct raw target identities', async () => {
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: '参考 [[理论/待写词条|预测误差]] 和 [[应用/待写词条|预测误差]]。' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, maxNotes: 0 });
  const concepts = graph.nodes.filter(node => node.kind === 'concept');
  assert.equal(concepts.length, 2);
  assert.deepEqual(new Set(concepts.map(node => node.id)), new Set([
    nodeId('concept', '理论/待写词条'), nodeId('concept', '应用/待写词条'),
  ]));
  assert.ok(concepts.every(node => node.title === '预测误差' && !node.locator));
});

test('an unresolved target stays distinct even when its display alias equals the source title', async () => {
  const fixture = adapterFixture([
    { path: '预测误差.md', title: '预测误差', body: '参考 [[待定义概念|预测误差]]。' },
  ]);
  const graph = await generateGraph({ kind: 'note', value: '预测误差.md' }, fixture.adapter, { web: false, maxNotes: 0 });
  const concept = graph.nodes.find(node => node.kind === 'concept')!;
  assert.ok(concept);
  assert.equal(concept.id, nodeId('concept', '待定义概念'));
  assert.equal(concept.locator, undefined);
  assert.ok(graph.edges.some(edge => edge.to === concept.id && edge.relation === 'mentions'));
});

test('native link indexing excludes code and comment literals from note continuation', async () => {
  const real = 'Knowledge Seed/网页/真实引用.md', phantom = 'Knowledge Seed/网页/代码幻影.md';
  const realQuote = '[[Knowledge Seed/网页/真实引用]]';
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: `正文 ${realQuote}\n\x60\x60\x60\n[[Knowledge Seed/网页/代码幻影]]\n\x60\x60\x60\n<!-- [[待定义幻影]] -->` },
    { path: real, title: '真实引用', body: '真实来源正文。' },
    { path: phantom, title: '代码幻影', body: '不得因代码例子而扫描。' },
  ]);
  fixture.adapter.noteLinks = path => path === '起点.md' ? [{ target: real.replace(/\.md$/, ''), quote: realQuote }] : [];
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['起点.md', real]);
  assert.ok(graph.edges.some(edge => edge.relation === 'wiki_link' && edge.evidence[0].quote === realQuote));
  assert.ok(!graph.nodes.some(node => node.locator === phantom || node.kind === 'concept'));
});

test('native indexed encoded Markdown targets continue generated notes through the resolver', async () => {
  const target = 'Knowledge Seed/网页/预测误差 #2.md';
  const encoded = 'Knowledge%20Seed/%E7%BD%91%E9%A1%B5/%E9%A2%84%E6%B5%8B%E8%AF%AF%E5%B7%AE%20%232.md';
  const quote = `[来源笔记](${encoded})`;
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: `正文引用 ${quote}。` },
    { path: target, title: '预测误差 #2', body: '已有的编码路径目标。' },
  ]);
  const resolved: string[] = [];
  fixture.adapter.resolveLink = link => { resolved.push(link); return link === encoded ? target : null; };
  fixture.adapter.noteLinks = path => path === '起点.md' ? [{ target: encoded, label: '来源笔记', quote }] : [];
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['起点.md', target]);
  assert.ok(resolved.includes(encoded), 'the public native target is forwarded unchanged');
  const destination = graph.nodes.find(node => node.locator === target)!;
  assert.ok(destination);
  assert.ok(graph.edges.some(edge => edge.to === destination.id && edge.relation === 'wiki_link' && edge.evidence[0].quote === quote));
});

test('an authoritative empty native list suppresses literal wikilinks rather than falling back', async () => {
  const target = 'Knowledge Seed/网页/幻影笔记.md';
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: '[[Knowledge Seed/网页/幻影笔记]] 与 [[未定义幻影]]。' },
    { path: target, title: '幻影笔记', body: '不应被显式扩展读取。' },
  ]);
  fixture.adapter.noteLinks = () => [];
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['起点.md']);
  assert.ok(!graph.edges.some(edge => edge.relation === 'wiki_link' || edge.relation === 'mentions'));
  assert.ok(!graph.nodes.some(node => node.kind === 'concept' || node.locator === target));
});

test('fallback ignores fenced code, inline code, HTML comments, escaped starts and indented code', async () => {
  const real = 'Knowledge Seed/网页/真实引用.md';
  const body = [
    '```md', '[[代码幻影]]', '```', '~~~', '[[波浪围栏幻影]]', '~~~',
    '`[[内联幻影]]`', '``内联 ` [[多反引号幻影]]``', '<!-- [[注释幻影]] -->',
    '\\[[转义幻影]]', '    [[缩进幻影]]', '\t[[制表缩进幻影]]',
    '正文 [[Knowledge Seed/网页/真实引用]]。',
  ].join('\n');
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body },
    { path: real, title: '真实引用', body: '真实引用内容。' },
  ]);
  fixture.adapter.noteLinks = () => undefined;
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['起点.md', real]);
  assert.equal(graph.edges.filter(edge => edge.relation === 'wiki_link').length, 1);
  assert.ok(!graph.nodes.some(node => node.kind === 'concept'));
});

test('native links with stale quotations or outside the analyzed prefix do not become evidence', async () => {
  const quote = '[[Knowledge Seed/网页/未分析来源]]';
  const fixture = adapterFixture([
    { path: '起点.md', title: '起点', body: '正文'.repeat(11000) + quote },
    { path: 'Knowledge Seed/网页/未分析来源.md', title: '未分析来源', body: '不该扩展读取。' },
  ]);
  fixture.adapter.noteLinks = () => [
    { target: 'Knowledge Seed/网页/未分析来源', quote },
    { target: '曾有链接', quote: '[[曾有链接]]' },
  ];
  const graph = await generateGraph({ kind: 'note', value: '起点.md' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['起点.md']);
  assert.ok(graph.warnings.some(w => w.includes('20000')));
  assert.ok(!graph.edges.some(edge => edge.relation === 'wiki_link' || edge.relation === 'mentions'));
});

test('web mention reuses an eligible existing path and managed identity without reading its body', async () => {
  const fixture = adapterFixture([
    { path: 'Knowledge Seed/old/预测误差.md', title: '预测误差', managedId: 'old-error', body: '不能将未读取正文标为已读取。' },
    { path: '私人/隐藏术语.md', title: '隐藏术语', body: '禁止读取。' },
  ], { 'https://example.org/article': page(['预测误差', '隐藏术语']) });
  const graph = await generateGraph({ kind: 'url', value: 'https://example.org/article' }, fixture.adapter, {
    maxPages: 1, depth: 0, maxNotes: 0, generatedFolder: 'Knowledge Seed', excludeFolders: ['私人'],
  });
  assert.deepEqual(fixture.reads, []);
  const reused = graph.nodes.find(node => node.title === '预测误差')!;
  assert.equal(reused.locator, 'Knowledge Seed/old/预测误差.md');
  assert.equal(reused.managedId, 'old-error');
  assert.equal(reused.status, 'derived');
  assert.ok(!graph.nodes.some(node => node.title === '隐藏术语'));
});

test('a web mention later selected as a note stays one node at the original path', async () => {
  const fixture = adapterFixture([
    { path: '研究/误差.md', title: '预测误差', body: '预测编码包含预测误差。' },
  ], { 'https://example.org/article': page(['预测误差', '研究/误差']) });
  const graph = await generateGraph({ kind: 'url', value: 'https://example.org/article' }, fixture.adapter, { maxPages: 1, depth: 0, maxNotes: 5 });
  const nodes = graph.nodes.filter(node => node.locator === '研究/误差.md');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'note');
  assert.equal(nodes[0].status, 'retrieved');
  assert.equal(fixture.reads.length, 1);
  assert.ok(graph.edges.filter(edge => edge.to === nodes[0].id).length >= 2);
});

function selectionFixture(): KnowledgeGraph {
  return {
    version: 1, seed: '测试', createdAt: '2026-10-04T00:00:00Z', warnings: [], stats: { requests: 0, pagesAttempted: 0, notesScanned: 0 },
    nodes: [
      { id: 'root', kind: 'seed', title: '测试', excerpt: '', depth: 0, status: 'derived' },
      { id: 'one', kind: 'note', title: '来源一', excerpt: '', depth: 1, status: 'retrieved', locator: '来源一.md' },
      { id: 'two', kind: 'note', title: '来源二', excerpt: '', depth: 1, status: 'retrieved', locator: '来源二.md' },
      { id: 'term', kind: 'concept', title: '概念', excerpt: '', depth: 2, status: 'derived' },
    ],
    edges: [
      { id: 'root-one', from: 'root', to: 'one', relation: 'keyword_match', evidence: [{ sourceId: 'one', quote: '测试', method: '匹配' }] },
      { id: 'one-term', from: 'one', to: 'term', relation: 'mentions', evidence: [{ sourceId: 'one', quote: '概念', method: '提及' }] },
      { id: 'two-term', from: 'two', to: 'term', relation: 'mentions', evidence: [{ sourceId: 'two', quote: '概念', method: '提及' }] },
    ],
  };
}

test('selection drops a concept when all its retained source connections disappear without mutating input', () => {
  const graph = selectionFixture();
  const snapshot = JSON.stringify(graph);
  const filtered = filterGraph(graph, new Set(['root', 'term']));
  assert.deepEqual(filtered.nodes.map(node => node.id), ['root']);
  assert.deepEqual(filtered.edges, []);
  assert.equal(JSON.stringify(graph), snapshot);
});

test('selection preserves a multiply sourced concept with only its remaining evidence', () => {
  const graph = selectionFixture();
  const filtered = filterGraph(graph, new Set(['root', 'two', 'term']));
  assert.ok(filtered.nodes.some(node => node.id === 'term'));
  assert.deepEqual(filtered.edges.map(edge => edge.id), ['two-term']);
  assert.ok(filtered.edges.every(edge => edge.evidence.every(evidence => evidence.sourceId === 'two')));
  assert.equal(graph.edges.length, 3);
});

test('ordinary topic matching skips generated output but respects folder boundaries', async () => {
  const fixture = adapterFixture([
    { path: 'Knowledge Seed/预测编码.md', title: '预测编码', body: '自动输出' },
    { path: 'Knowledge Seed Extra/预测编码.md', title: '预测编码', body: '人工笔记' },
  ]);
  const graph = await generateGraph({ kind: 'topic', value: '预测编码' }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed' });
  assert.deepEqual(fixture.reads, ['Knowledge Seed Extra/预测编码.md']);
  assert.equal(graph.nodes.find(node => node.kind === 'note')?.locator, 'Knowledge Seed Extra/预测编码.md');
});

test('local explicit-link traversal reaches depth three and four without keyword or generated-folder drift', async () => {
  const paths = ['脑科学', '预测编码', '预测误差', '神经元', '感觉输入', '后续实验'].map(title => `Knowledge Seed/概念/${title}.md`);
  const notes = paths.map((path, index) => ({ path, title: path.split('/').pop()!.replace(/\.md$/, ''),
    body: index + 1 < paths.length ? `正文引用 [[${paths[index + 1].replace(/\.md$/, '')}]]。` : '末端记录。' }));
  notes.push({ path: 'Knowledge Seed/无关/脑科学.md', title: '脑科学', body: '不该参与普通词检索的自动生成内容。' });
  for (const depth of [3, 4]) {
    const fixture = adapterFixture(notes);
    const graph = await generateGraph({ kind: 'note', value: paths[0] }, fixture.adapter, {
      web: false, generatedFolder: 'Knowledge Seed', depth, maxNotes: 20, scanLimit: 20,
    });
    assert.deepEqual(fixture.reads, paths.slice(0, depth + 1));
    assert.equal(graph.nodes.filter(node => node.kind === 'note').length, depth + 1);
    assert.equal(graph.edges.filter(edge => edge.relation === 'wiki_link').length, depth);
    assert.equal(graph.nodes.find(node => node.locator === paths[depth])!.depth, depth + 1);
  }
  for (const limits of [{ maxNotes: 2, scanLimit: 20 }, { maxNotes: 20, scanLimit: 2 }]) {
    const fixture = adapterFixture(notes);
    const graph = await generateGraph({ kind: 'note', value: paths[0] }, fixture.adapter, {
      web: false, generatedFolder: 'Knowledge Seed', depth: 4, ...limits,
    });
    assert.deepEqual(fixture.reads, paths.slice(0, 3));
    assert.equal(graph.stats.notesScanned, 2);
    assert.ok(graph.warnings.some(w => w.includes('预算')));
  }
});

test('deep explicit traversal respects exclusions and link limits without reading excluded branches', async () => {
  const seed = 'Knowledge Seed/脑科学.md', good = 'Knowledge Seed/预测编码.md';
  const fixture = adapterFixture([
    { path: seed, title: '脑科学', body: '[[私人/机密]] [[Knowledge Seed/烹饪方法]] [[Knowledge Seed/预测编码]] [[Knowledge Seed/神经元]]' },
    { path: '私人/机密.md', title: '机密', body: '禁止读取。' },
    { path: 'Knowledge Seed/烹饪方法.md', title: '烹饪方法', body: '名称排除。' },
    { path: good, title: '预测编码', body: '合法目标。' },
    { path: 'Knowledge Seed/神经元.md', title: '神经元', body: '超过本节点链接上限。' },
  ]);
  await generateGraph({ kind: 'note', value: seed }, fixture.adapter, {
    web: false, generatedFolder: 'Knowledge Seed', depth: 4, linkLimit: 1, excludeFolders: ['私人'], excludeTerms: ['烹饪'],
  });
  assert.deepEqual(fixture.reads, [seed, good]);
});

test('per-run note character limits expand actual indexed evidence without trusting out-of-range duplicates', async () => {
  const seed = 'Knowledge Seed/脑科学.md', target = 'Knowledge Seed/预测编码.md';
  const quote = '[[Knowledge Seed/预测编码]]';
  const body = '`' + quote + '`\n' + '正文'.repeat(70) + quote;
  for (const maxNoteChars of [80, 500]) {
    const fixture = adapterFixture([
      { path: seed, title: '脑科学', body },
      { path: target, title: '预测编码', body: '已有真实来源。' },
    ]);
    fixture.adapter.noteLinks = path => path === seed ? [{ target: target.replace(/\.md$/, ''), quote, endOffset: body.length }] : [];
    const graph = await generateGraph({ kind: 'note', value: seed }, fixture.adapter, {
      web: false, generatedFolder: 'Knowledge Seed', maxNoteChars, depth: 4,
    });
    assert.equal(graph.edges.filter(edge => edge.relation === 'wiki_link').length, maxNoteChars === 80 ? 0 : 1);
    assert.deepEqual(fixture.reads, maxNoteChars === 80 ? [seed] : [seed, target]);
  }
});

test('a cyclic explicit note chain reads each path once and keeps real reverse link evidence', async () => {
  const a = 'Knowledge Seed/脑科学.md', b = 'Knowledge Seed/预测编码.md';
  const fixture = adapterFixture([
    { path: a, title: '脑科学', body: `[[${b.replace(/\.md$/, '')}]]` },
    { path: b, title: '预测编码', body: `[[${a.replace(/\.md$/, '')}]]` },
  ]);
  const graph = await generateGraph({ kind: 'note', value: a }, fixture.adapter, { web: false, generatedFolder: 'Knowledge Seed', depth: 20 });
  assert.deepEqual(fixture.reads, [a, b]);
  assert.equal(graph.edges.filter(edge => edge.relation === 'wiki_link').length, 2);
});
