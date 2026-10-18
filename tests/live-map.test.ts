import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/engine';
import { addEdge, type GraphNode, type KnowledgeGraph } from '../src/graph';
import { mergeLiveGraph, pruneLiveMap, readLiveMaps, serializeLiveMaps, visibleLiveGraph, foldOwnedRootFileViews, type LiveMapRecord } from '../src/live-map';

test('a verified root file reference folds endpoints and evidence without permanent path aliases',()=>{
  const path='Knowledge Seed/起点/皇后乐队.md';
  const source=graph([node('seed-root',0,'seed','皇后乐队'),{...node('note-root-view',1,'note','皇后乐队'),locator:path},node('concept-song',1),node('concept-band',2)]);
  addEdge(source,'concept-song','note-root-view','mentions',{sourceId:'concept-song',quote:'网页中提及皇后乐队',method:'超链接名称'});
  addEdge(source,'concept-band','concept-song','wiki_link',{sourceId:'note-root-view',quote:'保留的双链证据',method:'已有双链'});
  addEdge(source,'seed-root','note-root-view','keyword_match',{sourceId:'note-root-view',quote:'同一文件',method:'关键词'});
  const before=JSON.stringify(source),result=foldOwnedRootFileViews(source,path,'seed-root');
  assert.equal(JSON.stringify(source),before);
  assert.equal(result.nodes.some(node=>node.id==='note-root-view'),false);
  assert.equal(result.nodes[0].kind,'seed');assert.equal(result.nodes[0].mergedIds,undefined);
  assert.equal(result.edges.length,2);assert.ok(result.edges.some(edge=>edge.to==='seed-root'));
  assert.ok(result.edges.some(edge=>edge.evidence.some(item=>item.sourceId==='seed-root'&&item.quote==='保留的双链证据')));
  const retained=new Set(result.nodes.map(node=>node.id));
  assert.ok(result.edges.every(edge=>retained.has(edge.from)&&retained.has(edge.to)&&edge.evidence.every(item=>retained.has(item.sourceId))));
});

test('root folding cannot merge equal labels in another file or accept conflicting owners and sources',()=>{
  const path='Knowledge Seed/起点/中心.md';
  const ordinary={...node('note-other',1,'note','中心'),locator:'用户笔记/中心.md'};
  const valid=graph([node('seed-root',0,'seed','中心'),ordinary]);
  assert.equal(foldOwnedRootFileViews(valid,path,'seed-root'),valid);
  assert.throws(()=>foldOwnedRootFileViews(valid,path,'seed-impostor'),/所有权/);
  for(const invalid of [{managedId:'seed-impostor'},{entityUrl:'https://example.org/another'},{entityUrl:'http://127.0.0.1/private'}]) {
    const source=graph([node('seed-root',0,'seed','中心'),{...node('note-same-path',1,'note','中心'),locator:path,...invalid}]);
    assert.throws(()=>foldOwnedRootFileViews(source,path,'seed-root'),/所有权或来源/);
  }
});

const node = (id:string,depth:number,kind:GraphNode['kind']='concept',title=id):GraphNode =>
  ({id,depth,kind,title,excerpt:'真实来源中的名称。',status:'derived'});
function graph(nodes:GraphNode[]):KnowledgeGraph {
  return {version:1,seed:nodes[0].title,createdAt:'2026-10-10T00:00:00Z',nodes,edges:[],warnings:[],stats:{pagesAttempted:0,notesScanned:0,requests:0}};
}

test('successful continuation clears only the obsolete empty-source hint and preserves historical failures',()=>{
  const hint='尚未读取到可核验的来源正文；已有概念与候选来源仍保留。';
  const base=graph([node('seed-root',0,'seed')]);base.warnings=[hint,'来源读取失败：HTTP 503'];
  const next=graph([node('seed-root',0,'seed'),{...node('web-source',1,'web'),status:'retrieved',bodyAvailable:true,locator:'https://example.org/source'}]);
  const before=JSON.stringify(base),merged=mergeLiveGraph(base,next);
  assert.equal(merged.warnings.includes(hint),false);
  assert.ok(merged.warnings.includes('来源读取失败：HTTP 503'));
  assert.equal(JSON.stringify(base),before);
  const stillEmpty=mergeLiveGraph(base,graph([node('seed-root',0,'seed')]));
  assert.ok(stillEmpty.warnings.includes(hint));
});
function map():LiveMapRecord {
  const value=graph([node('seed-root',0,'seed','中心'),node('concept-left',1),node('concept-right',1),
    node('concept-only',2),node('concept-shared',2),node('concept-shared-child',3)]);
  const link=(from:string,to:string) => addEdge(value,from,to,'mentions',{sourceId:from,quote:'真实原文',method:'正文提及'});
  link('seed-root','concept-left');link('seed-root','concept-right');
  link('concept-left','concept-only');link('concept-left','concept-shared');link('concept-right','concept-shared');
  link('concept-shared','concept-shared-child');
  return {id:'map-root',title:'中心',rootPath:'Knowledge Seed/起点/中心.md',createdAt:value.createdAt,updatedAt:value.createdAt,
    state:'running',graph:value,nodePaths:Object.fromEntries(value.nodes.map(item=>[item.id,item.kind==='seed' ? 'Knowledge Seed/起点/中心.md' : `Knowledge Seed/概念/${item.title}.md`])),
    excludedIds:[],options:{...defaults},seed:{kind:'topic',value:'中心'},folder:'Knowledge Seed/Runs/live-root'};
}

test('later snapshots refine only the same main root display title without replacing its identity or content',()=>{
  const root={...node('seed-root',0,'seed','generic-slug'),managedId:'seed-owner',locator:'Knowledge Seed/起点/generic-slug.md',
    mergedIds:['seed-earlier'],excerpt:'起点中保留的说明。'};
  const original=graph([root,node('concept-kept',1)]),before=JSON.stringify(original);
  const snapshot=graph([node('seed-root',0,'seed','已读取页面的正式标题'),node('concept-new',1)]);
  addEdge(snapshot,'seed-root','concept-new','mentions',{sourceId:'concept-new',quote:'来源中的实际名称。',method:'真实来源'});
  const merged=mergeLiveGraph(original,snapshot),updated=merged.nodes.find(item=>item.kind==='seed')!;
  assert.equal(updated.title,'已读取页面的正式标题');
  assert.equal(updated.id,root.id);assert.equal(updated.managedId,root.managedId);
  assert.equal(updated.locator,root.locator);assert.equal(updated.excerpt,root.excerpt);
  assert.deepEqual(updated.mergedIds,root.mergedIds);
  assert.equal(JSON.stringify(original),before,'display refinement must not modify the prior snapshot');
  assert.ok(merged.nodes.some(item=>item.id==='concept-kept'));
  assert.ok(merged.nodes.some(item=>item.id==='concept-new'));
});

test('branch expansion and a different seed identity never replace the main root title',()=>{
  const original=graph([node('seed-root',0,'seed','主图谱'),node('concept-branch',1)]);
  const branch=graph([node('seed-other',0,'seed','沿分支探索的名称'),node('concept-new',1)]);
  for(const attachTo of [undefined,'concept-branch','seed-root']) {
    const merged=mergeLiveGraph(original,branch,attachTo);
    assert.equal(merged.nodes.find(item=>item.kind==='seed')!.title,'主图谱');
  }
  const sameIdentity=graph([node('seed-root',0,'seed','分支的新名称')]);
  assert.equal(mergeLiveGraph(original,sameIdentity,'seed-root').nodes.find(item=>item.kind==='seed')!.title,'主图谱');
});

test('live map persistence strips body payloads and bounded evidence while retaining identity and resumable topology',()=>{
  const original=map(), source=original.graph.nodes[1];
  source.article={blocks:[{type:'paragraph',text:'正文机密'.repeat(10000)}],textChars:40000,totalTextChars:40000,truncated:false};
  source.excerpt='长摘录'.repeat(1000);source.managedId='concept-retained';source.mergedIds=['concept-before'];
  original.graph.edges[0].evidence[0].quote='证据'.repeat(1000);
  const saved=serializeLiveMaps([original]);
  assert.equal(saved[0].state,'running');assert.equal(saved[0].graph.nodes[1].article,undefined);
  assert.equal(saved[0].graph.nodes[1].excerpt.length,400);assert.equal(saved[0].graph.edges[0].evidence[0].quote.length,600);
  assert.equal(saved[0].graph.nodes[1].bodyAvailable,true);assert.equal(saved[0].graph.nodes[1].managedId,'concept-retained');
  assert.deepEqual(saved[0].graph.nodes[1].mergedIds,['concept-before']);
  assert.ok(!JSON.stringify(saved).includes('正文机密'));assert.equal(source.article.blocks[0].type,'paragraph');
  assert.equal(source.excerpt.length,3000,'serialization never changes a live discovery snapshot');
  const restored=readLiveMaps(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored[0].state,'interrupted');assert.deepEqual({...restored[0].nodePaths},original.nodePaths);
  assert.equal(restored[0].graph.edges.length,original.graph.edges.length);
});

test('repeated live evidence is projected without losing the map or accepting oversized persisted evidence',()=>{
  const original=map(), repeated=structuredClone(original.graph);
  const edge=repeated.edges[0];
  edge.evidence=Array.from({length:101},(_,index)=>({sourceId:edge.from,quote:`第 ${index+1} 条真实正文证据`,method:'正文提及'}));
  original.graph=mergeLiveGraph(original.graph,repeated);
  const before=JSON.stringify(original);
  assert.ok(original.graph.edges[0].evidence.length>100);
  const saved=serializeLiveMaps([original]);
  assert.equal(saved.length,1,'growing evidence must not silently remove the graph library record');
  assert.equal(saved[0].graph.edges[0].evidence.length,8);
  assert.equal(JSON.stringify(original),before,'persisting a bounded view cannot mutate live evidence');
  const restored=readLiveMaps(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.length,1);assert.equal(restored[0].graph.edges.length,original.graph.edges.length);
  assert.deepEqual({...restored[0].nodePaths},original.nodePaths);
  assert.deepEqual(readLiveMaps([original]),[],'untrusted oversized persisted payloads stay rejected');
});

test('all valid exclusion folders remain persisted and restored without changing web permissions',()=>{
  const original=map();
  original.options={...original.options,web:false,excludeFolders:Array.from({length:101},(_,index)=>`Notes/Folder-${index}`)};
  const before=JSON.stringify(original),saved=serializeLiveMaps([original]);
  assert.equal(saved.length,1);assert.deepEqual(saved[0].options.excludeFolders,original.options.excludeFolders);
  const restored=readLiveMaps(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.length,1);assert.deepEqual(restored[0].options.excludeFolders,original.options.excludeFolders);
  assert.equal(restored[0].options.web,false);assert.equal(JSON.stringify(original),before);
  for(const invalid of [null,'','Notes/\u0000invalid']) {
    const raw={...original,options:{...original.options,excludeFolders:[...original.options.excludeFolders,invalid]}};
    assert.deepEqual(readLiveMaps([raw]),[]);
  }
});

test('strategy and bounded direction rules survive a save and reload without aliasing original settings',()=>{
  const original=map();
  original.options={...original.options,explorationStrategy:'custom',breadthDecay:0,directionDepthBoost:5,offDirectionDepth:2,
    directionRules:[{term:'Statistics',weight:9,depth:4},{term:'Applications',weight:2}]};
  const saved=serializeLiveMaps([original]),restored=readLiveMaps(JSON.parse(JSON.stringify(saved)))[0];
  assert.equal(restored.options.explorationStrategy,'custom');assert.equal(restored.options.breadthDecay,0);
  assert.equal(restored.options.directionDepthBoost,5);assert.equal(restored.options.offDirectionDepth,2);
  assert.deepEqual(restored.options.directionRules,original.options.directionRules);
  restored.options.directionRules![0].term='Edited';assert.equal(original.options.directionRules![0].term,'Statistics');
  const old=map();delete old.options.explorationStrategy;delete old.options.directionRules;
  assert.equal(readLiveMaps([old])[0].options.explorationStrategy,'radial');
  for(const rules of [null,{},Array(21).fill({term:'T',weight:1}),[{term:'T',weight:11}],[{term:'T',weight:1,depth:21}],
    [{term:'T',weight:1},{term:'ｔ',weight:2}],[{term:'Bad\u0000name',weight:1}]])
    assert.deepEqual(readLiveMaps([{...original,options:{...original.options,directionRules:rules}}]),[]);
});

test('invalid established records fail saving explicitly while incomplete roots may still be omitted',()=>{
  const valid=map(),oversized=map();
  oversized.graph.edges=Array.from({length:20001},()=>structuredClone(oversized.graph.edges[0]));
  const before=JSON.stringify(oversized);
  assert.throws(()=>serializeLiveMaps([valid,oversized]),/无法保存/,'an established oversized graph must not disappear from a successful save');
  assert.equal(JSON.stringify(oversized),before);assert.deepEqual(readLiveMaps([oversized]),[]);
  const malformed={...valid,nodePaths:{...valid.nodePaths,'unknown-node':'Notes/unknown.md'}};
  assert.throws(()=>serializeLiveMaps([malformed]),/无法保存/);
  assert.equal(serializeLiveMaps([{...valid,rootPath:'',folder:'',graph:{...valid.graph,nodes:[]}}]).length,0);
});

test('structural edge indexing retains the existing edge and evidence deduplication behavior',()=>{
  const original=map(),reference=graph(original.graph.nodes);
  const edges=[...original.graph.edges,...structuredClone(original.graph.edges)];
  edges[edges.length-1].evidence.push({...edges[edges.length-1].evidence[0],quote:'额外证据'});
  edges.push({id:'self-loop',from:'seed-root',to:'seed-root',relation:'mentions',evidence:[{sourceId:'seed-root',quote:'自环不保存',method:'原文'}]});
  original.graph.edges=edges;
  for(const edge of edges)for(const evidence of edge.evidence)addEdge(reference,edge.from,edge.to,edge.relation,{...evidence});
  const before=JSON.stringify(original),saved=serializeLiveMaps([original]);
  assert.deepEqual(saved[0].graph.edges,reference.edges);assert.equal(JSON.stringify(original),before);
});

test('restoration retains terminal state but marks unfinished maps interrupted and bounds the library',()=>{
  const original=map();
  const records=Array.from({length:25},(_,index)=>({...original,id:`map-${index}`,state:(index===1 ? 'paused' : index===2 ? 'complete' : 'running') as LiveMapRecord['state']}));
  const saved=readLiveMaps(records);
  assert.equal(saved.length,20);assert.equal(saved[0].state,'interrupted');assert.equal(saved[1].state,'interrupted');assert.equal(saved[2].state,'complete');
  assert.deepEqual(readLiveMaps(null),[]);assert.equal(readLiveMaps([original,original]).length,1);
});

test('untrusted map paths, root mismatch, malformed graph identities and excessive payloads are rejected',()=>{
  const original=map();
  const malformed:Array<unknown>=[
    {...original,rootPath:'../secret.md'}, {...original,folder:'.obsidian/plugins'},
    {...original,nodePaths:{...original.nodePaths,'seed-root':'C:/secret.md'}},
    {...original,nodePaths:{...original.nodePaths,'seed-root':'Knowledge Seed/起点/其他.md'}},
    {...original,nodePaths:{...original.nodePaths,'fake-id':'Knowledge Seed/概念/私有内容.md'}},
    {...original,seed:{kind:'url',value:'http://127.0.0.1/admin'}},
    {...original,graph:{...original.graph,nodes:[...original.graph.nodes,original.graph.nodes[0]]}},
    {...original,graph:{...original.graph,nodes:Array.from({length:1501},(_,i)=>node(`concept-${i}`,1))}},
    {...original,graph:{...original.graph,edges:[{...original.graph.edges[0],evidence:[{sourceId:'missing-source',quote:'编造',method:'未知'}]}]}},
    {...original,options:{...defaults,generatedFolder:'../bad'}},
  ];
  for(const raw of malformed)assert.deepEqual(readLiveMaps([raw]),[]);
});

test('restoration strips unknown options and nested execution payloads while cloning validated collections',()=>{
  const original=map();
  const restored=readLiveMaps([{...original,unsafe:'secret',options:{...defaults,script:'untrusted-script'},
    graph:{...original.graph,request:{unsafe:'payload'},nodes:original.graph.nodes.map(item=>({...item,unsafe:'payload'}))}}])[0];
  assert.ok(restored);assert.equal('unsafe' in restored,false);assert.equal('script' in restored.options,false);
  assert.equal(restored.graph.request,undefined);assert.equal('unsafe' in restored.graph.nodes[0],false);
  restored.options.searchTerms.push('局部方向');assert.deepEqual(original.options.searchTerms,[]);
  restored.excludedIds.push('concept-left');assert.deepEqual(original.excludedIds,[]);
});

test('single-node pruning preserves notes and descendants but removes edges with missing sources',()=>{
  const original=map(), snapshot=JSON.stringify(original);
  const pruned=pruneLiveMap(original,original.nodePaths['concept-left'],false), visible=visibleLiveGraph(pruned);
  assert.ok(!visible.nodes.some(item=>item.id==='concept-left'));
  assert.ok(visible.nodes.some(item=>item.id==='concept-only'),'single-node pruning leaves the descendant selected');
  assert.ok(visible.nodes.some(item=>item.id==='concept-shared'));
  assert.ok(visible.edges.every(edge=>edge.evidence.every(source=>visible.nodes.some(item=>item.id===source.sourceId))));
  assert.equal(JSON.stringify(original),snapshot);assert.deepEqual(pruned.nodePaths,original.nodePaths);
});

test('branch pruning removes unique outward descendants and preserves shared descendants and their children',()=>{
  const original=map();
  const pruned=pruneLiveMap(original,original.nodePaths['concept-left'],true),visible=visibleLiveGraph(pruned);
  const ids=new Set(visible.nodes.map(item=>item.id));
  assert.equal(ids.has('concept-left'),false);assert.equal(ids.has('concept-only'),false);
  assert.equal(ids.has('concept-right'),true);assert.equal(ids.has('concept-shared'),true);assert.equal(ids.has('concept-shared-child'),true);
  assert.deepEqual(new Set(pruned.excludedIds),new Set(['concept-left','concept-only']));
});

test('branch pruning never walks inward or across equal-depth links to an unrelated branch',()=>{
  const original=map();
  addEdge(original.graph,'concept-left','concept-right','links_to',{sourceId:'concept-left',quote:'同层引用',method:'正文链接'});
  addEdge(original.graph,'concept-only','concept-left','links_to',{sourceId:'concept-only',quote:'向内引用',method:'正文链接'});
  const pruned=pruneLiveMap(original,original.nodePaths['concept-only'],true);
  assert.deepEqual(pruned.excludedIds,['concept-only']);
  const leftCut=pruneLiveMap(original,original.nodePaths['concept-left'],true);
  assert.equal(leftCut.excludedIds.includes('concept-right'),false);
});

test('a shared descendant is retained only when its alternate parent has surviving evidence',()=>{
  const original=map();
  const alternate=original.graph.edges.find(edge=>edge.from==='concept-right'&&edge.to==='concept-shared')!;
  alternate.evidence=[{sourceId:'concept-left',quote:'仅被剪父节点提供的证据',method:'原文'}];
  const cut=pruneLiveMap(original,original.nodePaths['concept-left'],true);
  assert.ok(cut.excludedIds.includes('concept-shared'));assert.ok(cut.excludedIds.includes('concept-shared-child'));
  assert.equal(cut.excludedIds.includes('concept-right'),false);
});

test('pruning masks follow merged identities and cannot hide the map root',()=>{
  const original=map(), left=original.graph.nodes.find(item=>item.id==='concept-left')!;
  left.managedId='concept-owned-left';left.mergedIds=['concept-former-left'];
  original.excludedIds=['seed-root','concept-former-left'];
  assert.ok(visibleLiveGraph(original).nodes.some(item=>item.kind==='seed'));
  assert.equal(visibleLiveGraph(original).nodes.some(item=>item.id===left.id),false);
  const restored=readLiveMaps([original])[0];assert.equal(restored.excludedIds.includes('seed-root'),false);
  assert.throws(()=>pruneLiveMap(original,original.rootPath,false),/不能剪除/);
  assert.throws(()=>pruneLiveMap(original,'../bad.md',true),/路径无效/);
  assert.throws(()=>pruneLiveMap(original,'Knowledge Seed/概念/不在图中.md',false),/不在当前图谱/);
});

test('branch expansion keeps the original root and connects new evidence to the selected concept',()=>{
  const original=map().graph, branch=graph([node('seed-branch',0,'seed','左分支'),node('concept-new',1)]);
  addEdge(branch,'seed-branch','concept-new','keyword_match',{sourceId:'concept-new',quote:'新来源证据',method:'原文匹配'});
  const merged=mergeLiveGraph(original,branch,'concept-left');
  assert.equal(merged.nodes.filter(item=>item.kind==='seed').length,1);assert.equal(merged.nodes[0].id,'seed-root');
  assert.equal(merged.seed,'中心');assert.equal(merged.nodes.find(item=>item.id==='concept-new')?.depth,2);
  const connection=merged.edges.find(edge=>edge.to==='concept-new')!;
  assert.equal(connection.from,'concept-left');assert.equal(connection.evidence[0].sourceId,'concept-new');
  assert.equal(original.nodes.some(item=>item.id==='concept-new'),false);
});

test('shared explicit identities merge without creating duplicate nodes and same-title sources stay separate',()=>{
  const original=map().graph, left=original.nodes[1];left.managedId='concept-owner';left.mergedIds=['concept-alias'];
  const branch=graph([node('seed-more',0,'seed'),{...node('web-verified',1,'web',left.title),managedId:'concept-owner',
    mergedIds:['concept-alias'],status:'retrieved',locator:'https://example.org/verified',reading:{state:'ready'},
    article:{blocks:[{type:'paragraph',text:'真实正文'}],textChars:4,totalTextChars:4,truncated:false}},
    {...node('web-other',1,'web',left.title),locator:'https://example.org/unrelated',status:'retrieved'}]);
  addEdge(branch,'seed-more','web-verified','seed_source',{sourceId:'web-verified',quote:'真实正文',method:'网页'});
  addEdge(branch,'seed-more','web-other','seed_source',{sourceId:'web-other',quote:'另一来源',method:'网页'});
  const merged=mergeLiveGraph(original,branch);
  assert.equal(merged.nodes.filter(item=>item.managedId==='concept-owner').length,1);
  assert.ok(merged.nodes.some(item=>item.id==='web-other'));assert.equal(merged.nodes.find(item=>item.id===left.id)?.article?.textChars,4);
  assert.ok(merged.nodes.find(item=>item.id===left.id)?.mergedIds?.includes('web-verified'));
  assert.ok(merged.edges.some(edge=>edge.to===left.id && edge.evidence[0].sourceId===left.id));
});

test('a pruned identity remains hidden when a later discovery emits its retained alias',()=>{
  const original=map(),pruned=pruneLiveMap(original,original.nodePaths['concept-left'],false);
  const later=graph([node('seed-next',0,'seed'),{...node('concept-renamed',1),mergedIds:['concept-left']}]);
  addEdge(later,'seed-next','concept-renamed','mentions',{sourceId:'seed-next',quote:'原身份再被提及',method:'正文'});
  const merged=mergeLiveGraph(original.graph,later);
  const updated={...pruned,graph:merged};
  assert.equal(visibleLiveGraph(updated).nodes.some(item=>item.id==='concept-left'),false);
  assert.equal(visibleLiveGraph(updated).nodes.some(item=>item.id==='concept-renamed'),false);
});

test('conflicting aliases and missing branch or evidence sources fail without mutating either graph',()=>{
  const original=map().graph,branch=graph([node('seed-next',0,'seed'),{...node('concept-conflict',1),mergedIds:['concept-left','concept-right']}]);
  const before=JSON.stringify(original);assert.throws(()=>mergeLiveGraph(original,branch),/多个已有身份/);assert.equal(JSON.stringify(original),before);
  assert.throws(()=>mergeLiveGraph(original,graph([node('seed-next',0,'seed')]),'not-in-map'),/已经不在/);
  const broken=graph([node('seed-next',0,'seed'),node('concept-new',1)]);
  broken.edges.push({id:'missing-evidence',from:'seed-next',to:'concept-new',relation:'mentions',evidence:[{sourceId:'missing-source',quote:'bad',method:'bad'}]});
  assert.throws(()=>mergeLiveGraph(original,broken),/缺失的关系/);assert.equal(JSON.stringify(original),before);
});

test('same-root cumulative snapshots keep request counts stable while independent branches add their work',()=>{
  const original=map().graph;original.stats.requests=4;
  const snapshot=structuredClone(original);snapshot.stats.requests=7;
  const first=mergeLiveGraph(original,snapshot), repeated=mergeLiveGraph(first,snapshot);
  assert.equal(first.stats.requests,7);assert.equal(repeated.stats.requests,7);
  const branch=graph([node('seed-branch',0,'seed'),node('concept-branch',1)]);branch.stats.requests=2;
  assert.equal(mergeLiveGraph(repeated,branch,'concept-left').stats.requests,9);
});

test('a bodyless discovery cannot downgrade an already readable node and conflicting sources are rejected',()=>{
  const original=map().graph,left=original.nodes[1];left.kind='web';left.managedId='concept-owner';
  left.locator='https://example.org/verified';left.bodyAvailable=true;left.status='retrieved';left.reading={state:'ready'};
  left.article={blocks:[{type:'paragraph',text:'已保留正文'}],textChars:5,totalTextChars:5,truncated:false};
  const snapshot=graph([node('seed-next',0,'seed'),{...node('concept-prefix',1),managedId:'concept-owner',bodyAvailable:true,reading:{state:'pending'}}]);
  const updated=mergeLiveGraph(original,snapshot).nodes.find(item=>item.id===left.id)!;
  assert.equal(updated.kind,'web');assert.equal(updated.locator,left.locator);assert.equal(updated.reading?.state,'ready');
  assert.equal(updated.article?.textChars,5);assert.equal(updated.bodyAvailable,true);
  const conflict=graph([node('seed-next',0,'seed'),{...node('web-conflict',1,'web'),managedId:'concept-owner',locator:'https://example.org/different'}]);
  assert.throws(()=>mergeLiveGraph(original,conflict),/不同网页来源/);
});
