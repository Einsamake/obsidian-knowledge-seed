import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { Cancelled, clampOptions, type EngineAdapter, type NoteRef, type Options } from '../src/engine';
import { exploreConcepts } from '../src/exploration';
import { nodeId, type KnowledgeGraph } from '../src/graph';

Object.assign(globalThis, { DOMParser });
const page = (title: string, labels: Array<[string, string]> = [], content = '') => `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>
<p>${content || `${title} is described with explicit references. Sources distinguish supported hyperlinks from unverified semantic relations. Readers can inspect original material and its provenance before interpreting the connections.`}</p>
${labels.map(([label, url]) => `<p>The referenced concept <a href="${url}">${label}</a> has its own source for further inspection and independent reading.</p>`).join('')}</article></body></html>`;
const opts = (value: Partial<Options> = {}) => clampOptions({ web: true, maxPages: 12, maxNotes: 0, maxConcepts: 50, depth: 3, searchLimit: 0, relevance: 'balanced', ...value });
function fixture(input: { pages?: Record<string, string>; notes?: Record<string, string>; refs?: NoteRef[]; search?: Array<{ title: string; snippet?: string; redirecttitle?: string }>; request?: (url: string) => Promise<{ status: number; text: string }>; onList?: () => void } = {}) {
  const requests: string[] = [], reads: string[] = [];
  const notes = input.notes ?? {}, refs = input.refs ?? Object.keys(notes).map(path => ({ path, title: path.split('/').pop()!.replace(/\.md$/, '') }));
  const adapter: EngineAdapter = {
    listNotes: () => { input.onList?.(); return refs; },
    readNote: async path => { reads.push(path); if (!(path in notes)) throw new Error('Unreadable note'); return notes[path]; },
    resolveLink: link => refs.find(ref => ref.path === `${link}.md` || ref.path === link || ref.path.split('/').pop() === `${link}.md`)?.path ?? null,
    request: async url => {
      requests.push(url);
      if (input.request) return input.request(url);
      if (url.includes('/w/api.php?')) return { status: 200, text: JSON.stringify({ query: { search: input.search ?? [] } }) };
      return { status: input.pages?.[url] ? 200 : 404, text: input.pages?.[url] ?? '', headers: { 'content-type': 'text/html' } };
    }
  };
  return { adapter, requests, reads };
}
function assertGraph(graph: KnowledgeGraph) {
  const ids = new Set(graph.nodes.map(node => node.id));
  assert.equal(ids.size, graph.nodes.length);
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); assert.notEqual(edge.from, edge.to);
    for (const evidence of edge.evidence) { assert.ok(ids.has(evidence.sourceId)); assert.ok(evidence.quote.trim()); assert.ok(evidence.method.trim()); }
  }
}

test('seed-only snapshot precedes every network request and even local note enumeration', async () => {
  const events: string[] = [];
  const f = fixture({ onList: () => events.push('list'), request: async () => { events.push('request'); return { status: 200, text: page('Knowledge') }; } });
  await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxPages: 1 }), undefined,
    { onSnapshot: graph => { if (!events.length) { assert.equal(graph.nodes.length, 1); assert.equal(graph.nodes[0].kind, 'seed'); assert.equal(graph.stats.requests, 0); } events.push('snapshot'); } });
  assert.deepEqual(events.slice(0, 2), ['snapshot', 'list']); assert.ok(events.indexOf('request') > 0);
});
test('note seeds publish a readable filename before enumeration while preserving the full-path identity', async () => {
  const path='研究笔记/脑科学.md', snapshots:KnowledgeGraph[]=[];
  const f=fixture({notes:{[path]:'# 脑科学\n\n真实已有笔记正文。'},onList:()=>{
    assert.equal(snapshots.length,1,'the navigation note must be ready before the vault scan');
    assert.equal(snapshots[0].nodes[0].title,'脑科学');
  }});
  const graph=await exploreConcepts({kind:'note',value:path},f.adapter,opts({web:false,maxNotes:1}),undefined,
    {onSnapshot:next=>{snapshots.push(next);}});
  assert.equal(snapshots[0].nodes[0].id,nodeId('seed',`note:${path}`));
  assert.equal(snapshots[0].seed,path);
  assert.equal(graph.nodes.find(node=>node.kind==='seed')!.title,'脑科学');
  assert.equal(graph.nodes.find(node=>node.kind==='note')!.locator,path);
  assert.deepEqual(f.requests,[]);
});
test('source mentions publish pending concepts before a descendant page starts reading', async () => {
  const snapshots: KnowledgeGraph[] = [], events: string[] = [];
  const f = fixture({ request: async url => {
    if (url.endsWith('/child')) {
      events.push('child-request');
      assert.ok(snapshots.some(graph => graph.nodes.some(node => node.title === 'Child concept' && node.reading?.state === 'pending')));
      return { status: 200, text: page('Child concept') };
    }
    return { status: 200, text: page('Knowledge', [['Child concept', 'https://example.org/child']]) };
  } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts(), undefined,
    { onSnapshot: graph => { snapshots.push(graph); events.push('snapshot'); } });
  assert.ok(events.includes('child-request')); assertGraph(graph);
  const pending = snapshots.find(graph => graph.nodes.some(node => node.title === 'Child concept' && node.kind === 'concept'))!.nodes.find(node => node.title === 'Child concept')!;
  const final = graph.nodes.find(node => node.title === 'Child concept')!;
  assert.equal(final.id, pending.id); assert.equal(final.kind, 'web'); assert.equal(final.reading?.state, 'ready'); assert.ok(final.article?.textChars);
  assert.equal(pending.kind, 'concept'); assert.equal(pending.reading?.state, 'pending'); // Snapshots are immutable copies.
});
test('search result names appear before page hydration and remain useful at the concept cap', async () => {
  const f = fixture({ search: [{ title: 'Graph theory', snippet: 'Graph theory describes graph structures.' }, { title: 'Graph model', snippet: 'A graph model.' }] });
  const snapshots: KnowledgeGraph[] = [];
  const graph = await exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts({ searchLimit: 5, maxConcepts: 2 }), undefined,
    { onSnapshot: graph => { snapshots.push(graph); } });
  assert.equal(graph.nodes.length, 3); assert.equal(graph.stats.pagesAttempted, 0);
  assert.ok(graph.nodes.filter(node => node.kind !== 'seed').every(node => node.entityUrl && node.reading?.state === 'pending'));
  assert.ok(f.requests.every(url => url.includes('/w/api.php?'))); assertGraph(graph);
  assert.ok(snapshots.some(graph => graph.nodes.length === 3));
});
test('abort before execution emits no snapshot and performs no IO', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(); let count = 0;
  await assert.rejects(exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts(), controller.signal, { onSnapshot: () => { count++; } }), Cancelled);
  assert.equal(count, 0); assert.deepEqual(f.requests, []); assert.deepEqual(f.reads, []);
});
test('abort races an unresolved request and its late response never publishes a snapshot', async () => {
  let resolve!: (value: { status: number; text: string }) => void, started!: () => void;
  const requestStarted = new Promise<void>(done => { started = done; });
  const f = fixture({ request: async () => { started(); return new Promise(done => { resolve = done; }); } });
  const controller = new AbortController(); let count = 0;
  const running = exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts(), controller.signal, { onSnapshot: () => { count++; } });
  await requestStarted; controller.abort(); await assert.rejects(running, Cancelled); const atAbort = count;
  resolve({ status: 200, text: page('Knowledge', [['Late concept', 'https://example.org/late']]) });
  await new Promise(done => setTimeout(done, 10)); assert.equal(count, atAbort); assert.equal(f.requests.length, 1);
});
test('pause gate prevents IO and abort can release a permanently paused exploration', async () => {
  const f = fixture(), controller = new AbortController(); let gateEntered!: () => void;
  const entered = new Promise<void>(done => { gateEntered = done; });
  const running = exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts({ searchLimit: 5 }), controller.signal,
    { shouldContinue: () => { gateEntered(); return new Promise<void>(() => {}); } });
  await entered; assert.deepEqual(f.requests, []); controller.abort(); await assert.rejects(running, Cancelled);
});
test('actual local links traverse while code, hidden comments, escaped links and metadata do not', async () => {
  const f = fixture({ notes: { 'Graph.md': '---\naliases: [[Metadata]]\n---\n\nGraph [[Known]] [[Unknown]]\n<!-- [[Hidden]] -->\n`[[Inline]]`\n\\[[Escaped]]\n```\n[[Code]]\n```', 'Known.md': 'Known concept with [[Child]]', 'Child.md': 'Child concept' } });
  const graph = await exploreConcepts({ kind: 'note', value: 'Graph.md' }, f.adapter, opts({ web: false, maxNotes: 5, depth: 3 }));
  assert.ok(graph.nodes.some(node => node.title === 'Unknown' && !node.bodyAvailable));
  assert.ok(graph.nodes.some(node => node.title === 'Known' && node.locator === 'Known.md'));
  assert.ok(graph.nodes.some(node => node.title === 'Child' && node.locator === 'Child.md'));
  assert.ok(graph.edges.some(edge => edge.relation === 'wiki_link'));
  for (const name of ['Metadata', 'Hidden', 'Inline', 'Escaped', 'Code']) assert.ok(!graph.nodes.some(node => node.title === name), name);
  assertGraph(graph); assert.deepEqual(f.requests, []);
});

test('unindexed Obsidian comments never become concepts and literal delimiters in code stay inert', async () => {
  const f = fixture({ notes: { 'Graph.md': 'Graph [[Visible]]\n%% [[PrivateOne]] %%\n%%\n[[PrivateTwo]]\n%%\n`%%`\n```\n%%\n```\n\\%% [[EscapedDelimiter]] \\%%\n[[AfterCode]]\n%% [[UnclosedPrivate]]' } });
  const graph = await exploreConcepts({ kind: 'note', value: 'Graph.md' }, f.adapter, opts({ web: false, maxNotes: 5 }));
  for (const name of ['Visible', 'EscapedDelimiter', 'AfterCode']) assert.ok(graph.nodes.some(node => node.title === name), name);
  for (const name of ['PrivateOne', 'PrivateTwo', 'UnclosedPrivate']) assert.ok(!graph.nodes.some(node => node.title === name), name);
  assertGraph(graph);
});

test('a stale native link index cannot turn currently hidden code or comments into evidence', async () => {
  const f = fixture({ notes: { 'Graph.md': 'Graph [[Visible]]\n```\n[[CodeOnly]]\n```\n%% [[Private]] %%\n<!-- [[HtmlHidden]] -->\n\\[[Escaped]]' } });
  f.adapter.noteLinks = () => ['Visible', 'CodeOnly', 'Private', 'HtmlHidden', 'Escaped'].map(target => ({ target, quote: `[[${target}]]` }));
  const graph = await exploreConcepts({ kind: 'note', value: 'Graph.md' }, f.adapter, opts({ web: false, maxNotes: 5 }));
  assert.ok(graph.nodes.some(node => node.title === 'Visible'));
  for (const name of ['CodeOnly', 'Private', 'HtmlHidden', 'Escaped']) assert.ok(!graph.nodes.some(node => node.title === name), name);
  assertGraph(graph);
});

test('private comment text cannot select a local note by topic matching', async () => {
  const f = fixture({ notes: { 'Unrelated.md': 'Ordinary visible prose.\n%% SecretResearch [[PrivateTerm]] %%' } });
  const graph = await exploreConcepts({ kind: 'topic', value: 'SecretResearch' }, f.adapter, opts({ web: false, maxNotes: 5 }));
  assert.equal(graph.nodes.length, 1);
});
test('aliases identify unresolved local concepts by target and do not create an extra real-file clone', async () => {
  const f = fixture({ notes: { 'Graph.md': 'Graph [[Folder/Unknown|Readable alias]] [[Known|Different label]]', 'Known.md': 'Actual existing file body' } });
  const graph = await exploreConcepts({ kind: 'note', value: 'Graph.md' }, f.adapter, opts({ web: false, maxNotes: 5 }));
  const unknown = graph.nodes.find(node => node.title === 'Readable alias')!;
  assert.equal(unknown.id, nodeId('concept', 'term:Folder/Unknown'));
  assert.equal(graph.nodes.filter(node => node.locator === 'Known.md').length, 1);
  assert.ok(!graph.nodes.some(node => node.title === 'Different label')); assertGraph(graph);
});
test('generated and user excluded folders are not read during automatic keyword discovery', async () => {
  const f = fixture({ notes: { 'Graph.md': 'Graph material', 'Templates/Graph.md': 'Graph template', 'Knowledge Seed/Graph.md': 'Graph generated' } });
  await exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts({ web: false, maxNotes: 5, generatedFolder: 'Knowledge Seed' }));
  assert.deepEqual(f.reads, ['Graph.md']);
});
test('explicit note links can reach generated notes but never user-excluded notes', async () => {
  const f = fixture({ notes: { 'Graph.md': '[[Knowledge Seed/Existing]] [[Templates/Hidden]]', 'Knowledge Seed/Existing.md': 'Existing source', 'Templates/Hidden.md': 'Hidden source' } });
  const graph = await exploreConcepts({ kind: 'note', value: 'Graph.md' }, f.adapter, opts({ web: false, maxNotes: 5, generatedFolder: 'Knowledge Seed' }));
  assert.ok(graph.nodes.some(node => node.locator === 'Knowledge Seed/Existing.md')); assert.ok(!f.reads.includes('Templates/Hidden.md'));
});
test('failed source reads retain important concept and its evidence instead of dropping the node', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Knowledge', [['Important concept', 'https://example.org/missing']]) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts());
  const failed = graph.nodes.find(node => node.title === 'Important concept')!;
  assert.equal(failed.reading?.state, 'failed'); assert.equal(failed.kind, 'concept');
  assert.ok(graph.edges.some(edge => edge.to === failed.id)); assertGraph(graph);
});
test('per-session exclusion rechecked after a request prevents late excluded-node descendants', async () => {
  const excluded = new Set<string>();
  const f = fixture({ request: async url => {
    if (url.endsWith('/child')) { excluded.add(nodeId('concept', 'url:https://example.org/child')); return { status: 200, text: page('Child', [['Grandchild', 'https://example.org/grandchild']]) }; }
    return { status: 200, text: page('Knowledge', [['Child', 'https://example.org/child']]) };
  } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts(), undefined, { shouldExclude: node => excluded.has(node.id) });
  assert.ok(!graph.nodes.some(node => node.title === 'Grandchild')); assert.ok(!f.requests.some(url => url.endsWith('/grandchild')));
});
test('direction-matching branch reaches deeper while unrelated branches stop earlier', async () => {
  const f = fixture({ pages: {
    'https://example.org/start': page('Graph', [['Statistics branch', 'https://example.org/stats'], ['History branch', 'https://example.org/history']]),
    'https://example.org/stats': page('Statistics branch', [['Statistics child', 'https://example.org/stats-child']]),
    'https://example.org/stats-child': page('Statistics child', [['Statistics leaf', 'https://example.org/stats-leaf']]),
    'https://example.org/history': page('History branch', [['History child', 'https://example.org/history-child']])
  } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ searchTerms: ['Statistics'], depth: 3 }));
  assert.ok(graph.nodes.some(node => node.title === 'Statistics leaf'));
  assert.ok(graph.nodes.some(node => node.title === 'History branch'));
  assert.ok(!graph.nodes.some(node => node.title === 'History child'));
  assert.ok(!f.requests.includes('https://example.org/history'));
  assert.ok(graph.nodes.every(node => node.depth <= 4)); assertGraph(graph);
});

test('horizontal coverage and chain depth consume the same page cap in different proven source orders', async () => {
  const pages={
    'https://example.org/start':page('Graph',[['Alpha branch','https://example.org/alpha'],['Beta branch','https://example.org/beta'],['Gamma branch','https://example.org/gamma']]),
    'https://example.org/alpha':page('Alpha branch',[['Alpha child','https://example.org/alpha-child']]),
    'https://example.org/alpha-child':page('Alpha child',[['Alpha leaf','https://example.org/alpha-leaf']]),
    'https://example.org/alpha-leaf':page('Alpha leaf'),
    'https://example.org/beta':page('Beta branch'), 'https://example.org/gamma':page('Gamma branch'),
  };
  const horizontal=fixture({pages}),chain=fixture({pages});
  const horizontalGraph=await exploreConcepts({kind:'url',value:'https://example.org/start'},horizontal.adapter,opts({explorationStrategy:'breadth',maxPages:4,depth:4}));
  const chainGraph=await exploreConcepts({kind:'url',value:'https://example.org/start'},chain.adapter,opts({explorationStrategy:'depth',maxPages:4,depth:4}));
  assert.deepEqual(horizontal.requests,['https://example.org/start','https://example.org/alpha','https://example.org/beta','https://example.org/gamma']);
  assert.deepEqual(chain.requests,['https://example.org/start','https://example.org/alpha','https://example.org/alpha-child','https://example.org/alpha-leaf']);
  assert.equal(horizontalGraph.stats.pagesAttempted,4);assert.equal(chainGraph.stats.pagesAttempted,4);assertGraph(horizontalGraph);assertGraph(chainGraph);
});

test('topic focus spends a small page cap on central concepts and keeps incidental names without expanding them', async () => {
  const f=fixture({pages:{
    'https://example.org/start':page('Graph',[['University location','https://example.org/location'],['Graph statistics','https://example.org/stats']]),
    'https://example.org/location':page('University location',[['Travel','https://example.org/travel']]),
    'https://example.org/stats':page('Graph statistics',[['Graph probability','https://example.org/probability']]),
    'https://example.org/probability':page('Graph probability'),
  }});
  const graph=await exploreConcepts({kind:'url',value:'https://example.org/start'},f.adapter,opts({explorationStrategy:'focused',maxPages:3,depth:4}));
  assert.deepEqual(f.requests,['https://example.org/start','https://example.org/stats','https://example.org/probability']);
  assert.ok(graph.nodes.some(node=>node.title==='University location'&&node.reading?.state==='pending'));
  assert.ok(!graph.nodes.some(node=>node.title==='Travel'));assertGraph(graph);
});

test('custom direction weights determine which branch receives a scarce source read', async () => {
  const f=fixture({pages:{
    'https://example.org/start':page('Graph',[['Alpha branch','https://example.org/alpha'],['Beta branch','https://example.org/beta']]),
    'https://example.org/alpha':page('Alpha branch'), 'https://example.org/beta':page('Beta branch',[['Beta child','https://example.org/beta-child']]),
  }});
  const graph=await exploreConcepts({kind:'url',value:'https://example.org/start'},f.adapter,opts({explorationStrategy:'custom',maxPages:2,depth:4,
    offDirectionDepth:1,directionDepthBoost:2,directionRules:[{term:'Alpha',weight:1},{term:'Beta',weight:9}]}));
  assert.deepEqual(f.requests,['https://example.org/start','https://example.org/beta']);
  assert.ok(graph.nodes.some(node=>node.title==='Beta child'));assert.ok(graph.nodes.some(node=>node.title==='Alpha branch'));assertGraph(graph);
});

test('zero off-direction depth still exposes the first ring and explicit zero-depth direction remains unexpanded', async () => {
  const f=fixture({pages:{
    'https://example.org/start':page('Graph',[['Stop concept','https://example.org/stop'],['Unrelated concept','https://example.org/other']]),
    'https://example.org/stop':page('Stop concept',[['More concepts','https://example.org/more']]),
  }});
  const graph=await exploreConcepts({kind:'url',value:'https://example.org/start'},f.adapter,opts({explorationStrategy:'custom',offDirectionDepth:0,
    directionDepthBoost:3,directionRules:[{term:'Stop',weight:8,depth:0}]}));
  assert.deepEqual(f.requests,['https://example.org/start']);
  assert.ok(graph.nodes.some(node=>node.title==='Stop concept'));assert.ok(graph.nodes.some(node=>node.title==='Unrelated concept'));assertGraph(graph);
});

test('direction rule terms enter bounded public queries and local-only strategies still make no requests', async () => {
  const publicFixture=fixture(),localFixture=fixture({notes:{'Graph.md':'Graph [[Related]]'}});
  const rules=[{term:'High priority',weight:9},{term:'Low priority',weight:1}];
  await exploreConcepts({kind:'topic',value:'Graph'},publicFixture.adapter,opts({searchLimit:1,maxPages:2,directionRules:rules}));
  const queries=publicFixture.requests.filter(url=>url.includes('/w/api.php?')).map(url=>new URL(url).searchParams.get('srsearch'));
  assert.deepEqual(queries,['Graph','"Graph"','High priority','Low priority']);
  for(const strategy of ['radial','focused','breadth','depth','custom'] as const) {
    await exploreConcepts({kind:'note',value:'Graph.md'},localFixture.adapter,opts({web:false,maxNotes:4,directionRules:rules,explorationStrategy:strategy}));
  }
  assert.deepEqual(localFixture.requests,[]);
});
test('one-page budget discovers linked concepts without fetching their detailed pages', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Knowledge', [['One concept', 'https://example.org/one'], ['Two concept', 'https://example.org/two']]) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxPages: 1 }));
  assert.equal(graph.stats.pagesAttempted, 1); assert.equal(f.requests.length, 1);
  assert.equal(graph.nodes.filter(node => node.kind === 'concept').length, 2);
});
test('concept cap is a hard cap and does not hold discovery open for queued bodies', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Knowledge', Array.from({ length: 10 }, (_, i) => [`Concept ${i}`, `https://example.org/${i}`])) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxConcepts: 3 }));
  assert.equal(graph.nodes.length, 4); assert.equal(f.requests.length, 1); assert.match(graph.warnings.join(' '), /上限/);
});
test('invalid private seed is rejected before any snapshot or network request', async () => {
  const f = fixture(); let count = 0;
  await assert.rejects(exploreConcepts({ kind: 'url', value: 'http://127.0.0.1/private' }, f.adapter, opts(), undefined, { onSnapshot: () => { count++; } }), /本地|私有/);
  assert.equal(count, 0); assert.equal(f.requests.length, 0);
});
test('long public seed URL is fetched without being rejected as a concept label', async () => {
  const url = `https://example.org/${'long-path-'.repeat(12)}`;
  const f = fixture({ pages: { [url]: page('Readable title - Wikipedia') } });
  const graph = await exploreConcepts({ kind: 'url', value: url }, f.adapter, opts({ maxPages: 1 }));
  assert.equal(f.requests.length, 1); assert.equal(graph.nodes.find(node => node.kind === 'seed')!.title, 'Readable title');
});
test('URL seed keeps its own article title while first-ring search results and linked pages hydrate', async () => {
  const url='https://en.wikipedia.org/wiki/Forgetting_curve', translated='https://zh.wikipedia.org/wiki/%E9%81%97%E5%BF%98%E6%9B%B2%E7%BA%BF';
  const catalog='https://zh.wikipedia.org/wiki/%E6%95%99%E8%82%B2%E7%9B%B8%E5%85%B3%E6%9D%A1%E7%9B%AE%E7%9B%AE%E5%BD%95', linked='https://example.org/retention';
  const f=fixture({pages:{
    [url]:page('Forgetting curve',[['Memory retention',linked]]),
    [translated]:page('遗忘曲线'),[catalog]:page('教育相关条目目录'),[linked]:page('Memory retention'),
  },search:[{title:'遗忘曲线',snippet:'Forgetting curve describes memory retention.'},
    {title:'教育相关条目目录',snippet:'Forgetting curve is an entry in this education catalog.'}]});
  const snapshots:KnowledgeGraph[]=[];
  const graph=await exploreConcepts({kind:'url',value:url},f.adapter,opts({maxPages:4,searchLimit:2,explorationStrategy:'breadth'}),undefined,
    {onSnapshot:next=>{snapshots.push(next);}});
  assert.deepEqual(f.requests.filter(request=>!request.includes('/w/api.php?')),[url,translated,catalog,linked],
    'the regression must hydrate both depth-one search candidates after the actual URL source');
  const root=graph.nodes.find(node=>node.kind==='seed')!;
  assert.equal(root.id,nodeId('seed',`url:${url}`));assert.equal(root.title,'Forgetting curve');assert.equal(graph.seed,url);
  assert.ok(graph.nodes.some(node=>node.title==='教育相关条目目录'&&node.kind==='web'&&node.depth===1));
  assert.ok(graph.nodes.some(node=>node.title==='Memory retention'&&node.kind==='web'));
  for(const snapshot of snapshots.filter(next=>next.nodes.some(node=>node.status==='retrieved')))
    assert.equal(snapshot.nodes.find(node=>node.kind==='seed')!.title,'Forgetting curve','every published root retains the requested source title');
  assertGraph(graph);
});

test('normalized URL seed adopts its returned article title without letting an alternate search page replace it', async () => {
  const input='HTTPS://EXAMPLE.ORG:443/entry#History', normalized='https://example.org/entry', linked='https://example.org/related';
  const alternate='https://zh.wikipedia.org/wiki/Canonical_memory_article';
  const f=fixture({pages:{
    [normalized]:page('Canonical memory article - Wikipedia',[['Canonical memory article',normalized+'#Section'],['Related memory article',linked]]),
    [alternate]:page('Returned alternate candidate'),[linked]:page('Related memory article'),
  },search:[{title:'Canonical memory article',redirecttitle:'entry',snippet:'Canonical memory article describes memory.'}]});
  const snapshots:KnowledgeGraph[]=[];
  const graph=await exploreConcepts({kind:'url',value:input},f.adapter,opts({maxPages:3,searchLimit:1,explorationStrategy:'breadth'}),undefined,
    {onSnapshot:next=>{snapshots.push(next);}});
  assert.deepEqual(f.requests.filter(request=>!request.includes('/w/api.php?')),[normalized,alternate,linked]);
  const root=graph.nodes.find(node=>node.kind==='seed')!, source=graph.nodes.find(node=>node.entityUrl===normalized)!;
  assert.equal(root.id,nodeId('seed',`url:${input}`));assert.equal(root.title,'Canonical memory article');
  assert.equal(source.id,nodeId('concept',`url:${normalized}`));assert.equal(source.title,'Canonical memory article');
  assert.ok(graph.edges.some(edge=>edge.from===root.id&&edge.to===source.id&&edge.relation==='seed_source'));
  assert.equal(f.requests.filter(request=>request===normalized).length,1,'fragment aliases must retain one source identity');
  for(const snapshot of snapshots.filter(next=>next.nodes.some(node=>node.status==='retrieved')))
    assert.equal(snapshot.nodes.find(node=>node.kind==='seed')!.title,'Canonical memory article');
  assertGraph(graph);
});

test('an unreadable URL seed retains its initial title when a different search result supplies readable content', async () => {
  const url='https://example.org/Forgetting_curve', alternate='https://zh.wikipedia.org/wiki/Education_catalog';
  const f=fixture({pages:{[alternate]:page('Education catalog')},search:[{title:'Education catalog',snippet:'Forgetting curve appears in the catalog.'}]});
  const graph=await exploreConcepts({kind:'url',value:url},f.adapter,opts({maxPages:2,searchLimit:1,relevance:'broad'}));
  assert.deepEqual(f.requests.filter(request=>!request.includes('/w/api.php?')),[url,alternate]);
  assert.equal(graph.nodes.find(node=>node.kind==='seed')!.title,'Forgetting curve');
  assert.equal(graph.nodes.find(node=>node.entityUrl===url)!.reading?.state,'failed');
  assert.ok(graph.nodes.some(node=>node.entityUrl===alternate&&node.kind==='web'));assertGraph(graph);
});

test('same explicit URL shares stable node identity across multiple mention sources', async () => {
  const f = fixture({ pages: {
    'https://example.org/start': page('Graph', [['Branch one', 'https://example.org/one'], ['Branch two', 'https://example.org/two']]),
    'https://example.org/one': page('Branch one', [['Shared concept', 'https://example.org/shared']]),
    'https://example.org/two': page('Branch two', [['Shared concept', 'https://example.org/shared']]),
    'https://example.org/shared': page('Shared concept')
  } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts());
  assert.equal(graph.nodes.filter(node => node.entityUrl === 'https://example.org/shared').length, 1);
  assert.equal(f.requests.filter(url => url === 'https://example.org/shared').length, 1);
  const shared = graph.nodes.find(node => node.title === 'Shared concept')!;
  assert.equal(graph.edges.filter(edge => edge.to === shared.id).length, 2); assertGraph(graph);
});
test('same label with different explicit URLs is retained as separate knowledge identities', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Graph', [['Mercury', 'https://example.org/planet'], ['Mercury', 'https://example.org/element']]) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxPages: 1 }));
  assert.equal(graph.nodes.filter(node => node.title === 'Mercury').length, 2); assertGraph(graph);
});
test('explicit linked existing source reuses original file without a second web concept', async () => {
  const path = 'Knowledge Seed/概念/Known.md';
  const f = fixture({ notes: { [path]: 'Graph existing original body' }, refs: [{ path, title: 'Known', managedId: 'concept-known', sourceUrl: 'https://example.org/known', bodyAvailable: true }],
    pages: { 'https://example.org/start': page('Graph', [['Known', 'https://example.org/known']]) } });
  // Generated files are excluded from initial keyword selection. This exercises
  // direct web-mention reuse rather than finding the file before reading a page.
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxNotes: 5, maxPages: 1, generatedFolder: 'Knowledge Seed' }));
  const known = graph.nodes.filter(node => node.entityUrl === 'https://example.org/known');
  assert.equal(known.length, 1); assert.equal(known[0].locator, path); assert.equal(known[0].managedId, 'concept-known');
  assertGraph(graph);
});
test('a same-label file without a confirmed source is not reused by a web mention', async t => {
  const path = 'Knowledge Seed/起点/Queen.md', url = 'https://example.org/queen';
  for (const state of [
    { name: 'newly saved seed with an unindexed owner', managedId: undefined, sourceUrl: undefined },
    { name: 'owned seed without a webpage identity', managedId: 'seed-queen', sourceUrl: undefined },
    { name: 'empty source metadata', managedId: 'concept-queen', sourceUrl: '' },
    { name: 'invalid source metadata', managedId: 'concept-queen', sourceUrl: 'http://127.0.0.1/private' },
  ]) await t.test(state.name, async () => {
    const f = fixture({ notes: { [path]: 'User or navigation content that must remain separate.' },
      refs: [{ path, title: 'Queen', managedId: state.managedId, sourceUrl: state.sourceUrl }],
      pages: { 'https://example.org/start': page('Music', [['Queen', url]]) } });
    const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter,
      opts({ maxNotes: 5, maxPages: 1, generatedFolder: 'Knowledge Seed' }));
    const queen = graph.nodes.find(node => node.entityUrl === url)!;
    assert.equal(queen.id, nodeId('concept', `url:${url}`));
    assert.equal(queen.kind, 'concept'); assert.equal(queen.locator, undefined); assert.equal(queen.managedId, undefined);
    assert.ok(!graph.nodes.some(node => node.locator === path));
    assert.deepEqual(f.reads, []); assertGraph(graph);
  });
});
test('a source-identity conflict never reuses a same-label existing note', async () => {
  const f = fixture({ notes: { 'Known.md': 'Existing unrelated body' }, refs: [{ path: 'Known.md', title: 'Known', managedId: 'concept-known', sourceUrl: 'https://example.org/other' }],
    pages: { 'https://example.org/start': page('Graph', [['Known', 'https://example.org/known']]) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxNotes: 5, maxPages: 1 }));
  const known = graph.nodes.find(node => node.entityUrl === 'https://example.org/known')!;
  assert.equal(known.locator, undefined); assert.equal(known.managedId, undefined); assert.equal(known.kind, 'concept');
  assert.ok(!graph.nodes.some(node => node.locator === 'Known.md')); assertGraph(graph);
});
test('excluded terms and site/navigation labels are absent from discovered nodes', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Graph', [['登录', 'https://example.org/login'], ['Unwanted concept', 'https://example.org/unwanted'], ['Useful concept - Wikipedia', 'https://example.org/useful']]) } });
  const graph = await exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts({ maxPages: 1, excludeTerms: ['Unwanted'] }));
  assert.ok(!graph.nodes.some(node => /登录|Unwanted|Wikipedia/.test(node.title)));
  assert.ok(graph.nodes.some(node => node.title === 'Useful concept'));
});
test('source snapshot write failure propagates once and is not retried as a network failure', async () => {
  const f = fixture({ pages: { 'https://example.org/start': page('Graph') } }); let writes = 0;
  await assert.rejects(exploreConcepts({ kind: 'url', value: 'https://example.org/start' }, f.adapter, opts(), undefined,
    { onSnapshot: graph => { writes++; if (graph.nodes.some(node => node.status === 'retrieved')) throw new Error('Snapshot disk conflict'); } }), /Snapshot disk conflict/);
  assert.equal(writes, 3); assert.equal(f.requests.length, 1);
});
test('search snapshot write failure propagates once instead of starting another query', async () => {
  const f = fixture({ search: [{ title: 'Graph theory', snippet: 'Graph concepts' }] }); let writes = 0;
  await assert.rejects(exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts({ searchLimit: 5 }), undefined,
    { onSnapshot: graph => { writes++; if (graph.nodes.length > 1) throw new Error('Snapshot disk conflict'); } }), /Snapshot disk conflict/);
  assert.equal(writes, 2); assert.equal(f.requests.length, 1);
});
test('zero-depth topic discovery does not hydrate all search results before returning', async () => {
  const f = fixture({ search: [{ title: 'Graph theory', snippet: 'Graph concepts' }] });
  const graph = await exploreConcepts({ kind: 'topic', value: 'Graph' }, f.adapter, opts({ searchLimit: 5, depth: 0 }));
  assert.equal(graph.stats.pagesAttempted, 0); assert.ok(f.requests.every(url => url.includes('/w/api.php?')));
  assert.equal(graph.nodes.find(node => node.title === 'Graph theory')!.reading?.state, 'pending');
});
