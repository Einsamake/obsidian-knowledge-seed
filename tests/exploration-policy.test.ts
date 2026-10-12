import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOptions } from '../src/engine';
import { compareExplorationWork, explorationDirectionTerms, explorationPolicy } from '../src/exploration-policy';

test('radial exploration breadth decreases outward while configured depth remains a hard ceiling', () => {
  const options = clampOptions({ depth: 5, linkLimit: 12 });
  assert.deepEqual([0, 1, 2, 3].map(hop => explorationPolicy('概念', '', hop, options).breadth), [12, 6, 4, 3]);
  assert.equal(explorationPolicy('概念', '', 3, options).depthCap, 5);
});
test('direction words allocate full depth and greater breadth only to matching branches', () => {
  const options = clampOptions({ depth: 6, linkLimit: 20, searchTerms: ['统计学'] });
  const focused = explorationPolicy('统计学应用', '', 1, options), other = explorationPolicy('历史学', '', 1, options);
  assert.equal(focused.focused, true); assert.equal(focused.depthCap, 6); assert.equal(focused.breadth, 15);
  assert.equal(other.focused, false); assert.equal(other.depthCap, 3); assert.equal(other.breadth, 5);
  assert.ok(focused.priority > other.priority);
});
test('direction context is a lexical signal and English boundaries avoid partial-word false matches', () => {
  const options = clampOptions({ depth: 4, searchTerms: ['AI'] });
  assert.equal(explorationPolicy('Detailed', 'A detailed report', 1, options).focused, false);
  assert.equal(explorationPolicy('Research', 'This source discusses AI methods.', 1, options).focused, true);
});
test('manual depth and link caps are never increased by direction allocation', () => {
  const options = clampOptions({ depth: 2, linkLimit: 5, searchTerms: ['数学'] });
  for (let hop = 0; hop < 20; hop++) {
    const policy = explorationPolicy('数学', '', hop, options);
    assert.ok(policy.breadth <= 5); assert.ok(policy.depthCap <= 2);
  }
});
test('zero breadth or depth remains zero even with a matching exploration direction', () => {
  const policy = explorationPolicy('数学', '', 0, clampOptions({ depth: 0, linkLimit: 0, searchTerms: ['数学'] }));
  assert.equal(policy.breadth, 0); assert.equal(policy.depthCap, 0);
});
test('no direction terms means ordinary radial expansion, independent of unrelated source labels', () => {
  const options = clampOptions({ depth: 3, linkLimit: 8 });
  const a = explorationPolicy('统计学', '数学', 2, options), b = explorationPolicy('历史', '文化', 2, options);
  assert.equal(a.focused, false); assert.deepEqual(a, b);
});

test('topic focus uses center titles without letting an incidental center quotation promote every neighbor', () => {
  const options = clampOptions({explorationStrategy:'focused',depth:6,linkLimit:20});
  const topic = explorationPolicy('Graph algorithms','',2,options,'Graph');
  const incidental = explorationPolicy('A university','Graph researchers visited a university.',2,options,'Graph');
  assert.equal(topic.focused,true);assert.equal(topic.depthCap,6);
  assert.equal(incidental.focused,false);assert.equal(incidental.depthCap,2);
  assert.ok(topic.breadth > incidental.breadth);assert.ok(topic.priority > incidental.priority);
});

test('horizontal coverage preserves layer width while chain discovery deliberately narrows each source', () => {
  const breadth = clampOptions({explorationStrategy:'breadth',depth:6,linkLimit:12,searchTerms:['Graph']});
  assert.deepEqual([0,1,2,3].map(hop=>explorationPolicy('History','',hop,breadth).breadth),[12,12,12,12]);
  assert.equal(explorationPolicy('History','',3,breadth).depthCap,6);
  const depth = {...breadth,explorationStrategy:'depth' as const};
  assert.deepEqual([0,1,2,3].map(hop=>explorationPolicy('History','',hop,depth).breadth),[3,3,3,3]);
});

test('custom allocation accepts zero decay, respects rule depth and weights, and retains hard ceilings', () => {
  const options = clampOptions({explorationStrategy:'custom',depth:5,linkLimit:8,breadthDecay:0,offDirectionDepth:1,directionDepthBoost:2,
    directionRules:[{term:'Statistics',weight:2},{term:'Physics',weight:8,depth:4},{term:'Stop here',weight:3,depth:0}]});
  assert.deepEqual([0,1,2,3].map(hop=>explorationPolicy('History','',hop,options).breadth),[8,8,8,8]);
  assert.equal(explorationPolicy('History','',1,options).depthCap,1);
  assert.equal(explorationPolicy('Statistics','',1,options).depthCap,3);
  assert.equal(explorationPolicy('Physics','',1,options).depthCap,4);
  assert.equal(explorationPolicy('Stop here','',1,options).depthCap,0);
  assert.ok(explorationPolicy('Physics','',1,options).priority > explorationPolicy('Statistics','',1,options).priority);
  for(const strategy of ['radial','focused','breadth','depth','custom'] as const) for(let hop=0;hop<25;hop++) {
    const policy=explorationPolicy('Physics','',hop,{...options,depth:2,linkLimit:1,explorationStrategy:strategy});
    assert.ok(policy.depthCap<=2);assert.ok(policy.breadth<=1);
    assert.equal(explorationPolicy('Physics','',hop,{...options,depth:0,linkLimit:0,explorationStrategy:strategy}).depthCap,0);
    assert.equal(explorationPolicy('Physics','',hop,{...options,depth:0,linkLimit:0,explorationStrategy:strategy}).breadth,0);
  }
});

test('frontier order changes from layer coverage to chain depth or custom branch priority', () => {
  const shallow={distance:1,priority:1,sequence:0},deep={distance:3,priority:2,sequence:1};
  assert.ok(compareExplorationWork(shallow,deep,clampOptions({explorationStrategy:'breadth'}))<0);
  assert.ok(compareExplorationWork(shallow,deep,clampOptions({explorationStrategy:'depth'}))>0);
  assert.ok(compareExplorationWork(shallow,deep,clampOptions({explorationStrategy:'custom'}))>0);
  const input=clampOptions({directionRules:[{term:'Low',weight:1},{term:'High',weight:9}],searchTerms:['Extra','High']});
  assert.deepEqual(explorationDirectionTerms(input),['High','Low','Extra']);
  assert.equal(input.directionRules![0].term,'Low','query ranking cannot reorder a saved setting');
});
