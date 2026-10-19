import test from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, type KnowledgeGraph } from '../src/graph';
import { moveRoaming, normalizeRoaming, projectRoaming, readRoaming } from '../src/roaming';

function graph(count=8):KnowledgeGraph {
  const graph:KnowledgeGraph={version:1,seed:'主题',createdAt:'2026-10-19T00:00:00Z',nodes:[],edges:[],warnings:[],stats:{requests:0,notesScanned:0,pagesAttempted:0}};
  for(let i=0;i<count;i++)graph.nodes.push({id:`n-${i}`,title:`概念${i}`,kind:i?'concept':'seed',depth:i,status:'derived',excerpt:'正文'});
  for(let i=1;i<count;i++)addEdge(graph,`n-${i-1}`,`n-${i}`,'mentions',{sourceId:`n-${i-1}`,quote:'原文',method:'名称提及'});
  return graph;
}
test('fog, radius, and revealing bound the view without changing the complete graph',()=>{
  const g=graph(),before=JSON.stringify(g);
  const s=moveRoaming(g,undefined,{type:'enabled',value:true});s.radius=3;
  assert.deepEqual(projectRoaming(g,s).nodes.map(n=>n.id),['n-0','n-1']);
  assert.equal(projectRoaming(g,s).frontier[0].hidden,1);
  const reveal=moveRoaming(g,s,{type:'reveal'});
  assert.deepEqual(projectRoaming(g,reveal).nodes.map(n=>n.id),['n-0','n-1','n-2']);
  assert.deepEqual(reveal.visited,['n-0'],'revealing is not visiting or learning');
  assert.equal(projectRoaming(g,{...s,fog:false}).nodes.length,4);
  assert.equal(JSON.stringify(g),before);
});
test('navigation, teleport, back, forward and home keep an independent route',()=>{
  const g=graph();let s=moveRoaming(g,undefined,{type:'enter',node:'n-5'});
  assert.equal(s.enabled,true);assert.equal(s.center,'n-5');assert.deepEqual(s.back,['n-0']);
  assert.ok(s.revealed.includes('n-6'));assert.deepEqual(projectRoaming(g,s).nodes.map(n=>n.id),['n-5','n-4','n-6']);
  s=moveRoaming(g,s,{type:'back'});assert.equal(s.center,'n-0');
  s=moveRoaming(g,s,{type:'forward'});assert.equal(s.center,'n-5');
  s=moveRoaming(g,s,{type:'home'});assert.equal(s.center,'n-0');
  s=moveRoaming(g,s,{type:'back'});s=moveRoaming(g,s,{type:'enter',node:'n-2'});
  assert.deepEqual(s.forward,[]);assert.throws(()=>moveRoaming(g,s,{type:'enter',node:'missing'}),/不在当前图谱/);
});
test('new neighbors appear locally without moving the reader; deleted and merged identities restore safely',()=>{
  const g=graph();let s=moveRoaming(g,undefined,{type:'enter',node:'n-4'});
  const grown=structuredClone(g);grown.nodes.push({...g.nodes[1],id:'new'});
  addEdge(grown,'n-4','new','mentions',{sourceId:'n-4',quote:'新证据',method:'提及'});
  assert.ok(projectRoaming(grown,s).nodes.some(n=>n.id==='new'));
  assert.equal(projectRoaming(grown,s).state.center,'n-4');
  const merged=structuredClone(g);merged.nodes[4]={...merged.nodes[4],id:'canonical',mergedIds:['n-4']};
  s=normalizeRoaming(s,merged);assert.equal(s.center,'canonical');
  merged.nodes=merged.nodes.filter(n=>n.id!=='canonical');
  assert.equal(normalizeRoaming(s,merged).center,'n-0');
});
test('high degree, cycles and disconnected nodes stay bounded and deterministic',()=>{
  const g=graph(1500);g.edges=[];
  for(let i=1;i<1499;i++)addEdge(g,'n-0',`n-${i}`,'mentions',{sourceId:'n-0',quote:'证据',method:'提及'});
  addEdge(g,'n-3','n-4','mentions',{sourceId:'n-3',quote:'循环',method:'提及'});
  const p=projectRoaming(g,{enabled:true,fog:false,radius:3,limit:40});
  assert.equal(p.nodes.length,40);assert.equal(p.nodes[0].id,'n-0');assert.equal(p.nearby,1499);
  assert.equal(p.frontier[0].hidden,1459);assert.ok(!p.nodes.some(n=>n.id==='n-1499'));
  assert.equal(p.frontier[0].next[0].id,'n-40','a crowded boundary offers an actual destination beyond the visible cap');
  assert.deepEqual(projectRoaming(g,p.state).nodes,p.nodes);
});
test('restored state is bounded, sanitized and scoped only to existing maps',()=>{
  const g=graph(),raw={enabled:'true',fog:false,radius:Infinity,limit:-20,center:'bad',back:Array(200).fill('n-1'),forward:['bad'],visited:['n-2',null],revealed:['n-3'],body:'discard'};
  const s=normalizeRoaming(raw,g);assert.equal(s.enabled,false);assert.equal(s.radius,1);assert.equal(s.limit,10);assert.equal(s.center,'n-0');
  assert.equal(s.back.length,50);assert.deepEqual(s.forward,[]);assert.equal('body' in s,false);
  const restored=readRoaming([{mapId:'one',state:s},{mapId:'missing',state:s},{mapId:'one',state:{center:'n-4'}}],[{id:'one',graph:g}]);
  assert.equal(restored.size,1);assert.equal(restored.get('one')!.center,'n-0');
  for(let i=0;i<120;i++)Object.assign(s,moveRoaming(g,s,{type:'enter',node:`n-${i%8}`}));
  assert.equal(s.back.length,50);
});
