import test from 'node:test';
import assert from 'node:assert/strict';
import { encodedMarkdown, exportGraph, mergeManagedLinks, mergeManagedReading, mergeManagedWebMetadata, nativeLink, plainMarkdown, safeFolder, safeName, saveBundle, type Writer } from '../src/export';
import { filterGraph, nodeId, type KnowledgeGraph } from '../src/graph';
import { readManagedNote } from '../src/managed-note';
import { defaults } from '../src/engine';

function fixture(): KnowledgeGraph {
  const seed = nodeId('seed', 'topic:预测编码'), web = nodeId('web', 'https://en.wikipedia.org/wiki/Predictive_coding');
  const note = nodeId('note', '研究笔记/预测编码 与 误差.md'), concept = nodeId('concept', '预测误差');
  return {
    version: 1, seed: '预测编码', createdAt: '2026-10-04T14:00:00.000Z',
    nodes: [
      { id: seed, kind: 'seed', title: '预测编码', excerpt: '探索起点', status: 'derived', depth: 0 },
      { id: web, kind: 'web', title: 'Predictive coding', excerpt: 'A model [[隐藏节点]] ![远程图片](https://example.org/remote.png) [额外链接](私人.md) <script>unsafe</script>', locator: 'https://en.wikipedia.org/wiki/Predictive_coding', retrievedAt: '2026-10-04T14:00:01.000Z', status: 'retrieved', depth: 1, truncated: true },
      { id: note, kind: 'note', title: '预测编码 与 误差', excerpt: '预测误差 [[概念]]', locator: '研究笔记/预测编码 与 误差.md', retrievedAt: '2026-10-04T14:00:02.000Z', status: 'retrieved', depth: 1 },
      { id: concept, kind: 'concept', title: '预测误差', excerpt: '提及术语，定义待核实', status: 'derived', depth: 2 },
    ],
    edges: [
      { id: 'edge-web', from: seed, to: web, relation: 'search_match', evidence: [{ sourceId: seed, quote: '检索词：预测编码', method: '实际检索记录，不是网页原文' }] },
      { id: 'edge-note', from: seed, to: note, relation: 'keyword_match', evidence: [{ sourceId: note, quote: '预测编码模型包含预测误差。', method: '词项匹配，相关性待确认' }] },
      { id: 'edge-concept', from: note, to: concept, relation: 'mentions', evidence: [{ sourceId: note, quote: '[[预测误差]]', method: '原文提及' }] },
      { id: 'edge-extra', from: seed, to: concept, relation: 'mentions', evidence: [{ sourceId: web, quote: 'prediction error', method: '网页提及' }] },
    ], warnings: ['已有笔记读取被截断'], stats: { pagesAttempted: 1, notesScanned: 2, requests: 2 },
  };
}

test('discovery snippets stay readable without blocking later background body hydration', () => {
  const graph = fixture();
  const concept = graph.nodes.find(node => node.kind === 'concept')!;
  concept.excerpt = '公开检索返回：预测误差是预测值和实际值之间的差。\n这仍只是检索摘录。';
  concept.reading = { state: 'pending' };
  const bundle = exportGraph(graph, '知识地图', 'snippet-run');
  const content = bundle.files.find(file => file.path === bundle.nodePaths[concept.id])!.content;
  assert.ok(content.includes('这仍只是检索摘录。'));
  assert.equal(readManagedNote(content, concept.title)?.bodyAvailable, false);
  assert.equal(readManagedNote(content.replace('这仍只是检索摘录。', '这是用户修订后的解释。'), concept.title)?.bodyAvailable, true);
  assert.equal(readManagedNote(content + '\n用户另加的正文。\n', concept.title)?.bodyAvailable, true);
});

function memoryWriter(existing: Record<string, string | null> = {}, failSuffix?: string, failUpdate = false) {
  const entries = new Map<string, string | null>(Object.entries(existing)), writes: string[] = [], updates: string[] = [];
  const writer: Writer = {
    exists: async path => entries.has(path),
    mkdir: async path => { assert.equal(entries.has(path), false); entries.set(path, null); },
    create: async (path, content) => {
      if (failSuffix && path.endsWith(failSuffix)) throw new Error('simulated write failure');
      assert.equal(entries.has(path), false, `create would overwrite ${path}`); entries.set(path, content); writes.push(path);
    },
    update: async (path, ownerId, lines) => {
      if (failUpdate) throw new Error('simulated update failure');
      const content = entries.get(path); assert.equal(typeof content, 'string');
      entries.set(path, mergeManagedLinks(content!, ownerId, lines)); updates.push(path);
    },
  };
  return { writer, entries, writes, updates };
}
function generatedFiles(bundle: ReturnType<typeof exportGraph>) {
  return bundle.files.filter(file => file.content.startsWith('---\nknowledge_seed_id:'));
}
function wikiTargets(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]\n]+)\]\]/g)].map(match => match[1].split('|')[0] + '.md');
}

test('default export creates stable ordinary Markdown nodes and a separate immutable audit run, without Canvas', () => {
  const graph = fixture(), bundle = exportGraph(graph, '知识地图/探索', '2026-10-04-run');
  assert.equal(bundle.folder, '知识地图/探索/Runs/2026-10-04-run');
  assert.equal(bundle.canvasPath, undefined);
  assert.equal(bundle.files.some(file => file.path.endsWith('.canvas')), false);
  assert.equal(generatedFiles(bundle).length, 3);
  assert.equal(bundle.rootPath, bundle.nodePaths[graph.nodes[0].id]);
  assert.ok(bundle.rootPath.startsWith('知识地图/探索/起点/'));
  assert.ok(bundle.nodePaths[graph.nodes[1].id].startsWith('知识地图/探索/网页/'));
  assert.ok(bundle.nodePaths[graph.nodes[3].id].startsWith('知识地图/探索/概念/'));
  for (const file of generatedFiles(bundle)) assert.ok(!file.path.startsWith(bundle.folder + '/'));
  assert.deepEqual(JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content), graph);
  const scope = new RegExp(bundle.search.slice('path:/'.length, -1));
  assert.ok(scope.test('研究笔记/预测编码 与 误差.md'));
  assert.ok(!scope.test(bundle.overviewPath));
  assert.ok(!scope.test('其他/' + bundle.rootPath));
  const next = exportGraph(graph, '知识地图/探索', 'second-run');
  assert.deepEqual(next.nodePaths, bundle.nodePaths);
  assert.notEqual(next.folder, bundle.folder);
});

test('default exported native names omit publisher branding and internal IDs', () => {
  const graph = fixture(); graph.nodes[1].title = 'Predictive coding - Wikipedia, the free encyclopedia-web-1234567812345678';
  const bundle = exportGraph(graph, 'Maps', 'names');
  assert.equal(bundle.nodePaths[graph.nodes[0].id], 'Maps/起点/预测编码.md');
  assert.equal(bundle.nodePaths[graph.nodes[1].id], 'Maps/网页/Predictive coding.md');
  assert.equal(JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content).nodes[1].title, 'Predictive coding');
  assert.ok(bundle.files.find(file => file.path.endsWith('/网页/Predictive coding.md'))!.content.includes(graph.nodes[1].id));
});

test('a note-seed entry filename distinguishes navigation before discovery while retaining entity identity, original prose and earlier paths',async()=>{
  const origin='用户笔记/学习科学.md',rootId=nodeId('seed',`note:${origin}`),noteId=nodeId('note',origin),original='# 学习科学\n\n这是用户自己的详细正文，必须保留全部字节。\n';
  const root={id:rootId,kind:'seed' as const,title:'学习科学',excerpt:'先建立入口，再逐步发现概念。',status:'derived' as const,depth:0};
  const graph:KnowledgeGraph={...fixture(),seed:origin,nodes:[root],edges:[],request:{seed:{kind:'note',value:origin},options:{...defaults,graphDepth:5}}};
  const first=exportGraph(graph,'Maps','entry-first',{rootFileTitle:'学习科学（图谱入口）'}),memory=memoryWriter({[origin]:original});
  assert.equal(first.rootPath,'Maps/起点/学习科学(图谱入口).md');assert.equal(first.nodePaths[rootId],first.rootPath);
  const content=first.files.find(file=>file.path===first.rootPath)!.content;
  assert.ok(content.includes('图谱入口'));assert.ok(content.includes('先建立入口，再逐步发现概念。'));
  assert.ok(wikiTargets(content).includes(origin));assert.ok(content.includes('title: "学习科学"'));
  assert.deepEqual(JSON.parse(first.files.find(file=>file.path.endsWith('/graph.json'))!.content),graph);
  await saveBundle(first,memory.writer);assert.equal(memory.entries.get(origin),original);
  graph.nodes.push({id:noteId,kind:'note',title:'学习科学',locator:origin,excerpt:'已有笔记',depth:1,status:'retrieved',bodyAvailable:true});
  graph.edges.push({id:'entry-source',from:rootId,to:noteId,relation:'seed_source',evidence:[{sourceId:noteId,quote:'用户指定已有笔记',method:'指定来源'}]});
  const second=exportGraph(graph,'Maps','entry-second',{rootFileTitle:'学习科学（图谱入口）',nodePaths:first.nodePaths,existing:{[first.rootPath]:rootId}});
  await saveBundle(second,memory.writer);
  assert.equal(second.rootPath,first.rootPath);assert.equal(second.nodePaths[noteId],origin);assert.equal(memory.entries.get(origin),original);
  assert.equal(second.updates.length,1);assert.equal(second.updates[0].path,first.rootPath);
  assert.equal(graph.nodes[0].id,rootId);assert.equal(graph.nodes[0].title,'学习科学');assert.equal(graph.request?.seed.value,origin);
  const oldPath='Maps/起点/旧学习入口.md';
  const legacy=exportGraph(graph,'Maps','entry-legacy',{rootFileTitle:'学习科学（图谱入口）',nodePaths:{[rootId]:oldPath},existing:{[oldPath]:rootId}});
  assert.equal(legacy.rootPath,oldPath,'a navigation display label cannot migrate an earlier saved file');
  assert.equal(legacy.nodePaths[noteId],origin);assert.ok(!legacy.files.some(file=>file.path===first.rootPath));
  assert.equal(legacy.updates[0].path,oldPath);
});

test('generated names preserve Unicode pairs at the 64-code-unit boundary and export encoded native links',()=>{
  const title='&'+'😀'.repeat(32),name='&'+'😀'.repeat(31);
  assert.equal(safeName(title),name);assert.equal(name.length,63);
  const path=`Maps/概念/${name}.md`;
  assert.doesNotThrow(()=>nativeLink(path,title),'an encoded alias must not fail with URI malformed');
  const graph=fixture();graph.nodes[3].title=title;
  const bundle=exportGraph(graph,'Maps','unicode-boundary');
  assert.equal(bundle.nodePaths[graph.nodes[3].id],path);
  const source=bundle.files.find(file=>file.path===bundle.nodePaths[graph.nodes[0].id])!.content;
  assert.ok(source.includes(encodeURIComponent(name)));
  const concept=bundle.files.find(file=>file.path===path)!.content;
  assert.ok(concept.includes(`title: ${JSON.stringify(title)}`),'the displayed knowledge title must remain complete');
  assert.equal(safeName('😀'.repeat(32)),'😀'.repeat(32));
  assert.equal(safeName('a'.repeat(62)+'😀'),'a'.repeat(62)+'😀');
  assert.equal(safeName('a'.repeat(63)+'𠀀'),'a'.repeat(63));
  assert.equal(safeFolder('😀'.repeat(32)),'😀'.repeat(32));
  assert.throws(()=>safeFolder(title),/输出目录/,'the existing folder length limit must remain enforced');
});

test('leading-dot knowledge names produce ordinary filenames without changing their source identity or content', () => {
  const cases = [
    { title: '.hack系列', name: 'hack系列', normalized: '.hack系列' },
    { title: '.NET', name: 'NET', normalized: '.NET' },
    { title: '．hack', name: 'hack', normalized: '.hack' },
    { title: '.. 名称', name: '名称', normalized: '.. 名称' },
  ];
  const paragraph = '来源正文保留完整段落，以及作品名称和背景证据。';
  for (const { title, name, normalized } of cases) {
    assert.equal(safeName(title), name);
    const graph = fixture(), web = graph.nodes[1], concept = graph.nodes[3];
    web.title = title;
    web.locator = 'https://zh.wikipedia.org/wiki/.hack';
    web.article = { blocks: [{ type: 'paragraph', text: paragraph }], textChars: paragraph.length,
      totalTextChars: paragraph.length, truncated: false };
    concept.title = title;
    concept.entityUrl = web.locator;
    const original = structuredClone(graph);
    const bundle = exportGraph(graph, 'Maps', 'dot-name');
    assert.equal(bundle.nodePaths[web.id], `Maps/网页/${name}.md`);
    assert.equal(bundle.nodePaths[concept.id], `Maps/概念/${name}.md`);
    for (const path of Object.values(bundle.nodePaths)) assert.ok(path.split('/').every(part => !part.startsWith('.')), path);
    const audit = JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content) as KnowledgeGraph;
    const savedWeb = audit.nodes.find(node => node.id === web.id)!;
    const savedConcept = audit.nodes.find(node => node.id === concept.id)!;
    assert.equal(savedWeb.title, normalized);
    assert.equal(savedConcept.title, normalized);
    assert.equal(savedWeb.locator, web.locator);
    assert.equal(savedConcept.entityUrl, concept.entityUrl);
    assert.deepEqual(savedWeb.article, web.article);
    const content = bundle.files.find(file => file.path === bundle.nodePaths[web.id])!.content;
    assert.ok(content.includes(`title: ${JSON.stringify(normalized)}`));
    assert.ok(content.includes(`knowledge_seed_id: ${JSON.stringify(web.id)}`));
    assert.ok(content.includes(paragraph));
    assert.deepEqual(graph, original, 'filename allocation must not mutate the source graph');
  }
  assert.equal(safeName('... '), 'Untitled');
});

test('a leading-dot concept shares a safe basename with an existing manual note without overwriting it', async () => {
  const graph = fixture(), note = graph.nodes[2], concept = graph.nodes[3];
  note.title = 'hack系列';
  note.locator = 'Maps/概念/hack系列.md';
  concept.title = '.hack系列';
  concept.entityUrl = 'https://zh.wikipedia.org/wiki/.hack';
  const manual = '# hack系列\n\n人工笔记与来源批注必须完整保留。\n';
  const memory = memoryWriter({ [note.locator]: manual });
  const bundle = exportGraph(graph, 'Maps', 'dot-collision');
  assert.equal(bundle.nodePaths[note.id], note.locator);
  assert.equal(bundle.nodePaths[concept.id], 'Maps/概念/hack系列 (2).md');
  await saveBundle(bundle, memory.writer);
  assert.equal(memory.entries.get(note.locator), manual);
  assert.ok(!memory.writes.includes(note.locator));
  assert.deepEqual(memory.updates, []);
  assert.ok(memory.entries.get(bundle.nodePaths[concept.id])!.includes('title: ".hack系列"'));
});

test('ordinary generated dot-name filenames do not relax traversal or hidden-path validation', () => {
  for (const path of ['../secret.md', 'Maps/概念/../secret.md', 'Maps/概念/./secret.md',
    '.obsidian/private.md', 'Maps/.obsidian/private.md', 'Maps/概念/.hack系列.md']) {
    assert.throws(() => nativeLink(path), /无效的库内笔记路径/);
    assert.throws(() => encodedMarkdown(path), /无效的库内笔记路径/);
    const graph = fixture();
    assert.throws(() => exportGraph(graph, 'Maps', 'hidden-allocation', { nodePaths: { [graph.nodes[3].id]: path } }), /无效的库内笔记路径/);
    graph.nodes[2].locator = path;
    assert.throws(() => exportGraph(graph, 'Maps', 'hidden-original'), /无效的库内笔记路径/);
  }
});

test('existing note and concept locators map to original native nodes and are never created or updated', async () => {
  const graph = fixture(); graph.nodes[3].locator = '既有概念/预测误差.md';
  graph.nodes[2].managedId = 'previous-owner';
  const bundle = exportGraph(graph, 'Maps', 'original', {
    nodePaths: { [graph.nodes[2].id]: 'Maps/概念/错误重映射.md' },
    existing: { '研究笔记/预测编码 与 误差.md': 'previous-owner', '既有概念/预测误差.md': graph.nodes[3].id },
  });
  assert.equal(bundle.nodePaths[graph.nodes[2].id], graph.nodes[2].locator);
  assert.equal(bundle.nodePaths[graph.nodes[3].id], graph.nodes[3].locator);
  assert.equal(generatedFiles(bundle).length, 2);
  assert.equal(bundle.updates.length, 0);
  const originals = { '研究笔记/预测编码 与 误差.md': '# 用户原文\n\n[[我的笔记]]', '既有概念/预测误差.md': '# 既有定义' };
  const memory = memoryWriter(originals);
  await saveBundle(bundle, memory.writer);
  for (const [path, content] of Object.entries(originals)) assert.equal(memory.entries.get(path), content);
  assert.deepEqual(memory.updates, []);
});

test('only graph neighbours become wikilinks; evidence sources and audit records add no extra edges', () => {
  const graph = fixture(), bundle = exportGraph(graph, 'Maps', 'neighbours');
  const concept = bundle.files.find(file => file.path === bundle.nodePaths[graph.nodes[3].id])!;
  assert.deepEqual(new Set(wikiTargets(concept.content)), new Set([bundle.nodePaths[graph.nodes[0].id], graph.nodes[2].locator!]));
  assert.ok(!wikiTargets(concept.content).includes(bundle.nodePaths[graph.nodes[1].id]));
  assert.ok(concept.content.includes('Predictive coding'));
  const overview = bundle.files.find(file => file.path === bundle.overviewPath)!;
  assert.deepEqual(wikiTargets(overview.content), []);
  assert.ok(overview.content.includes('不证明因果'));
  assert.ok(!overview.content.includes('undefined'));
});

test('public evidence URLs use explicit targets without absorbing Chinese punctuation or escaping URL characters', () => {
  const graph = fixture(), source = graph.nodes[1], concept = graph.nodes[3];
  source.locator = 'https://example.org/A_B_(C)?encoded=%E4%B8%AD&q=alpha%20beta&ratio=50%25';
  const evidence = graph.edges.find(edge => edge.id === 'edge-extra')!.evidence[0];
  evidence.method = '已读取来源正文中的实际超链接；不是模型推断';
  evidence.locator = 'https://example.org/search?query=A_B%20(C)&percent=50%25';
  evidence.quote = source.locator;
  const snapshot = structuredClone(graph), bundle = exportGraph(graph, 'Maps', 'bounded-source-links');
  const content = bundle.files.find(file => file.path === bundle.nodePaths[concept.id])!.content;
  assert.ok(content.includes('来源：Predictive coding（[原始网页](https://example.org/A_B_%28C%29?encoded=%E4%B8%AD&q=alpha%20beta&ratio=50%25)）；已读取来源正文中的实际超链接；不是模型推断'));
  assert.ok(content.includes('；检索接口：[检索接口](https://example.org/search?query=A_B%20%28C%29&percent=50%25)\n'));
  assert.doesNotMatch(content, /\]\([^\n]*\\_|\]\([^\n]*&#37;/);
  assert.ok(content.includes(`    > \` ${source.locator} \``));
  assert.ok(bundle.files.find(file => file.path === bundle.overviewPath)!.content.includes(`    > \` ${source.locator} \``));
  assert.ok(content.includes('来源：预测编码 与 误差（研究笔记/预测编码 与 误差.md）；原文提及'));
  assert.deepEqual(new Set(wikiTargets(content)), new Set([bundle.rootPath, graph.nodes[2].locator!]));
  assert.deepEqual(graph, snapshot);
  assert.deepEqual(JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content), snapshot);
  const sourceContent = bundle.files.find(file => file.path === bundle.nodePaths[source.id])!.content;
  assert.ok(sourceContent.includes('原始网页：[打开原始网页](https://example.org/A_B_%28C%29?encoded=%E4%B8%AD&q=alpha%20beta&ratio=50%25)'));
});

test('non-public and non-HTTP evidence locators stay inert while vault paths add no native edges', () => {
  for (const locator of ['http://127.0.0.1/private', 'https://localhost/private', 'https://example.internal/private',
    'file:///C:/private.md', 'obsidian://open?vault=private', 'javascript:`[[来源注入]]`', '//localhost/private', 'www.example.internal/private']) {
    const graph = fixture(), concept = graph.nodes[3], source = graph.nodes[1];
    source.locator = locator;
    const evidence = graph.edges.find(edge => edge.id === 'edge-extra')!.evidence[0];
    evidence.locator = locator; evidence.quote = locator;
    const snapshot = structuredClone(graph), bundle = exportGraph(graph, 'Maps', 'inert-source-links');
    const content = bundle.files.find(file => file.path === bundle.nodePaths[concept.id])!.content;
    const fence = '`'.repeat((locator.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0) + 1);
    const literal = `${fence} ${locator} ${fence}`;
    assert.ok(content.includes(`（${literal}）；网页提及`), locator);
    assert.ok(content.includes(`；检索接口：${literal}\n`), locator);
    assert.ok(content.includes(`    > ${literal}`), locator);
    assert.ok(bundle.files.find(file => file.path === bundle.overviewPath)!.content.includes(`    > ${literal}`), locator);
    assert.doesNotMatch(content, /\[(?:原始网页|检索接口)\]\(/, locator);
    assert.deepEqual(new Set(wikiTargets(content.split(literal).join(''))), new Set([bundle.rootPath, graph.nodes[2].locator!]), locator);
    assert.deepEqual(graph, snapshot, locator);
    assert.deepEqual(JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content), snapshot, locator);
  }
  const graph = fixture(), local = '私人笔记/[来源]_路径%20.md';
  const ordinaryQuote = '普通引用 https://example.org/A_B_(C)\n仍保留 [[原文]]';
  const evidence = graph.edges.find(edge => edge.id === 'edge-extra')!.evidence[0];
  evidence.locator = local; evidence.quote = ordinaryQuote;
  const bundle = exportGraph(graph, 'Maps', 'local-source-text');
  const content = bundle.files.find(file => file.path === bundle.nodePaths[graph.nodes[3].id])!.content;
  assert.ok(content.includes(`；检索接口：${plainMarkdown(local)}\n`));
  assert.doesNotMatch(content, /\[检索接口\]\(/);
  assert.ok(content.includes(`    > ${plainMarkdown(ordinaryQuote).replace(/\r?\n/g, '\n    > ')}`));
  assert.deepEqual(new Set(wikiTargets(content)), new Set([bundle.rootPath, graph.nodes[2].locator!]));
});

test('explicit friendly allocations are used and owned files become updates instead of new files', () => {
  const graph = fixture(), paths = {
    [graph.nodes[0].id]: 'Maps/起点/预测编码.md',
    [graph.nodes[1].id]: 'Maps/网页/Predictive coding.md',
    [graph.nodes[3].id]: 'Maps/概念/预测误差.md',
  };
  const bundle = exportGraph(graph, 'Maps', 'owned', { nodePaths: paths, existing: { [paths[graph.nodes[0].id]]: graph.nodes[0].id } });
  assert.equal(bundle.rootPath, paths[graph.nodes[0].id]);
  assert.equal(bundle.updates.length, 1);
  assert.equal(bundle.updates[0].ownerId, graph.nodes[0].id);
  assert.ok(bundle.updates[0].lines.some(line => line.includes('[[研究笔记/预测编码 与 误差')));
  assert.ok(!bundle.files.some(file => file.path === bundle.rootPath));
  assert.throws(() => exportGraph(graph, 'Maps', 'wrong-owner', { nodePaths: paths, existing: { [paths[graph.nodes[0].id]]: 'user-note' } }), /不属于/);
});

test('mergeManagedLinks appends only new managed blocks, preserving all existing user bytes and idempotence', () => {
  const owner = 'concept-ab12';
  const original = `---\nknowledge_seed_id: "${owner}"\ntitle: 用户保留标题\n---\n\n# 用户手写正文\n\n私人段落。\n`;
  const first = mergeManagedLinks(original, owner, ['- [[A]]\n  - 来源：原文']);
  assert.ok(first.startsWith(original));
  const manual = first + '\n## 用户继续编辑\n\n不要覆盖这段文字。';
  const second = mergeManagedLinks(manual, owner, ['- [[A]]\n  - 来源：原文', '- [[B]]']);
  assert.ok(second.startsWith(manual));
  assert.equal((second.match(/\[\[A\]\]/g) ?? []).length, 1);
  assert.equal((second.match(/\[\[B\]\]/g) ?? []).length, 1);
  assert.equal(mergeManagedLinks(second, owner, ['- [[A]]\n  - 来源：原文', '- [[B]]']), second);
  assert.equal(mergeManagedLinks(second, owner, []), second);
  const crlf = original.replace(/\n/g, '\r\n');
  assert.ok(mergeManagedLinks(crlf, owner, ['- [[A]]']).startsWith(crlf));
});

test('ownership and managed-marker failures refuse updates to unrelated or malformed notes', () => {
  const owner = 'seed-1234';
  for (const content of ['# 用户笔记', '---\nknowledge_seed_id: "other"\n---\n用户正文', '---\nknowledge_seed_id: seed-1234\nknowledge_seed_id: other\n---\n', '---\nknowledge_seed_id: [seed-1234]\n---\n'])
    assert.throws(() => mergeManagedLinks(content, owner, ['- [[A]]']), /拒绝更新/);
  const content = '---\nknowledge_seed_id: seed-1234\n---\n';
  assert.throws(() => mergeManagedLinks(content + '<!-- knowledge-seed:links:seed-1234 -->', owner, ['- [[A]]']), /标记不完整/);
  assert.throws(() => mergeManagedLinks(content, owner, ['<!-- /knowledge-seed:links:seed-1234 -->']), /控制标记/);
  assert.throws(() => mergeManagedLinks(content, 'bad-->id', []), /标识无效/);
});

test('space-containing paths use native wiki links while reserved link characters use encoded Markdown', () => {
  assert.equal(nativeLink('研究笔记/预测编码 与 误差.md', '原笔记'), '[[研究笔记/预测编码 与 误差|原笔记]]');
  const path = '研究笔记/A #B|[C] (D)%25.md';
  const link = nativeLink(path, '标题 [A]');
  assert.equal(link, encodedMarkdown(path, '标题 [A]'));
  assert.ok(link.includes('%20%23B%7C%5BC%5D%20%28D%29%2525.md'));
  assert.ok(!link.includes('[['));
  assert.ok(link.startsWith('[标题 \\[A\\]]('));
  assert.throws(() => nativeLink('../private.md'), /无效/);
});

test('generated text and frontmatter do not activate imported images, file links or injected graph nodes', () => {
  const graph = fixture(); graph.nodes[1].title += ' [[危险节点]]';
  const bundle = exportGraph(graph, 'Maps', 'inert');
  const web = bundle.files.find(file => file.path === bundle.nodePaths[graph.nodes[1].id])!.content;
  assert.ok(web.includes('\\[\\[隐藏节点\\]\\]'));
  assert.ok(web.includes('!\\[远程图片\\]'));
  assert.ok(web.includes('\\[额外链接\\]'));
  assert.ok(web.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(web.includes('［［危险节点］］'));
  assert.ok(web.includes('读取范围有限'));
  assert.deepEqual(wikiTargets(web), [bundle.rootPath]);
  assert.equal(plainMarkdown('[[A]] [B](C.md)'), '\\[\\[A\\]\\] \\[B\\](C.md)');
});

test('source excerpts, relation evidence and reading errors cannot hide native links with imported Markdown', () => {
  const graph = fixture();
  const unsafe = '保留原文 %% 未闭合注释\n\n```dataviewjs\n[[隐藏的节点]]\n```\n$x$ 与 **粗体** 和 &#37;&#37; 仍是来源文本。';
  graph.nodes[1].excerpt = unsafe;
  graph.nodes[1].reading = { state: 'failed', reason: unsafe };
  graph.edges.find(edge => edge.id === 'edge-extra')!.evidence[0].quote = unsafe;
  const bundle = exportGraph(graph, 'Maps', 'inert-markdown');
  const webpage = bundle.files.find(file => file.path === bundle.nodePaths[graph.nodes[1].id])!.content;
  const concept = bundle.files.find(file => file.path === bundle.nodePaths[graph.nodes[3].id])!.content;
  for (const content of [webpage, concept]) {
    assert.doesNotMatch(content, /%%|(?<!\\)```dataviewjs|(?<!\\)\$x(?<!\\)\$|(?<!\\)\*\*粗体/);
    assert.ok(content.includes('&#37;&#37; 未闭合注释'));
    assert.ok(content.includes('&amp;\\#37;&amp;\\#37; 仍是来源文本。'));
    assert.ok(content.includes('\\[\\[隐藏的节点\\]\\]'));
  }
  assert.deepEqual(wikiTargets(webpage), [bundle.rootPath]);
  assert.deepEqual(new Set(wikiTargets(concept)), new Set([bundle.rootPath, graph.nodes[2].locator!]));
  assert.ok(webpage.includes('读取失败，可重试'));
});

test('untrusted native link aliases use inert Markdown labels while retaining the real target', () => {
  const path = '研究笔记/安全目标.md';
  for (const title of ['原文 %% 未闭合', '```dataviewjs', '$x$', '<img src=x>', '&#37;&#37;']) {
    const link = nativeLink(path, title);
    assert.equal(link, encodedMarkdown(path, title));
    assert.doesNotMatch(link, /\[\[|%%|(?<!\\)```dataviewjs|(?<!\\)\$x(?<!\\)\$|<img/);
    assert.ok(link.endsWith('(研究笔记/安全目标.md)') || link.endsWith(`(${path.split('/').map(encodeURIComponent).join('/')})`));
  }
});

test('source completion replaces a native empty property without creating duplicate ownership metadata', () => {
  for (const empty of ['', 'null', '~']) {
    const before = `---\nknowledge_seed_id: "concept-empty-source"\nkind: concept\nstatus: derived\nsource: ${empty}\ncustom_manual: keep\n---\n\n# 待补词\n\n人工备注。\n`;
    const completed = mergeManagedWebMetadata(before, 'concept-empty-source', 'https://zh.wikipedia.org/wiki/待补词', true);
    assert.equal((completed.match(/^source:/gm) ?? []).length, 1);
    assert.equal(mergeManagedLinks(completed, 'concept-empty-source', []), completed);
    assert.ok(completed.includes('custom_manual: keep\n'));
    assert.ok(completed.endsWith('# 待补词\n\n人工备注。\n'));
    assert.match(completed, /^kind: web$/m);
    assert.match(completed, /^status: retrieved$/m);
  }
});

test('unknown indented source structures cannot be treated as unassigned concept identities', () => {
  for (const field of ['source:\n  https://example.org/existing', 'source:\n  nested: https://example.org/existing', 'entity_url:\n  https://example.org/existing', 'source:\n  null', 'source:\n  ~', 'entity_url:\n  null']) {
    const before = `---\nknowledge_seed_id: "concept-nested-source"\nkind: concept\nstatus: derived\n${field}\n---\n\n# 已有概念\n人工内容。\n`;
    assert.throws(() => mergeManagedWebMetadata(before, 'concept-nested-source', 'https://zh.wikipedia.org/wiki/新来源', true));
  }
});

test('an explicitly owned generated concept persists retry state and new evidence on its original real path', () => {
  const graph = fixture(), concept = graph.nodes[3];
  concept.locator = 'Maps/概念/预测误差.md';
  concept.managedId = 'concept-original-owner';
  concept.bodyAvailable = false;
  concept.reading = { state: 'failed', reason: 'HTTP 503；可再次读取。' };
  const bundle = exportGraph(graph, 'Maps', 'concept-retry', {
    existing: { [concept.locator]: concept.managedId },
  });
  assert.equal(bundle.nodePaths[concept.id], concept.locator);
  assert.equal(bundle.updates.length, 1);
  const update = bundle.updates[0];
  assert.equal(update.path, concept.locator);
  assert.equal(update.ownerId, concept.managedId);
  assert.deepEqual(update.reading, concept.reading);
  assert.ok(update.lines.some(line => line.includes(nativeLink(bundle.rootPath, graph.nodes[0].title))));
  assert.ok(update.lines.some(line => line.includes(nativeLink(graph.nodes[2].locator!, graph.nodes[2].title))));
  assert.ok(!bundle.files.some(file => file.path === concept.locator));
});

test('multiple unresolved views of one owned real concept produce one save update with all evidence and aliases', async () => {
  const graph = fixture(), concept = graph.nodes[3], path = 'Maps/概念/预测误差.md';
  concept.locator = path;
  concept.managedId = 'concept-shared-owner';
  concept.entityUrl = 'https://example.org/prediction-error';
  concept.bodyAvailable = false;
  concept.reading = { state: 'failed', reason: 'HTTP 503；本轮未取得正文。' };
  concept.mergedIds = ['concept-older-a'];
  graph.nodes.push({ ...concept, id: 'concept-local-view', mergedIds: ['concept-older-b'] });
  graph.edges.push({ id: 'edge-local-view', from: graph.nodes[0].id, to: 'concept-local-view', relation: 'mentions',
    evidence: [{ sourceId: graph.nodes[0].id, quote: '第二个视图的提及证据必须保留。', method: '已有双链提及' }] });
  const bundle = exportGraph(graph, 'Maps', 'shared-concept-views', { existing: { [path]: concept.managedId } });
  assert.equal(bundle.nodePaths[concept.id], path);
  assert.equal(bundle.nodePaths['concept-local-view'], path);
  assert.equal(bundle.updates.length, 1);
  assert.equal(bundle.updates[0].ownerId, concept.managedId);
  assert.deepEqual(bundle.updates[0].reading, concept.reading);
  assert.deepEqual(new Set(bundle.updates[0].mergedIds), new Set(['concept-older-a', 'concept-older-b']));
  assert.ok(bundle.updates[0].lines.some(line => line.includes('第二个视图的提及证据必须保留。')));
  assert.ok(bundle.updates[0].lines.some(line => line.includes('网页提及')));
  const original = `---\nknowledge_seed_id: "${concept.managedId}"\nkind: concept\n---\n\n人工内容。\n`;
  const memory = memoryWriter({ [path]: original });
  await saveBundle(bundle, memory.writer);
  assert.deepEqual(memory.updates, [path]);
  assert.ok(memory.entries.get(path)!.startsWith(original));
  assert.ok(memory.entries.has(`${bundle.folder}/COMPLETE.json`));
});

test('user concepts and original vault notes stay unchanged even if an allocation claims their IDs', () => {
  const graph = fixture(), concept = graph.nodes[3], note = graph.nodes[2];
  concept.locator = 'Maps/概念/用户概念.md';
  concept.bodyAvailable = false;
  concept.reading = { state: 'failed', reason: '用户概念只复用路径。' };
  note.managedId = 'outside-original-owner';
  note.reading = { state: 'pending' };
  const bundle = exportGraph(graph, 'Maps', 'user-path-protection', {
    existing: { [concept.locator]: concept.id, [note.locator!]: note.managedId },
  });
  assert.equal(bundle.nodePaths[concept.id], concept.locator);
  assert.equal(bundle.nodePaths[note.id], note.locator);
  assert.deepEqual(bundle.updates, []);
  assert.ok(!bundle.files.some(file => file.path === concept.locator || file.path === note.locator));
});

test('Canvas is opt-in and references reused native notes instead of copied proxies', () => {
  const graph = fixture(), bundle = exportGraph(graph, 'Maps', 'optional', { canvas: true });
  assert.ok(bundle.canvasPath);
  const canvas = JSON.parse(bundle.files.find(file => file.path === bundle.canvasPath)!.content);
  assert.equal(canvas.nodes.length, graph.nodes.length);
  const ids = new Set(canvas.nodes.map((node: { id: string }) => node.id));
  for (const node of canvas.nodes) {
    assert.equal(node.type, 'file'); assert.equal(node.file, bundle.nodePaths[node.id]);
    assert.ok(Number.isInteger(node.x) && node.width > 0);
  }
  for (const edge of canvas.edges) assert.ok(ids.has(edge.fromNode) && ids.has(edge.toNode));
  assert.equal(canvas.nodes.find((node: { id: string }) => node.id === graph.nodes[2].id).file, graph.nodes[2].locator);
});

test('selection removes missing evidence and preserves the exact audit graph without mutating source', () => {
  const graph = fixture(), filtered = filterGraph(graph, new Set(graph.nodes.filter(node => node.kind !== 'web').map(node => node.id)));
  assert.deepEqual(filtered.edges.map(edge => edge.id), ['edge-note', 'edge-concept']);
  const bundle = exportGraph(filtered, 'Maps', 'selected');
  const audit = JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content);
  assert.deepEqual(audit, filtered);
  assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 4);
  const malformed = fixture(); malformed.edges[0].evidence[0].sourceId = 'missing';
  assert.throws(() => exportGraph(malformed, 'Maps', 'bad'), /缺失证据来源/);
});

test('unsafe output paths and allocation collisions fail before saving', () => {
  for (const path of ['../Maps', 'Maps/../Notes', '/tmp/maps', 'C:\\Maps', '.obsidian/maps', 'Maps//nested', 'Maps/./nested', 'CON/Maps', 'Maps/PRN.txt', 'Maps/COM1/nested']) {
    assert.throws(() => safeFolder(path)); assert.throws(() => exportGraph(fixture(), path, 'run'));
  }
  assert.equal(safeFolder('知识地图\\子目录'), '知识地图/子目录');
  assert.equal(safeName('CON'), 'Note-CON');
  assert.ok(!safeName('a %% # [[b]]').includes('%'));
  const graph = fixture();
  assert.throws(() => exportGraph(graph, 'Maps', 'collision', { nodePaths: { [graph.nodes[0].id]: graph.nodes[2].locator! } }), /路径冲突/);
  assert.throws(() => exportGraph(graph, 'Maps', 'outside', { nodePaths: { [graph.nodes[0].id]: 'Private/seed.md' } }), /输出目录/);
});

test('saveBundle completes only after creates and atomic ownership-checked updates', async () => {
  const graph = fixture(), first = exportGraph(graph, 'Maps', 'first'), memory = memoryWriter({ '研究笔记/预测编码 与 误差.md': '# 用户原笔记' });
  await saveBundle(first, memory.writer);
  const existing = Object.fromEntries(generatedFiles(first).map(file => [file.path, graph.nodes.find(node => first.nodePaths[node.id] === file.path)!.id]));
  const second = exportGraph(graph, 'Maps', 'second', { nodePaths: first.nodePaths, existing });
  assert.equal(second.updates.length, 3); assert.equal(generatedFiles(second).length, 0);
  const before = new Map(memory.entries);
  await saveBundle(second, memory.writer);
  assert.equal(memory.writes.at(-1), `${second.folder}/COMPLETE.json`);
  assert.equal(memory.updates.length, 3);
  const complete = JSON.parse(memory.entries.get(`${second.folder}/COMPLETE.json`)!);
  assert.equal(complete.updateCount, 3); assert.equal(complete.fileCount, second.files.length);
  assert.equal(memory.entries.get('研究笔记/预测编码 与 误差.md'), '# 用户原笔记');
  for (const file of generatedFiles(first)) assert.equal(memory.entries.get(file.path), before.get(file.path));
});

test('partial create or update failure never produces a completion marker and records attempted updates', async () => {
  const bundle = exportGraph(fixture(), 'Maps', 'failure'), memory = memoryWriter({}, '/graph.json');
  await assert.rejects(saveBundle(bundle, memory.writer), /simulated write failure/);
  assert.ok(memory.entries.has(`${bundle.folder}/run-status.json`));
  assert.ok(memory.writes.length > 1); assert.ok(!memory.entries.has(`${bundle.folder}/COMPLETE.json`));
  const root = bundle.files.find(file => file.path === bundle.rootPath)!;
  const updateBundle = exportGraph(fixture(), 'Maps', 'update-failure', { nodePaths: bundle.nodePaths, existing: { [bundle.rootPath]: fixture().nodes[0].id } });
  const failing = memoryWriter({ [root.path]: root.content }, undefined, true);
  await assert.rejects(saveBundle(updateBundle, failing.writer), /simulated update failure/);
  const status = JSON.parse(failing.entries.get(`${updateBundle.folder}/run-status.json`)!);
  assert.equal(status.expectedUpdates[0].path, bundle.rootPath);
  assert.ok(!failing.entries.has(`${updateBundle.folder}/COMPLETE.json`));
  assert.equal(failing.entries.get(root.path), root.content);
});

test('all collision and missing-update preflight checks happen before the first create', async () => {
  const bundle = exportGraph(fixture(), 'Maps', 'collision');
  for (const path of [bundle.folder, bundle.files[0].path]) {
    const memory = memoryWriter({ [path]: null });
    await assert.rejects(saveBundle(bundle, memory.writer), /已经存在|文件已存在/);
    assert.deepEqual(memory.writes, []);
  }
  const graph = fixture(), rootId = graph.nodes[0].id;
  const updateBundle = exportGraph(graph, 'Maps', 'missing', { nodePaths: bundle.nodePaths, existing: { [bundle.rootPath]: rootId } });
  const missing = memoryWriter();
  await assert.rejects(saveBundle(updateBundle, missing.writer), /待更新笔记不存在/);
  assert.deepEqual(missing.writes, []);
  const unsupported = memoryWriter({ [bundle.rootPath]: bundle.files.find(file => file.path === bundle.rootPath)!.content });
  delete unsupported.writer.update;
  await assert.rejects(saveBundle(updateBundle, unsupported.writer), /不支持安全更新/);
  assert.deepEqual(unsupported.writes, []);
});

test('writer rechecks actual ownership instead of trusting stale allocation metadata', async () => {
  const graph = fixture(), bundle = exportGraph(graph, 'Maps', 'stale', {
    nodePaths: { [graph.nodes[0].id]: 'Maps/起点/预测编码.md' }, existing: { 'Maps/起点/预测编码.md': graph.nodes[0].id },
  });
  const original = '# 用户替换了原生成笔记，不再属于插件';
  const memory = memoryWriter({ [bundle.rootPath]: original });
  await assert.rejects(saveBundle(bundle, memory.writer), /拒绝更新已有用户笔记/);
  assert.equal(memory.entries.get(bundle.rootPath), original);
  assert.ok(!memory.entries.has(`${bundle.folder}/COMPLETE.json`));
});

test('pending concepts persist explanatory status distinct from their evidence and definition', () => {
  const graph = fixture(), concept = graph.nodes.find(node => node.kind === 'concept')!;
  concept.reading = {state:'no_match',reason:'未找到可确认来源；[[不能造图边]] <script>inert</script>'};
  const bundle = exportGraph(graph, 'Maps', 'pending');
  const note = bundle.files.find(file => file.path === bundle.nodePaths[concept.id])!.content;
  assert.match(note, /^reading_state: no_match$/m);
  assert.match(note, /未找到可确认的来源/);
  assert.ok(!note.includes('[[不能造图边]]'));
  assert.ok(!note.includes('<script>'));
  assert.match(note, /knowledge-seed:reading:/);
  assert.ok(note.includes('提及术语，定义待核实'));
});

test('updating owned reading status preserves manual text and has one well formed block', () => {
  const original = '---\nknowledge_seed_id: "owner"\ntitle: "词项"\n---\n\n# 词项\n\n手写定义和 [[我的链接]]。\n';
  const pending = mergeManagedReading(original,'owner',{state:'reading',reason:'读取尚未完成'});
  assert.match(pending,/^reading_state: pending$/m);
  const ready = mergeManagedReading(pending,'owner',{state:'ready'});
  assert.ok(ready.includes('手写定义和 [[我的链接]]。'));
  assert.equal((ready.match(/<!-- knowledge-seed:reading:owner -->/g) ?? []).length,1);
  assert.match(ready,/^reading_state: ready$/m);
  assert.ok(!ready.includes('读取尚未完成'));
  assert.throws(()=>mergeManagedReading(original,'wrong',{state:'pending'}),/拒绝/);
  assert.throws(()=>mergeManagedReading(pending.replace('<!-- /knowledge-seed:reading:owner -->',''),'owner',{state:'ready'}),/不完整/);
});

test('safe save preflights every existing update and backs up exact original text before modifying any note',async()=>{
  const graph=fixture(),first=exportGraph(graph,'Maps','backup-first'),memory=memoryWriter();await saveBundle(first,memory.writer);
  const existing=Object.fromEntries(generatedFiles(first).map(file=>[file.path,graph.nodes.find(node=>first.nodePaths[node.id]===file.path)!.id]));
  const second=exportGraph(graph,'Maps','backup-second',{nodePaths:first.nodePaths,existing});
  const originals=new Map(second.updates.map(update=>[update.path,memory.entries.get(update.path)!]));
  let prepared=0;
  memory.writer.prepareUpdate=async update=>{prepared++;const before=memory.entries.get(update.path);assert.equal(typeof before,'string');mergeManagedLinks(before!,update.ownerId,update.lines);return before!;};
  memory.writer.journal=async(path,expected,content)=>{assert.equal(memory.entries.get(path),expected);memory.entries.set(path,content);};
  const ordinaryUpdate=memory.writer.update!;
  memory.writer.update=async(...args)=>{
    assert.equal(prepared,second.updates.length);
    for(const[index,update]of second.updates.entries())assert.equal(memory.entries.get(`${second.folder}/backup/update-${index+1}.bak`),originals.get(update.path));
    await ordinaryUpdate(...args);
  };
  await saveBundle(second,memory.writer);
  const status=JSON.parse(memory.entries.get(`${second.folder}/run-status.json`)!);
  assert.equal(status.status,'complete');assert.deepEqual(status.updated,second.updates.map(update=>update.path));
  assert.equal(status.backups.length,second.updates.length);
  assert.ok(status.backups.every((item:{backup:string})=>item.backup.endsWith('.bak')));
  assert.ok(memory.entries.get(`${second.folder}/Recovery.md`)?.includes('不能直接覆盖后来新增的人工内容'));
  assert.equal(JSON.parse(memory.entries.get(`${second.folder}/COMPLETE.json`)!).backupCount,second.updates.length);
});

test('a malformed final update is refused by full preflight before creating backups or changing earlier nodes',async()=>{
  const graph=fixture(),first=exportGraph(graph,'Maps','preflight-original'),memory=memoryWriter();await saveBundle(first,memory.writer);
  const existing=Object.fromEntries(generatedFiles(first).map(file=>[file.path,graph.nodes.find(node=>first.nodePaths[node.id]===file.path)!.id]));
  const second=exportGraph(graph,'Maps','preflight-invalid',{nodePaths:first.nodePaths,existing});
  memory.writer.prepareUpdate=async update=>{const before=memory.entries.get(update.path)!;if(update.path===second.updates.at(-1)!.path)throw new Error('malformed article markers');return before!;};
  const before=new Map(memory.entries),writes=memory.writes.length;
  await assert.rejects(saveBundle(second,memory.writer),/malformed article markers/);
  assert.deepEqual(memory.entries,before);assert.equal(memory.writes.length,writes);
});

test('partial safe saves retain backups and record successful updates without rolling back subsequent edits',async()=>{
  const graph=fixture(),first=exportGraph(graph,'Maps','partial-first'),memory=memoryWriter();await saveBundle(first,memory.writer);
  const existing=Object.fromEntries(generatedFiles(first).map(file=>[file.path,graph.nodes.find(node=>first.nodePaths[node.id]===file.path)!.id]));
  const second=exportGraph(graph,'Maps','partial-second',{nodePaths:first.nodePaths,existing}),before=new Map(memory.entries);
  memory.writer.prepareUpdate=async update=>memory.entries.get(update.path)!;
  memory.writer.journal=async(path,expected,content)=>{assert.equal(memory.entries.get(path),expected);memory.entries.set(path,content);};
  const normalUpdate=memory.writer.update!;let count=0;
  memory.writer.update=async(...args)=>{if(++count===2){memory.entries.set(second.updates[0].path,'后续人工编辑必须留下');throw new Error('disk temporarily unavailable');}await normalUpdate(...args);};
  await assert.rejects(saveBundle(second,memory.writer),/disk temporarily unavailable/);
  const status=JSON.parse(memory.entries.get(`${second.folder}/run-status.json`)!);
  assert.equal(status.status,'partial');assert.deepEqual(status.updated,[second.updates[0].path]);
  assert.equal(status.backups.length,second.updates.length);assert.match(status.error,/disk/);
  assert.equal(memory.entries.get(second.updates[0].path),'后续人工编辑必须留下');
  assert.equal(memory.entries.get(`${second.folder}/backup/update-1.bak`),before.get(second.updates[0].path));
  assert.equal(memory.entries.has(`${second.folder}/COMPLETE.json`),false);
});

test('a save plan is copied before awaits so changed preview rows cannot change accepted content',async()=>{
  const bundle=exportGraph(fixture(),'Maps','freeze-save'),memory=memoryWriter();
  const original=bundle.files[0].content,firstPath=bundle.files[0].path;
  const normalExists=memory.writer.exists;
  memory.writer.exists=async path=>{bundle.files[0].content='late UI content';return normalExists(path);};
  await saveBundle(bundle,memory.writer);
  assert.equal(memory.entries.get(firstPath),original);
});
