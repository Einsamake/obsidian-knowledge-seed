import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceGraph, planLegacyMerges, planSourceMerges, mergeDuplicateContent, mergeGeneratedAliases } from '../src/dedup';
import { nodeId, stableId, type GraphNode, type KnowledgeGraph, type GraphEdge, type Evidence } from '../src/graph';
import { mergeManagedArticle, mergeManagedLinks, webReading } from '../src/export';

const title = '日本电信电话公社';
const url = 'https://zh.wikipedia.org/wiki/日本电信电话公社';
const concept = (extra: Partial<GraphNode> = {}): GraphNode => ({ id: nodeId('concept', title), kind: 'concept', title,
  excerpt: '来源正文中的术语或链接名称，定义与语义关系待核实。', status: 'derived', depth: 2, ...extra });
const web = (extra: Partial<GraphNode> = {}): GraphNode => ({ id: nodeId('web', url), kind: 'web', title, locator: url,
  excerpt: '真实网页正文摘要。', status: 'retrieved', depth: 1, retrievedAt: '2026-10-08T05:15:08.123Z',
  sourceTitle: `${title} - 维基百科，自由的百科全书`,
  article: { blocks: [{ type: 'paragraph', text: '真实网页完整正文及人工验证事实。'.repeat(40) }], textChars: 600, totalTextChars: 600, truncated: false }, ...extra });
const seed: GraphNode = { id: 'seed-root', kind: 'seed', title: '预测编码', excerpt: '', status: 'derived', depth: 0 };
const source: GraphNode = { id: 'web-source', kind: 'web', title: '线性预测编码', locator: 'https://zh.wikipedia.org/wiki/线性预测编码',
  excerpt: '依据该研究，相关机构曾提出研究方案。', status: 'retrieved', depth: 0 };
const evidence = (extra: Partial<Evidence> = {}): Evidence => ({ sourceId: source.id, quote: '来源中同一句话提及该机构。',
  method: '网页正文链接', locator: source.locator, ...extra });
const edge = (from: string, to: string, relation: GraphEdge['relation'], ev = evidence()): GraphEdge => ({
  id: stableId(`${from}|${relation}|${to}`), from, to, relation, evidence: [ev],
});
const graph = (nodes: GraphNode[], edges: GraphEdge[] = []): KnowledgeGraph => ({ version: 1, seed: '预测编码',
  createdAt: '2026-10-08T05:14:52.205Z', nodes, edges, warnings: ['保留原警告'], stats: { pagesAttempted: 2, notesScanned: 0, requests: 2 }, displayDepth: 3 });

test('entity URL identifies a retrieved webpage despite different labels; canonical body and metadata survive', () => {
  const target = web({ mergedIds: ['concept-prior'], depth: 1 });
  const duplicate = concept({ title: 'NTTPC', entityUrl: 'HTTPS://ZH.WIKIPEDIA.ORG:443/wiki/日本电信电话公社#历史', mergedIds: ['concept-older'] });
  const input = graph([seed, source, duplicate, target], [edge(source.id, duplicate.id, 'mentions'), edge(source.id, target.id, 'links_to')]);
  const original = structuredClone(input);
  const result = coalesceGraph(input);
  assert.equal(result.nodes.length, 3);
  assert.ok(!result.nodes.some(n => n.id === duplicate.id));
  const kept = result.nodes.find(n => n.id === target.id)!;
  assert.equal(kept.title, target.title); assert.deepEqual(kept.article, target.article);
  assert.equal(kept.excerpt, target.excerpt); assert.equal(kept.retrievedAt, target.retrievedAt);
  assert.equal(kept.sourceTitle, target.sourceTitle); assert.equal(kept.status, 'retrieved');
  assert.ok(kept.mergedIds?.includes(duplicate.id)); assert.ok(kept.mergedIds?.includes('concept-prior'));
  assert.ok(kept.mergedIds?.includes('concept-older'));
  assert.deepEqual(result.stats, input.stats); assert.ok(result.warnings.includes('保留原警告')); assert.equal(result.displayDepth, 3);
  assert.deepEqual(input, original, 'coalescing must not mutate the preview or retained audit graph');
  assert.deepEqual(coalesceGraph(result), result, 'repeated coalescing should be stable');
});

test('coalescing rewrites all edge endpoints and evidence sources, removes loops, and retains evidence method and locator distinctions', () => {
  const c = concept({ entityUrl: url }), w = web();
  const input = graph([seed, source, c, w], [
    edge(seed.id, c.id, 'mentions', evidence({ sourceId: c.id })),
    edge(seed.id, w.id, 'mentions', evidence({ sourceId: w.id })),
    edge(seed.id, w.id, 'mentions', evidence({ sourceId: w.id, method: '另一种检索方法' })),
    edge(seed.id, w.id, 'mentions', evidence({ sourceId: w.id, locator: 'https://example.org/other' })),
    edge(c.id, source.id, 'mentions', evidence({ sourceId: c.id })),
    edge(w.id, c.id, 'mentions'),
    edge(c.id, c.id, 'links_to'),
  ]);
  const result = coalesceGraph(input);
  assert.equal(result.edges.length, 2);
  assert.ok(result.edges.every(e => e.from !== e.to));
  assert.ok(result.edges.every(e => e.from !== c.id && e.to !== c.id && e.evidence.every(ev => ev.sourceId !== c.id)));
  const merged = result.edges.find(e => e.from === seed.id)!;
  assert.equal(merged.evidence.length, 3);
  assert.ok(merged.evidence.some(ev => ev.method === '另一种检索方法'));
  assert.ok(merged.evidence.some(ev => ev.locator === 'https://example.org/other'));
  assert.equal(merged.id, stableId(`${seed.id}|mentions|${w.id}`));
});

test('same managed identity permits merging an owned Markdown concept proxy into its retrieved web node', () => {
  const w = web({ managedId: 'web-owned-existing' });
  const c = concept({ locator: 'Knowledge Seed/概念/日本电信电话公社.md', managedId: w.managedId });
  assert.equal(coalesceGraph(graph([seed, c, w])).nodes.length, 2);
  const direct = concept({ managedId: web().id });
  assert.equal(coalesceGraph(graph([seed, direct, web()])).nodes.length, 2);
});

test('a different entity URL overrides a matching managed ID and refuses identity conflation', () => {
  const w = web();
  for (const locator of [undefined, 'Knowledge Seed/概念/日本电信电话公社.md']) {
    const c = concept({managedId:w.id,entityUrl:'https://example.org/a-different-entity',locator});
    assert.equal(coalesceGraph(graph([seed,c,w])).nodes.length,3);
  }
});

test('no URL, different public URL, private URL, and discovered-only web never collapse by a matching title', () => {
  for (const c of [concept(), concept({ entityUrl: 'https://example.org/different' }), concept({ entityUrl: 'http://127.0.0.1/private' })])
    assert.equal(coalesceGraph(graph([seed, c, web()])).nodes.length, 3);
  assert.equal(coalesceGraph(graph([seed, concept({ entityUrl: url }), web({ status: 'discovered', article: undefined })])).nodes.length, 3);
});

test('ordinary user Markdown notes remain separate even when they have the concept URL or matching labels', () => {
  const c = concept({ locator: 'My Research/日本电信电话公社.md', entityUrl: url });
  assert.equal(coalesceGraph(graph([seed, c, web()])).nodes.length, 3);
  const note: GraphNode = { ...concept({ entityUrl: url }), kind: 'note', id: 'note-my-research', locator: 'My Research/日本电信电话公社.md' };
  assert.equal(coalesceGraph(graph([seed, note, web()])).nodes.length, 3);
});

test('a URL matching several retrieved webpage candidates is ambiguous and does not collapse', () => {
  const c = concept({ entityUrl: url });
  const w1 = web(), w2 = web({ id: 'web-second', managedId: 'web-second-owned' });
  assert.equal(coalesceGraph(graph([seed, c, w1, w2])).nodes.length, 4);
});

test('seed and non-concept roles stay intact even when their locator or managed ID equals the webpage', () => {
  const w = web(), start: GraphNode = { ...seed, title, locator: url, managedId: w.id, entityUrl: url };
  const other: GraphNode = { ...w, id: 'web-other', managedId: w.id };
  const result = coalesceGraph(graph([start, w, other]));
  assert.deepEqual(result.nodes.find(n => n.id === start.id), start); assert.equal(result.nodes.length, 3);
});

const owned = (id: string, body: string, extra = '') => `---\nknowledge_seed_id: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\n${extra}---\n\n${body}\n`;
function legacyFixture() {
  const c = concept(), w = web();
  const paths = { [c.id]: `Knowledge Seed/概念/${title}.md`, [w.id]: `Knowledge Seed/网页/${title}.md` };
  const target = mergeManagedArticle(owned(w.id, `# ${title}\n\n网页人工笔记：需完整保留。`), w.id, webReading(w)!);
  const conceptContent = mergeManagedLinks(owned(c.id, `# ${title}\n\n概念人工补充：机构身份已经确认。`, 'custom_review: "人工已核实"\n'), c.id,
    ['- 来源关系 [[Knowledge Seed/网页/线性预测编码]]\n  > 来源中同一句话提及该机构。']);
  const g = graph([seed, source, c, w], [edge(source.id, c.id, 'mentions'), edge(source.id, w.id, 'links_to')]);
  const notes = [
    { path: paths[c.id], ownerId: c.id, title, kind: 'concept' as const, content: conceptContent },
    { path: paths[w.id], ownerId: w.id, title, kind: 'web' as const, source: url, content: target },
  ];
  return { c, w, g, paths, notes, target, conceptContent };
}

test('legacy same-title mention and followed-page pairs receive one owned, content-bearing merge plan', () => {
  const f = legacyFixture();
  const plans = planLegacyMerges(f.g, f.paths, f.notes);
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.from, f.paths[f.c.id]); assert.equal(p.to, f.paths[f.w.id]);
  assert.equal(p.fromId, f.c.id); assert.equal(p.toId, f.w.id); assert.equal(p.title, title);
  assert.ok(p.reason); assert.ok(p.fromHash); assert.ok(p.toHash);
  assert.deepEqual(f.notes[0].content, f.conceptContent);
});

test('legacy plans require identical quote and identical provenance source for mentions versus links_to', () => {
  for (const change of [
    (g: KnowledgeGraph) => { g.edges[1].evidence[0].quote = '来自同一网页的另一句话。'; },
    (g: KnowledgeGraph) => { g.edges[1].evidence[0].sourceId = seed.id; },
    (g: KnowledgeGraph) => { g.edges[1].from = seed.id; },
    (g: KnowledgeGraph) => { g.edges[1].relation = 'search_match'; },
  ]) {
    const f = legacyFixture(); change(f.g);
    assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
  }
});

test('a live web note source different from its historical locator cannot authorize a legacy merge', () => {
  const f = legacyFixture();
  f.notes[1].source = 'https://example.org/another-institution';
  assert.deepEqual(planLegacyMerges(f.g,f.paths,f.notes),[]);
});

test('legacy plans reject short empty placeholders, unrelated labels, discovered pages, and non-derived concepts', () => {
  for (const change of [
    (f: ReturnType<typeof legacyFixture>) => { f.notes[1].content = owned(f.w.id, '# 同名空白占位'); f.w.article = undefined; f.w.excerpt = ''; },
    (f: ReturnType<typeof legacyFixture>) => { f.c.title = '不同机构'; f.notes[0].title = '不同机构'; },
    (f: ReturnType<typeof legacyFixture>) => { f.w.status = 'discovered'; },
    (f: ReturnType<typeof legacyFixture>) => { f.c.kind = 'note'; },
  ]) {
    const f = legacyFixture(); change(f);
    assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
  }
});

test('legacy plans reject incorrect canonical concept IDs and corrupted ownership or relationship markers', () => {
  for (const change of [
    (f: ReturnType<typeof legacyFixture>) => { f.c.id = 'concept-unrelated'; f.paths[f.c.id] = f.notes[0].path; },
    (f: ReturnType<typeof legacyFixture>) => { f.notes[0].ownerId = 'concept-unrelated'; },
    (f: ReturnType<typeof legacyFixture>) => { f.notes[1].content = f.notes[1].content.replace(f.w.id, 'web-other-owner'); },
    (f: ReturnType<typeof legacyFixture>) => { f.notes[0].content = f.notes[0].content.replace(`<!-- /knowledge-seed:links:${f.c.id} -->`, ''); },
  ]) {
    const f = legacyFixture(); change(f);
    assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
  }
});

test('legacy plans never include Runs audit paths, traversal paths, or unowned ordinary files', () => {
  for (const path of [`Knowledge Seed/Runs/run-1/${title}.md`, `../${title}.md`]) {
    const f = legacyFixture(); f.paths[f.c.id] = path; f.notes[0].path = path;
    assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
  }
  const f = legacyFixture(); f.paths[f.c.id] = `Research/${title}.md`; f.notes[0].path = f.paths[f.c.id];
  f.notes[0].content = '# 我的机构研究\n\n未经插件生成的普通用户笔记。';
  assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
});

test('legacy same-title collisions with multiple owned retrieved web pages require human disambiguation', () => {
  const f = legacyFixture();
  const other = web({ id: nodeId('web', 'https://example.org/other'), locator: 'https://example.org/other' });
  f.g.nodes.push(other); f.g.edges.push(edge(source.id, other.id, 'links_to'));
  f.paths[other.id] = `Knowledge Seed/网页/${title}-2.md`;
  f.notes.push({ path: f.paths[other.id], ownerId: other.id, title, kind: 'web', source: other.locator!,
    content: mergeManagedArticle(owned(other.id, '# 第二个同名网页'), other.id, webReading(other)!) });
  assert.deepEqual(planLegacyMerges(f.g, f.paths, f.notes), []);
});

test('merging legacy content preserves target prose, source custom properties, manual text, and evidence with canonical ownership', () => {
  const f = legacyFixture(), candidate = planLegacyMerges(f.g, f.paths, f.notes)[0];
  assert.ok(candidate);
  const result = mergeDuplicateContent(f.target, f.conceptContent, candidate);
  assert.ok(result.includes('网页人工笔记：需完整保留。')); assert.ok(result.includes('真实网页完整正文及人工验证事实。'.repeat(40)));
  assert.ok(result.includes('概念人工补充：机构身份已经确认。')); assert.ok(result.includes('custom_review'));
  assert.ok(result.includes('人工已核实')); assert.ok(result.includes('来源中同一句话提及该机构。'));
  assert.equal((result.match(/^---$/gm) ?? []).length >= 2, true);
  const frontmatter = result.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  assert.equal((frontmatter.match(/^knowledge_seed_id:/gm) ?? []).length, 1);
  assert.ok(frontmatter.includes(f.w.id));
  const mergedIds = frontmatter.match(/^knowledge_seed_merged_ids:\s*(.*)$/m)?.[1];
  assert.ok(mergedIds); assert.ok(JSON.parse(mergedIds).includes(f.c.id));
  assert.ok(result.includes(`<!-- knowledge-seed:links:${f.w.id} -->`));
  assert.ok(!result.includes(`<!-- knowledge-seed:links:${f.c.id} -->`));
  assert.equal(mergeManagedLinks(result, f.w.id, []), result, 'merged note must remain safely refreshable');
});

test('merging refuses changed content after preview and does not silently overwrite intervening manual edits', () => {
  const f = legacyFixture(), candidate = planLegacyMerges(f.g, f.paths, f.notes)[0];
  assert.throws(() => mergeDuplicateContent(`${f.target}\n新增手写事实。`, f.conceptContent, candidate));
  assert.throws(() => mergeDuplicateContent(f.target, `${f.conceptContent}\n新增概念事实。`, candidate));
});

test('legacy merges inherit the source previous aliases and safely rewrite native YAML block lists',()=>{
  const f=legacyFixture();
  const target=f.target.replace('title:', 'knowledge_seed_merged_ids:\n  - old-target\n# Keep this manual property comment\ntitle:');
  const source=f.conceptContent.replace('title:', 'knowledge_seed_merged_ids:\n  - old-source\n  - older-source\ntitle:');
  const candidate={...planLegacyMerges(f.g,f.paths,f.notes)[0],fromHash:stableId(source),toHash:stableId(target)};
  const result=mergeDuplicateContent(target,source,candidate);
  const header=result.match(/^---\n([\s\S]*?)\n---/)![1];
  const aliases=JSON.parse(header.match(/^knowledge_seed_merged_ids: (.*)$/m)![1]);
  assert.deepEqual(new Set(aliases),new Set(['old-target',f.c.id,'old-source','older-source']));
  assert.ok(result.includes('# Keep this manual property comment'));
  assert.ok(result.includes('概念人工补充：机构身份已经确认。'));
  const refreshed=mergeGeneratedAliases(result,f.w.id,['new-source']);
  assert.ok(refreshed.includes('"older-source"'));
  assert.equal((refreshed.match(/^knowledge_seed_merged_ids:/gm)??[]).length,2,'source metadata is retained inertly inside its code fence');
});

test('explicit same-URL source pairing permits reviewed merging without label guesses or retained history',()=>{
  const f=legacyFixture();f.notes[0].source=url;f.notes[0].title='NTTPC';
  const candidates=planSourceMerges(f.notes);
  assert.equal(candidates.length,1);assert.equal(candidates[0].from,f.notes[0].path);assert.equal(candidates[0].to,f.notes[1].path);
  f.notes[0].source='https://example.org/a-different-entity';assert.deepEqual(planSourceMerges(f.notes),[]);
  f.notes[0].source=undefined;assert.deepEqual(planSourceMerges(f.notes),[]);
});

test('source-based candidates require one actual owned reading and reject ambiguous duplicate sources',()=>{
  const f=legacyFixture();f.notes[0].source=url;
  const same={...f.notes[1],path:'Knowledge Seed/网页/另一个正文.md',ownerId:'web-second',content:owned('web-second','<!-- knowledge-seed:article:web-second:body -->\nreading')};
  assert.deepEqual(planSourceMerges([...f.notes,same]),[]);
  const blank={...f.notes[1],content:owned(f.w.id,'# 空白网页')};
  assert.deepEqual(planSourceMerges([f.notes[0],blank]),[]);
});

test('legacy historical quote pairing cannot override a conflicting live or graph concept source URL',()=>{
  for(const change of[(f:ReturnType<typeof legacyFixture>)=>{f.notes[0].source='https://example.org/different';},
    (f:ReturnType<typeof legacyFixture>)=>{f.c.entityUrl='https://example.org/different';}]){
    const f=legacyFixture();change(f);assert.deepEqual(planLegacyMerges(f.g,f.paths,f.notes),[]);
  }
});
