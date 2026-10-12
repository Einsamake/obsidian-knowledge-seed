import test from 'node:test';
import assert from 'node:assert/strict';
import { readHistory, rememberRun, moveRun, type RunRecord } from '../src/history';
import { defaults } from '../src/engine';
const record = (id: number): RunRecord => ({ run: {rootPath:'Graph/脑科学.md', folder:`Graph/Runs/${id}`, search:'path:Graph', nodePaths:{root:'Graph/脑科学.md'}}, title:'脑科学', nodes:2, relations:1, createdAt:'2026-10-05T00:00:00Z' });
test('old valid reading targets migrate in replay history without rescuing other invalid settings', () => {
  const request = {seed:{kind:'topic' as const,value:'脑科学'},options:{...defaults,maxBodyChars:1000,graphDepth:3}};
  const restored = readHistory([{...record(1),request}])[0];
  assert.equal(restored.request?.options.maxBodyChars,2000);
  assert.equal(request.options.maxBodyChars,1000);
  assert.equal(readHistory([{...record(1),request:{...request,options:{...request.options,depth:21}}}])[0].request,undefined);
  assert.equal(readHistory([{...record(1),request:{...request,options:{...request.options,maxBodyChars:79}}}])[0].request,undefined);
});
test('history is bounded and deduplicates run folders rather than equal topic names', () => {
  let history: RunRecord[] = [];
  for (let i=0;i<30;i++) history = rememberRun(history,record(i));
  assert.equal(history.length,20); assert.equal(history[0].run.folder,'Graph/Runs/29');
  history = rememberRun(history,{...record(28),nodes:3});
  assert.equal(history.length,20); assert.equal(history[0].nodes,3);
});
test('restoring malformed or unsafe history does not introduce arbitrary paths', () => {
  assert.deepEqual(readHistory(null),[]);
  assert.equal(readHistory([record(1),{...record(2),run:{...record(2).run,rootPath:'../secret.md'}},{...record(3),createdAt:'invalid'},{...record(4),run:{...record(4).run,nodePaths:{bad:'C:/secret.md'}}}]).length,1);
});
test('rename remaps history graph scope without mutating historical records', () => {
  const original = record(1); const moved = moveRun(original.run,new Map([['Graph/脑科学.md','Graph/脑科学 (2).md']]));
  assert.equal(moved.rootPath,'Graph/脑科学 (2).md');
  assert.equal(moved.nodePaths?.root,moved.rootPath); assert.ok(moved.search.includes('脑科学'));
  assert.equal(original.run.rootPath,'Graph/脑科学.md');
});

test('bad saved exploration requests lose only the rerun action and preserve readable history', () => {
  const validRequest = { seed: {kind:'topic' as const,value:'脑科学'}, options: {...defaults,graphDepth:3} };
  const malformed: unknown[] = [true, 'unexpected text', {}, {seed:null,options:null},
    {...validRequest,options:{...validRequest.options,depth:'3'}},
    {...validRequest,options:{...validRequest.options,graphDepth:6}},
    {...validRequest,options:{...validRequest.options,searchTerms:[null]}},
    {...validRequest,seed:{kind:'url',value:'http://localhost/private'}},
    {...validRequest,seed:{kind:'url',value:'https://example.org'},options:{...validRequest.options,web:false}},
  ];
  for (const request of malformed) {
    const restored = readHistory([{...record(1),request}]);
    assert.equal(restored.length,1);
    assert.equal(restored[0].request,undefined);
    assert.equal(restored[0].title,'脑科学');
  }
});

test('restored saved parameters are isolated from raw persisted input arrays and seed', () => {
  const request = { seed: {kind:'note' as const,value:'Graph/脑科学.md'}, options: {...defaults,graphDepth:3,
    searchTerms:['神经科学'],excludeTerms:['学院'],excludeFolders:['Templates']} };
  const restored = readHistory([{...record(1),request}])[0].request!;
  restored.seed.value='Graph/新主题.md'; restored.options.searchTerms.push('睡眠');
  restored.options.excludeTerms[0]='广告'; restored.options.excludeFolders.push('Private');
  assert.equal(request.seed.value,'Graph/脑科学.md');
  assert.deepEqual(request.options.searchTerms,['神经科学']);
  assert.deepEqual(request.options.excludeTerms,['学院']);
  assert.deepEqual(request.options.excludeFolders,['Templates']);
});

test('saved exploration history retains a strategy and clones its nested direction rules', () => {
  const request={seed:{kind:'topic' as const,value:'Graph'},options:{...defaults,graphDepth:3,explorationStrategy:'custom' as const,
    breadthDecay:0,directionDepthBoost:3,offDirectionDepth:1,directionRules:[{term:'Statistics',weight:8,depth:4}]}};
  const restored=readHistory([{...record(1),request}])[0].request!;
  assert.ok(restored);assert.equal(restored.options.explorationStrategy,'custom');assert.equal(restored.options.breadthDecay,0);
  assert.deepEqual(restored.options.directionRules,request.options.directionRules);
  restored.options.directionRules![0].weight=1;assert.equal(request.options.directionRules[0].weight,8);
  const invalid={...request,options:{...request.options,directionRules:[{term:'Statistics',weight:99}]}};
  assert.equal(readHistory([{...record(1),request:invalid}])[0].request,undefined);
});

test('rename remaps only changed graph paths and escapes path punctuation in native scope', () => {
  const original = {...record(1).run,nodePaths:{root:'Graph/脑科学.md',source:'Graph/来源 (2).md',note:'Notes/私人的笔记.md'}};
  const changed=moveRun(original,new Map([['Graph/脑科学.md','Graph/脑科学 (2).md'],['Graph/来源 (2).md','Graph/来源 + 手册.md']]));
  assert.deepEqual(changed.nodePaths,{root:'Graph/脑科学 (2).md',source:'Graph/来源 + 手册.md',note:'Notes/私人的笔记.md'});
  const scope=new RegExp(changed.search.slice('path:/'.length,-1));
  for(const path of Object.values(changed.nodePaths!)) assert.ok(scope.test(path));
  assert.equal(scope.test('Graph/脑科学.md'),false);
  assert.equal(scope.test('Graph/来源 x 手册.md'),false);
  assert.equal(original.nodePaths.root,'Graph/脑科学.md');
  assert.equal(original.nodePaths.source,'Graph/来源 (2).md');
});
