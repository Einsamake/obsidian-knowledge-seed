import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { articleBodyTextChars, articlePlainText, type ArticleContent } from '../src/article';
import { generateGraph, MAX_TOTAL_WEB_CHARS, type EngineAdapter, type Seed } from '../src/engine';
import { exportGraph, mergeManagedArticle, mergeManagedLinks, saveBundle, webReading, type Writer } from '../src/export';
import { filterGraph, nodeId, type GraphNode } from '../src/graph';
import { extractWebDocument } from '../src/web';

Object.assign(globalThis, { DOMParser });
const url = 'https://zh.wikipedia.org/wiki/知识图谱';
const lead = '知识图谱以可追溯的实体和关系组织研究知识。'.repeat(85);
const tail = '尾部独有事实：关系成立须有可检查的原文条件。';
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title} - 维基百科，自由的百科全书</title></head><body>
  <h1 id="firstHeading">${title}</h1><div id="mw-content-text"><div class="mw-parser-output">${body}</div></div></body></html>`;
const richHtml = page('知识图谱', `<p>${lead}</p><h2>适用条件与后续验证</h2><p>${tail} [[隐藏笔记]] [额外链接](私人.md)</p>
  <ul><li>核对原始文本。</li><li>记录证据边界。</li></ul><table><tr><th>条件</th><th>结论</th></tr><tr><td>来源充分</td><td>允许核验</td></tr></table>
  <blockquote>引用保持原文。</blockquote><pre><code class="language-dataviewjs">[[代码笔记]]</code></pre>
  <nav>网页导航杂项</nav><h2>参考文献</h2><p>辅助文献尾页</p>`);
const adapter = (html = richHtml): EngineAdapter => ({
  request: async requested => requested.includes('/w/api.php?')
    ? { status: 200, text: JSON.stringify({ query: { search: [{ title: '知识图谱', snippet: '知识图谱研究实体关系与原文证据。' }] } }) }
    : { status: 200, text: html, headers: { 'content-type': 'text/html' } },
  listNotes: () => [], readNote: async () => { throw new Error('unexpected note read'); }, resolveLink: () => null,
});
const webNode = (article?: ArticleContent): GraphNode => ({ id: nodeId('web', url), kind: 'web', title: '知识图谱',
  sourceTitle: '知识图谱 - 维基百科，自由的百科全书', locator: url, excerpt: '旧版短摘录',
  status: 'retrieved', depth: 1, retrievedAt: '2026-10-08T00:00:00.000Z', ...(article ? { article } : {}) });
const article = () => extractWebDocument(richHtml, url, 24000).article;
const owned = (id: string) => `---\nknowledge_seed_id: "${id}"\ntitle: "人工保留标题"\n---\n\n# 人工标题\n\n人工开头：不属于正文管理区。\n`;
const articleStarts = (content: string) => (content.match(/<!-- knowledge-seed:article:/g) ?? []).length;

for (const seed of [{ kind: 'topic', value: '知识图谱' }, { kind: 'url', value: url }] as Seed[]) {
  test(`${seed.kind} discovery carries retained sections beyond the 900-character preview into native notes and audit JSON`, async () => {
    const graph = await generateGraph(seed, adapter(), { maxPages: 1, maxNotes: 0, maxConcepts: 0, depth: 0, maxBodyChars: 24000 });
    const source = graph.nodes.find(node => node.kind === 'web')!;
    assert.ok(source); assert.equal(source.excerpt.length, 900); assert.ok(!source.excerpt.includes(tail));
    assert.ok(source.article); assert.match(articlePlainText(source.article), /尾部独有事实/);
    assert.ok(source.article.blocks.some(block => block.type === 'heading' && block.text === '适用条件与后续验证'));
    const selected = filterGraph(graph, new Set(graph.nodes.map(node => node.id)));
    const bundle = exportGraph(selected, 'Maps', `${seed.kind}-reading`);
    const note = bundle.files.find(file => file.path === bundle.nodePaths[source.id])!.content;
    assert.match(note, /尾部独有事实/); assert.match(note, /## 导读（原文摘录）/); assert.match(note, /并非自动总结/);
    assert.match(note, /## 目录/); assert.ok(note.includes(encodeURIComponent('适用条件与后续验证')));
    assert.match(note, /## 正文/); assert.match(note, /来源与阅读范围/); assert.match(note, /已读取可提取的清理后正文/);
    assert.match(note, /^- 核对原始文本。/m); assert.match(note, /\| 条件 \| 结论 \|/); assert.match(note, /^> 引用保持原文。/m);
    assert.match(note, /```text\n\[\[代码笔记\]\]\n```/);
    assert.doesNotMatch(note, /网页导航杂项|辅助文献尾页|```dataviewjs/);
    // Only relationship lines introduce vault links; original prose is escaped and code stays inert.
    const withoutCode = note.replace(/```text\n[\s\S]*?\n```/g, '');
    const targets = [...withoutCode.matchAll(/(?<!\\)\[\[([^\]\n]+)\]\]/g)].map(match => match[1].split('|')[0] + '.md');
    assert.deepEqual(targets, [bundle.rootPath]);
    assert.equal(bundle.files.some(file => file.path.endsWith('.canvas')), false);
    const savedGraph = JSON.parse(bundle.files.find(file => file.path.endsWith('/graph.json'))!.content);
    const savedArticle = savedGraph.nodes.find((node: GraphNode) => node.id === source.id).article;
    assert.deepEqual(savedArticle, source.article); assert.match(articlePlainText(savedArticle), /尾部独有事实/);
  });
}

test('old low reading budgets retain at least 2000 body characters through a complete paragraph without an orphan chapter, and legacy excerpts remain exportable', async () => {
  const firstParagraph = '知识图谱的关系需要核验来源。'.repeat(200);
  const secondParagraph = '未保留的后续段落需要更多正文预算。'.repeat(200);
  assert.ok(firstParagraph.length > 2000);
  const html = page('知识图谱', `<p>${firstParagraph}</p><h2>不应孤立保留的后续章节</h2><p>${secondParagraph}</p>`);
  const graph = await generateGraph({ kind: 'url', value: url }, adapter(html), { maxPages: 1, searchLimit: 0, maxNotes: 0, maxConcepts: 0, depth: 0, maxBodyChars: 1000 });
  const source = graph.nodes.find(node => node.kind === 'web')!;
  const reading = webReading(source)!;
  assert.equal(source.article!.truncated, true);
  assert.equal(articleBodyTextChars(source.article!), firstParagraph.length);
  assert.deepEqual(source.article!.blocks, [{ type: 'paragraph', text: firstParagraph }]);
  assert.ok(reading.markdown.includes(firstParagraph));
  assert.match(reading.markdown, /当前目录仅包含本次保留的章节/);
  assert.doesNotMatch(reading.markdown, /不应孤立保留的后续章节|未保留的后续段落/);
  const legacy = structuredClone(graph); delete legacy.nodes.find(node => node.id === source.id)!.article;
  legacy.nodes.find(node => node.id === source.id)!.excerpt = '旧版只有摘录，保留它以便兼容。';
  assert.equal(webReading(webNode()), undefined);
  const output = exportGraph(legacy, 'Maps', 'legacy');
  const legacyNote = output.files.find(file => file.path === output.nodePaths[source.id])!.content;
  assert.ok(legacyNote.includes('旧版只有摘录，保留它以便兼容'));
  const upgraded = mergeManagedArticle(legacyNote, source.id, webReading(webNode(article()))!);
  assert.ok(upgraded.startsWith(legacyNote)); assert.match(upgraded, /尾部独有事实/);
});

test('a genuinely short source keeps its entire original body and explicitly reports insufficient original length', async () => {
  const shortBody = '知识图谱以实体和关系组织信息，研究结论需要保留来源证据与获取时间。'.repeat(6);
  assert.ok(shortBody.length >= 80 && shortBody.length < 2000);
  const graph = await generateGraph({ kind: 'url', value: url }, adapter(page('知识图谱', `<p>${shortBody}</p>`)),
    { maxPages: 1, searchLimit: 0, maxNotes: 0, maxConcepts: 0, depth: 0, maxBodyChars: 2000 });
  const source = graph.nodes.find(node => node.kind === 'web')!;
  assert.ok(source.article);
  assert.equal(source.article.truncated, false);
  assert.equal(articleBodyTextChars(source.article), shortBody.length);
  assert.deepEqual(source.article.blocks, [{ type: 'paragraph', text: shortBody }]);
  const reading = webReading(source)!;
  assert.ok(reading.markdown.includes(shortBody));
  assert.match(reading.markdown, /原文不足\s*2000/);
});

test('same retained body with a later retrieval time deduplicates, and a changed intact body replaces only its own block', () => {
  const node = webNode(article()), first = webReading(node)!;
  const base = mergeManagedLinks(owned(node.id), node.id, ['- 人工已确认关系 [[研究/原笔记]]']);
  const original = mergeManagedArticle(base, node.id, first) + '\n人工尾注：应当原样保留。\n';
  const later = webReading({ ...node, retrievedAt: '2026-10-09T00:00:00.000Z' })!;
  assert.equal(first.contentKey, later.contentKey); assert.equal(mergeManagedArticle(original, node.id, later), original);
  const changedArticle = structuredClone(node.article!);
  changedArticle.blocks.push({ type: 'paragraph', text: '新版额外事实经过来源核验。' });
  changedArticle.textChars = articlePlainText(changedArticle).length; changedArticle.totalTextChars = changedArticle.textChars;
  const changed = webReading({ ...node, article: changedArticle })!;
  const updated = mergeManagedArticle(original, node.id, changed);
  assert.equal(articleStarts(updated), 1); assert.match(updated, /新版额外事实经过来源核验/);
  assert.ok(updated.startsWith(base)); assert.ok(updated.endsWith('\n人工尾注：应当原样保留。\n'));
  assert.equal(mergeManagedArticle(updated, node.id, changed), updated);
});

test('an edited reading body is retained verbatim and exactly one new intact version is appended', () => {
  const node = webNode(article()), reading = webReading(node)!;
  const original = mergeManagedArticle(owned(node.id), node.id, reading);
  const edited = original.replace(tail, '人工修订：我保留不同理解。');
  assert.notEqual(edited, original);
  const firstRefresh = mergeManagedArticle(edited, node.id, reading);
  assert.ok(firstRefresh.startsWith(edited)); assert.match(firstRefresh, /保留人工编辑/); assert.match(firstRefresh, /人工修订：我保留不同理解/);
  assert.match(firstRefresh, /尾部独有事实/); assert.equal(articleStarts(firstRefresh), 2);
  assert.equal(mergeManagedArticle(firstRefresh, node.id, reading), firstRefresh);
});

test('safe article refresh preserves CRLF and refuses ownership or broken local control markers', () => {
  const node = webNode(article()), reading = webReading(node)!;
  const base = owned(node.id).replace(/\n/g, '\r\n');
  const withArticle = mergeManagedArticle(base, node.id, reading);
  assert.equal(/(?<!\r)\n/.test(withArticle), false);
  const changed = { ...reading, contentKey: '1234567890abcdef', markdown: reading.markdown + '\n\n新增正文。' };
  const updated = mergeManagedArticle(withArticle + '\r\n人工尾部\r\n', node.id, changed);
  assert.equal(/(?<!\r)\n/.test(updated), false); assert.ok(updated.startsWith(base)); assert.ok(updated.endsWith('\r\n人工尾部\r\n'));
  assert.throws(() => mergeManagedArticle(withArticle, 'other-owner', reading), /属于/);
  assert.throws(() => mergeManagedArticle(base + `<!-- knowledge-seed:links:${node.id} -->\r\nunfinished`, node.id, reading), /关系区块标记不完整/);
  assert.throws(() => mergeManagedArticle(withArticle.replace(`<!-- /knowledge-seed:article:${node.id} -->`, ''), node.id, changed), /标记不完整/);
  assert.throws(() => mergeManagedArticle(withArticle + `\r\n<!-- /knowledge-seed:article:${node.id} -->`, node.id, changed), /标记不完整/);
  assert.throws(() => mergeManagedArticle(withArticle.replace('## 正文', `<!-- knowledge-seed:article:${node.id}:0000000000000000:0000000000000000 -->\r\n## 正文`), node.id, changed), /标记(?:不完整|嵌套)/);
});

test('remote control-marker text in prose and code cannot forge article or link management blocks', () => {
  const id = nodeId('web', url);
  const start = `<!-- knowledge-seed:article:${id}:0000000000000000:0000000000000000 -->`;
  const end = `<!-- /knowledge-seed:article:${id} -->`;
  const maliciousHtml = page('知识图谱', `<p>${lead}</p><p>正文声称 &lt;!-- knowledge-seed:links:${id} --&gt; [[隐藏笔记]]</p><pre>${start.replaceAll('<', '&lt;')}${end.replaceAll('<', '&lt;')}</pre>`);
  const node = webNode(extractWebDocument(maliciousHtml, url, 24000).article);
  const result = mergeManagedArticle(owned(id), id, webReading(node)!);
  assert.equal(articleStarts(result), 1);
  assert.equal((result.match(/<!-- \/knowledge-seed:article:/g) ?? []).length, 1);
  assert.doesNotMatch(result, /<!-- knowledge-seed:links:/);
  const updated = mergeManagedLinks(result, id, ['- 合法关系 [[研究/真实笔记]]']);
  assert.match(updated, /合法关系/);
  assert.equal(mergeManagedArticle(updated, id, webReading(node)!), updated);
});

test('saveBundle passes detailed readings to the atomic writer when reusing existing native nodes', async () => {
  const graph = await generateGraph({ kind: 'url', value: url }, adapter(), { maxPages: 1, maxNotes: 0, maxConcepts: 0, searchLimit: 0, depth: 0 });
  const first = exportGraph(graph, 'Maps', 'initial');
  const entries = new Map<string, string | null>();
  let articleUpdates = 0;
  const writer: Writer = {
    exists: async path => entries.has(path), mkdir: async path => { entries.set(path, null); },
    create: async (path, content) => { assert.equal(entries.has(path), false); entries.set(path, content); },
    update: async (path, id, lines, reading) => {
      const before = entries.get(path); assert.equal(typeof before, 'string');
      const body = reading ? mergeManagedArticle(before!, id, reading) : before!;
      entries.set(path, mergeManagedLinks(body, id, lines)); if (reading) articleUpdates++;
    },
  };
  await saveBundle(first, writer);
  const source = graph.nodes.find(node => node.kind === 'web')!;
  const sourcePath = first.nodePaths[source.id];
  entries.set(sourcePath, entries.get(sourcePath)! + '\n人工尾注。\n');
  const next = structuredClone(graph); next.nodes.find(node => node.id === source.id)!.retrievedAt = '2026-10-09T00:00:00.000Z';
  const existing = Object.fromEntries(graph.nodes.map(node => [first.nodePaths[node.id], node.id]));
  const second = exportGraph(next, 'Maps', 'repeat', { nodePaths: first.nodePaths, existing });
  assert.ok(second.updates.find(update => update.path === sourcePath)?.article);
  await saveBundle(second, writer);
  assert.equal(articleUpdates, 1); assert.equal(articleStarts(entries.get(sourcePath)!), 1);
  assert.ok(entries.get(sourcePath)!.endsWith('\n人工尾注。\n')); assert.match(entries.get(sourcePath)!, /尾部独有事实/);
  assert.ok(entries.has(`${second.folder}/COMPLETE.json`));
});

test('multi-page capacity never cuts paragraphs or exceeds four million characters, and can still retain a shorter later page', async () => {
  const titles = Array.from({ length: 21 }, (_, index) => `知识图谱容量测试${index + 1}`);
  const longText = '知识图谱容量正文测试'.repeat(23000);
  const shortText = '知识图谱较短正文测试'.repeat(7000);
  assert.equal(longText.length, 230000); assert.equal(shortText.length, 70000);
  let fetchedPages = 0;
  const transport: EngineAdapter = { ...adapter(), request: async requested => {
    if (requested.includes('/w/api.php?')) return { status: 200, text: JSON.stringify({ query: { search: titles.map(title => ({ title, snippet: '知识图谱容量研究。' })) } }) };
    fetchedPages++;
    const title = decodeURIComponent(new URL(requested).pathname.split('/').pop()!);
    const html = page(title, `<p>${title === titles.at(-1) ? shortText : longText}</p>`);
    assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
    return { status: 200, text: html, headers: { 'content-type': 'text/html' } };
  } };
  const graph = await generateGraph({ kind: 'topic', value: '知识图谱' }, transport,
    { maxPages: 40, searchLimit: 30, maxBodyChars: 200000, maxNotes: 0, maxConcepts: 0, depth: 0 });
  const sources = graph.nodes.filter(node => node.kind === 'web');
  const retained = sources.reduce((sum, node) => sum + node.article!.textChars, 0);
  assert.equal(MAX_TOTAL_WEB_CHARS, 4000000); assert.ok(retained <= MAX_TOTAL_WEB_CHARS);
  assert.equal(retained, Math.floor(MAX_TOTAL_WEB_CHARS / longText.length) * longText.length + shortText.length);
  assert.ok(sources.some(node => node.title === titles.at(-1)), 'a rejected oversized paragraph must not block a later page that fits');
  assert.ok(fetchedPages > sources.length && fetchedPages <= titles.length);
  assert.ok(graph.warnings.some(warning => warning.includes('网页读取失败')));
  for (const source of sources) {
    const expected = source.title === titles.at(-1) ? shortText : longText;
    assert.equal(source.excerpt.length, 900);
    assert.equal(source.article!.truncated, false);
    assert.deepEqual(source.article!.blocks, [{ type: 'paragraph', text: expected }]);
  }
});
