import test from 'node:test';
import assert from 'node:assert/strict';
import { readManagedNote } from '../src/managed-note';
import { exportGraph, mergeManagedWebMetadata } from '../src/export';
import { stableId } from '../src/graph';
import { clampOptions, type EngineAdapter } from '../src/engine';
import { exploreConcepts } from '../src/exploration';

const placeholder='来源正文中的术语或链接名称，定义与语义关系待核实。';
const note=(fields='',body='')=>`---\nknowledge_seed_id: 'concept-a'\ntitle: '术语 - 维基百科，自由的百科全书'\nkind: concept\n${fields}---\n\n# 术语\n\n> ${placeholder}\n${body}`;

test('automatic body eligibility ignores generated evidence and status but protects actual manual content',()=>{
  const empty=note('reading_state: pending\n',`\n## 关系与证据\n<!-- knowledge-seed:links:concept-a -->\n- [[源笔记]] 提及这个术语\n<!-- /knowledge-seed:links:concept-a -->\n<!-- knowledge-seed:reading:concept-a -->\n> 正文尚未读取。\n<!-- /knowledge-seed:reading:concept-a -->\n%% 私人注释 %%`);
  assert.equal(readManagedNote(empty,'fallback')?.bodyAvailable,false);
  assert.equal(readManagedNote(empty,'fallback')?.title,'术语');
  assert.equal(readManagedNote(empty+'\n这是我自己补写的解释。\n','fallback')?.bodyAvailable,true);
  assert.equal(readManagedNote(empty+'\n<!-- knowledge-seed:article:concept-a:hash -->\n','fallback')?.bodyAvailable,true);
});

test('blank quoted sources can be assigned once, while conflicting source identity remains protected',()=>{
  for(const quoted of ['""',"''"]){
    const original=note(`source: ${quoted}\nentity_url: ${quoted}\ncustom_manual: retained\n`);
    assert.equal(readManagedNote(original,'fallback')?.source,undefined);
    const upgraded=mergeManagedWebMetadata(original,'concept-a','https://example.org/term',true);
    assert.equal((upgraded.match(/^source:/gm)??[]).length,1);
    assert.ok(upgraded.includes('source: "https://example.org/term"'));
    assert.ok(upgraded.includes('custom_manual: retained'));
    assert.ok(upgraded.includes(placeholder));
    assert.equal(readManagedNote(upgraded,'fallback')?.source,'https://example.org/term');
    assert.equal(mergeManagedWebMetadata(upgraded,'concept-a','https://example.org/other',true),upgraded);
    assert.throws(()=>mergeManagedWebMetadata(original.replace(`source: ${quoted}`,'source: https://example.org/different'),'concept-a','https://example.org/term',true),/冲突|不一致/);
  }
  assert.throws(()=>readManagedNote(note('source: https://example.org/a\nentity_url: https://example.org/b\n'),'fallback'),/不一致/);
});

test('single-file eligibility uses controlled ownership and merged identities rather than ambiguous YAML',()=>{
  const parsed=readManagedNote(note('knowledge_seed_merged_ids:\n  - concept-old\nreading_state: excluded\n'),'fallback')!;
  assert.deepEqual(parsed.mergedIds,['concept-old']);assert.equal(parsed.readingState,'excluded');
  assert.equal(readManagedNote('# ordinary user note\n', 'ordinary'),undefined);
  assert.throws(()=>readManagedNote(note('knowledge_seed_id: another\n'),'fallback'),/重复/);
  assert.throws(()=>readManagedNote(note('source: |\n  https://example.org/a\n'),'fallback'),/不支持/);
});

test('failed URL exploration exports empty placeholders that remain eligible for independent body reading',async()=>{
  const adapter:EngineAdapter={listNotes:()=>[],readNote:async()=>{throw new Error('unexpected local read');},resolveLink:()=>null,
    request:async()=>{throw new Error('source request timed out');}};
  const graph=await exploreConcepts({kind:'url',value:'https://example.org/Finite_state_machine'},adapter,
    clampOptions({maxNotes:0,maxPages:1,searchLimit:0}));
  assert.equal(graph.nodes.length,2);
  const candidate=graph.nodes.find(node=>node.kind==='concept')!;
  assert.equal(candidate.reading?.state,'failed');
  const bundle=exportGraph(graph,'Maps','failed-source');
  for(const node of graph.nodes){
    const file=bundle.files.find(file=>file.path===bundle.nodePaths[node.id])!;
    assert.equal(readManagedNote(file.content,node.title)?.bodyAvailable,false);
  }
  const empty=bundle.files.find(file=>file.path===bundle.nodePaths[candidate.id])!.content;
  assert.equal(readManagedNote(empty+'\n我自己写下的解释必须保留。\n',candidate.title)?.bodyAvailable,true);
});

test('new empty-body notices ignore metadata readiness and match only unchanged complete quoted lines',()=>{
  for(const notice of [
    '用户指定网页，等待读取来源与概念。',
    '后台逐步发现来源与概念；词项匹配和提及不表示因果关系。',
    '公开百科搜索返回的候选名称；尚未读取来源正文。',
  ]){
    const empty=note('reading_state: ready\n',`\n> ${notice}\n`);
    assert.equal(readManagedNote(empty,'fallback')?.bodyAvailable,false);
    assert.equal(readManagedNote('\uFEFF'+empty.replace(/\n/g,'\r\n'),'fallback')?.bodyAvailable,false);
    assert.equal(readManagedNote(note('',`\n> ${notice} 用户补充说明。\n`),'fallback')?.bodyAvailable,true);
    assert.equal(readManagedNote(note('',`\n${notice}\n`),'fallback')?.bodyAvailable,true);
  }
});

test('intact owner-bound search excerpts are pending body rather than manual content, while edits stay protected',()=>{
  const excerpt='> API search returned this brief excerpt, not the detailed source article.\n\n';
  const block=`<!-- knowledge-seed:excerpt:concept-a:${stableId(excerpt)} -->\n${excerpt}\n<!-- /knowledge-seed:excerpt:concept-a -->`;
  const empty=note('reading_state: pending\n',block);
  assert.equal(readManagedNote(empty,'fallback')?.bodyAvailable,false);
  assert.equal(readManagedNote(empty.replace(/\n/g,'\r\n'),'fallback')?.bodyAvailable,false);
  assert.equal(readManagedNote(empty.replace('brief excerpt','my human-written explanation'),'fallback')?.bodyAvailable,true);
  assert.equal(readManagedNote(empty.replaceAll('excerpt:concept-a','excerpt:concept-other'),'fallback')?.bodyAvailable,true);
  assert.equal(readManagedNote(empty.replace('<!-- /knowledge-seed:excerpt:concept-a -->',''),'fallback')?.bodyAvailable,true);
  assert.equal(readManagedNote(empty+'\nMy own content outside the managed excerpt.\n','fallback')?.bodyAvailable,true);
});
