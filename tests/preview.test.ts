import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphEdge, GraphNode, KnowledgeGraph, NodeKind } from '../src/graph';
import { defaultPreviewSelection, readablePreviewSelection, filterPreviewNodes, nodeEvidence, previewSelectionSummary, selectVisibleNodes, hasPreviewBody, previewReadingState, previewReadingSummary, selectedCompletionTargets, inheritPreviewSelection, articleSearchMatches } from '../src/preview';

function node(id: string, kind: NodeKind, title: string, depth: number, excerpt = '', locator?: string): GraphNode {
  return { id, kind, title, depth, excerpt, locator, status: kind === 'concept' ? 'derived' : 'retrieved',
    ...(kind === 'web' ? {article:{blocks:[{type:'paragraph' as const,text:excerpt||`${title}的原文正文。`}],textChars:40,totalTextChars:40,truncated:false}} : {}) };
}
function edge(id: string, from: string, to: string, sourceId: string): GraphEdge {
  return { id, from, to, relation: 'mentions', evidence: [{ sourceId, quote: '原文支持神经元', method: '正文链接', locator: 'https://example.org/neuroscience' }] };
}
function fixture(): KnowledgeGraph {
  return {
    version: 1, seed: '脑科学', createdAt: '2026-10-05T00:00:00Z', warnings: [],
    stats: { pagesAttempted: 2, notesScanned: 1, requests: 2 },
    nodes: [node('seed', 'seed', '脑科学', 0),
      node('web-a', 'web', '神经科学 Ａ', 1, 'Neural networks 与神经元。', 'https://example.org/Neuro'),
      node('web-b', 'web', '神经科学 B', 2), node('note', 'note', '睡眠', 3),
      node('concept', 'concept', '神经元', 2)],
    edges: [edge('seed-a', 'seed', 'web-a', 'web-a'), edge('seed-b', 'seed', 'web-b', 'web-b'),
      edge('a-c', 'web-a', 'concept', 'web-a'), edge('b-c', 'web-b', 'concept', 'web-b')]
  };
}

test('preview defaults keep evidenced unread concepts alongside successful sources', () => {
  const graph = fixture();
  graph.nodes.find(node => node.kind === 'seed')!.status = 'derived';
  graph.nodes.push({ ...node('unread-web', 'web', '未获取页面', 2), status: 'discovered' });
  graph.nodes.push({ ...node('unread-note', 'note', '读取失败笔记', 2), status: 'discovered' });
  const original = JSON.stringify(graph);
  const selected = defaultPreviewSelection(graph);
  assert.deepEqual([...selected], ['seed', 'web-a', 'web-b', 'note', 'concept']);
  assert.equal(JSON.stringify(graph), original, 'default selection leaves discovery records and candidate evidence intact');
  const saved = previewSelectionSummary(graph, selected).graph;
  assert.ok(saved.nodes.some(node => node.kind === 'concept'));
  assert.equal(saved.edges.length, 4);
});

test('readiness uses actual body rather than retrieval metadata and excludes forbidden sources', () => {
  const graph=fixture(),web=graph.nodes[1];delete web.article;
  assert.equal(hasPreviewBody(web),false);assert.equal(previewReadingState(web),'pending');
  web.article={blocks:[{type:'heading',level:2,text:'只有标题'}],textChars:4,totalTextChars:4,truncated:false};
  assert.equal(hasPreviewBody(web),false,'headings alone are not article prose');
  web.article={blocks:[{type:'paragraph',text:'确实读取了原文。'}],textChars:8,totalTextChars:8,truncated:false};
  assert.equal(hasPreviewBody(web),true);
  web.reading={state:'excluded',reason:'用户排除'};web.bodyAvailable=true;
  assert.equal(hasPreviewBody(web),false);assert.equal(previewReadingState(web),'excluded');
  assert.ok(!readablePreviewSelection(graph).has(web.id));
  assert.ok(!selectVisibleNodes(graph,new Set(),{},true).has(web.id));
  assert.ok(!previewSelectionSummary(graph,new Set(graph.nodes.map(node=>node.id))).graph.nodes.some(node=>node.id===web.id));
});

test('content status filters and readable ordering are stable without changing candidates', () => {
  const graph=fixture();graph.nodes.find(node=>node.id==='concept')!.reading={state:'failed',reason:'连接超时'};
  graph.nodes.push({...node('pending','concept','轴突',1),reading:{state:'pending'}});
  const original=JSON.stringify(graph);
  assert.deepEqual(filterPreviewNodes(graph,{reading:'issues'}).map(node=>node.id),['concept']);
  assert.deepEqual(filterPreviewNodes(graph,{reading:'pending'}).map(node=>node.id),['pending']);
  assert.deepEqual(filterPreviewNodes(graph,{reading:'readable',kind:'web'}).map(node=>node.id),['web-a','web-b']);
  assert.deepEqual(filterPreviewNodes(graph,{sort:'reading'}).map(node=>node.id),['seed','web-a','web-b','note','pending','concept']);
  assert.deepEqual(previewReadingSummary(graph),{readable:3,pending:1,issues:1,excluded:0});
  assert.equal(JSON.stringify(graph),original);
});

test('targeted completion reads selected unresolved concepts independent of displayed filters', () => {
  const graph=fixture();graph.nodes.push({...node('ready','concept','已有正文',2,'','Existing.md'),bodyAvailable:true});
  graph.nodes.push({...node('excluded','concept','已排除',2),reading:{state:'excluded'}});
  assert.deepEqual(selectedCompletionTargets(graph,new Set(['concept','ready','excluded','web-a'])),['concept']);
  assert.deepEqual(selectedCompletionTargets(graph,new Set(['web-a'])),[]);
});

test('snapshot identity inheritance conservatively preserves deselection while new concepts stay retained', () => {
  const previous=fixture();previous.nodes[4].managedId='owned-concept';
  const next=fixture();next.nodes=next.nodes.filter(node=>node.id!=='concept');
  next.nodes.push({...node('upgraded','web','神经元',2),mergedIds:['owned-concept','concept']});
  next.nodes.push(node('new','concept','轴突',3));
  const selected=inheritPreviewSelection(previous,next,new Set(['seed','web-a','web-b','note']));
  assert.equal(selected.has('upgraded'),false);assert.equal(selected.has('new'),true);
  next.nodes.find(node=>node.id==='new')!.reading={state:'excluded'};
  assert.equal(inheritPreviewSelection(previous,next,new Set(previous.nodes.map(node=>node.id))).has('new'),false);
});

test('article search finds normalized full text across structured blocks without discarding prose', () => {
  const article={blocks:[{type:'heading' as const,level:2,text:'神经元结构'},{type:'paragraph' as const,text:'ＮＥＵＲＯＮ 和神经元。原文仍保留。'},
    {type:'list' as const,ordered:false,items:['轴突','神经元 dendrite']},{type:'table' as const,rows:[['概念','解释'],['神经元','Neuron']]}],textChars:60,totalTextChars:60,truncated:false};
  const original=JSON.stringify(article);
  assert.deepEqual(articleSearchMatches(article,'NEURON 神经元'),[1,3]);
  assert.deepEqual(articleSearchMatches(article,'  '),[]);assert.deepEqual(articleSearchMatches(article,'不存在'),[]);
  assert.equal(JSON.stringify(article),original);
});

test('important empty concepts stay selected while explicit readable filter remains available', () => {
  const graph = fixture();
  graph.nodes.push(node('existing-note', 'concept', '已有用户笔记', 2, '', '用户笔记/已有用户笔记.md'));
  graph.nodes.push({ ...node('owned-readable', 'concept', '已有生成正文', 2, '', 'Knowledge Seed/网页/已有生成正文.md'), bodyAvailable: true });
  graph.nodes.push({ ...node('owned-empty', 'concept', '旧空占位', 2, '', 'Knowledge Seed/概念/旧空占位.md'), bodyAvailable: false });
  graph.nodes.push({ ...node('false-proxy', 'concept', '只有网页目标', 2, '', 'https://example.org/source'), bodyAvailable: true });
  const selected = defaultPreviewSelection(graph);
  assert.ok(selected.has('existing-note')); assert.ok(selected.has('owned-readable'));
  assert.ok(selected.has('owned-empty')); assert.ok(selected.has('false-proxy'));
  const readable = readablePreviewSelection(graph);
  assert.ok(readable.has('existing-note')); assert.ok(readable.has('owned-readable'));
  assert.ok(!readable.has('owned-empty')); assert.ok(!readable.has('false-proxy'));
});

test('readable-only selection is optional and excluded concepts are never selected by default', () => {
  const graph = fixture();
  const defaults = defaultPreviewSelection(graph);
  const explicit = selectVisibleNodes(graph, defaults, { kind: 'concept' }, true);
  assert.ok(explicit.has('concept')); assert.ok(defaults.has('concept'));
  assert.ok(previewSelectionSummary(graph, explicit).graph.nodes.some(node => node.id === 'concept'));
  const reset = readablePreviewSelection(graph);
  assert.ok(!reset.has('concept')); assert.ok(reset.has('seed'));
  graph.nodes.find(node => node.id === 'concept')!.reading = {state:'excluded',reason:'用户排除'};
  assert.ok(!defaultPreviewSelection(graph).has('concept'));
});

test('preview search normalizes fullwidth, case and whitespace across title, excerpt and locator', () => {
  const graph = fixture();
  assert.deepEqual(filterPreviewNodes(graph, { query: '  神经科学\nａ NEURAL   EXAMPLE.ORG/NEURO ' }).map(n => n.id), ['web-a']);
  assert.equal(filterPreviewNodes(graph, { query: 'web-a' }).length, 0, 'internal identifiers are not searchable content');
  assert.deepEqual(filterPreviewNodes(graph, { query: '   ' }), graph.nodes);
});

test('kind and inclusive depth filters combine with search', () => {
  const graph = fixture();
  assert.deepEqual(filterPreviewNodes(graph, { kind: 'web', minDepth: 2, maxDepth: 2, query: '神经科学' }).map(n => n.id), ['web-b']);
  assert.deepEqual(filterPreviewNodes(graph, { kind: 'all', maxDepth: 1 }).map(n => n.id), ['seed', 'web-a']);
  assert.equal(filterPreviewNodes(graph, { minDepth: Number.NaN, maxDepth: Number.NaN }).length, 5);
});

test('batch selection changes only visible candidates, retains hidden choices and keeps seed', () => {
  const graph = fixture();
  const original = new Set(graph.nodes.map(n => n.id));
  const changed = selectVisibleNodes(graph, original, { kind: 'web', maxDepth: 1 }, false);
  assert.deepEqual([...changed], ['seed', 'web-b', 'note', 'concept']);
  assert.equal(original.size, 5, 'does not mutate the UI selection supplied by the caller');
  const restored = selectVisibleNodes(graph, changed, { query: 'neural' }, true);
  assert.equal(restored.size, 5);
  assert.deepEqual([...selectVisibleNodes(graph, new Set(), { kind: 'seed' }, false)], ['seed']);
});

test('save counts reflect actual source closure, including checked unsupported concepts', () => {
  const graph = fixture();
  const summary = previewSelectionSummary(graph, new Set(['concept', 'note', 'missing-id']));
  assert.equal(summary.selectedCount, 3, 'counts seed and valid selected IDs only');
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.edgeCount, 0);
  assert.equal(summary.droppedSelectedCount, 1);
  assert.deepEqual(summary.graph.nodes.map(n => n.id), ['seed', 'note']);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 4);
});

test('concept retains evidence from either surviving source and removes cancelled source evidence', () => {
  const graph = fixture();
  graph.edges.push({ id: 'shared', from: 'seed', to: 'concept', relation: 'mentions',
    evidence: [...graph.edges[2].evidence, ...graph.edges[3].evidence] });
  const summary = previewSelectionSummary(graph, new Set(['web-b', 'concept']));
  assert.equal(summary.nodeCount, 3);
  assert.equal(summary.edgeCount, 3);
  assert.equal(summary.droppedSelectedCount, 0);
  assert.deepEqual(summary.graph.edges.find(e => e.id === 'shared')?.evidence.map(e => e.sourceId), ['web-b']);
  assert.equal(graph.edges[4].evidence.length, 2, 'closure leaves original preview evidence intact');
});

test('unsupported concepts are removed transitively when another concept supplies their evidence', () => {
  const graph = fixture();
  graph.nodes.push(node('child', 'concept', '轴突', 3));
  graph.edges.push(edge('child-edge', 'seed', 'child', 'concept'));
  const summary = previewSelectionSummary(graph, new Set(['concept', 'child']));
  assert.equal(summary.nodeCount, 1);
  assert.equal(summary.edgeCount, 0);
  assert.equal(summary.droppedSelectedCount, 2);
});

test('per-node evidence includes source-backed connections and deduplicates only identical evidence within an edge', () => {
  const graph = fixture();
  graph.edges[2].evidence.push({ ...graph.edges[2].evidence[0] });
  graph.edges.push(edge('indirect', 'seed', 'concept', 'web-a'));
  const conceptEvidence = nodeEvidence(graph, 'concept');
  assert.equal(conceptEvidence.length, 3);
  assert.deepEqual(conceptEvidence.map(e => e.sourceTitle), ['神经科学 Ａ', '神经科学 B', '神经科学 Ａ']);
  assert.equal(conceptEvidence[0].fromTitle, '神经科学 Ａ');
  assert.equal(conceptEvidence[0].toTitle, '神经元');
  assert.equal(conceptEvidence[0].relation, 'mentions');
  assert.equal(nodeEvidence(graph, 'web-a').length, 3, 'source card includes indirectly backed relations');
  assert.deepEqual(nodeEvidence(graph, 'note'), []);
  assert.deepEqual(nodeEvidence(graph, 'missing-id'), []);
});
