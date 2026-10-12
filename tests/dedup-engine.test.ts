import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { generateGraph, type EngineAdapter, type NoteRef } from '../src/engine';
import { nodeId } from '../src/graph';

Object.assign(globalThis,{DOMParser});
const rootUrl = 'https://zh.wikipedia.org/wiki/Research_origin';
const urlA = 'https://zh.wikipedia.org/wiki/Institution_A', urlB = 'https://zh.wikipedia.org/wiki/Institution_B';
const label = '同名机构';
function page(title:string,links:Array<{url:string;label:string}> = []) {
  return `<!doctype html><html><head><title>${title} - 维基百科，自由的百科全书</title></head><body>
    <h1 id="firstHeading">${title}</h1><div id="mw-content-text"><div class="mw-parser-output">
    <p>本研究起点使用可追溯的来源说明机构历史、研究方法与公开档案。相同名称并不保证机构身份相同，需要核对网页地址以及各自独立的正文证据。来源解析必须保留其原有身份和关系信息。</p>
    ${links.map(link=>`<p>研究起点中的公开档案提到 <a href="${link.url}">${link.label}</a>，其实体身份必须由对应网址确定，并保留引用上下文以供读者核查。</p>`).join('')}
    </div></div></body></html>`;
}
function adapter(rootLinks:Array<{url:string;label:string}>,notes:NoteRef[] = []) {
  const requests:string[] = [], reads:string[] = [];
  const pages:Record<string,string> = {[rootUrl]:page('研究起点',rootLinks),[urlA]:page(label),[urlB]:page(label)};
  const value:EngineAdapter = {request:async url=>{requests.push(url); return {status:pages[url] ? 200 : 404,text:pages[url] ?? '',headers:{'content-type':'text/html'}};},
    listNotes:()=>notes,readNote:async path=>{reads.push(path); return '已有机构 A 的人工笔记。';},
    resolveLink:link=>notes.find(note=>note.title===link)?.path ?? null};
  return {value,requests,reads};
}

test('same-label links to distinct public URLs retain independent concept aliases when their retrieved pages coalesce',async()=>{
  const fixture = adapter([{url:urlA,label},{url:urlB,label}]);
  const result = await generateGraph({kind:'url',value:rootUrl},fixture.value,{maxPages:3,depth:1,maxNotes:0,maxConcepts:8,searchLimit:0,relevance:'broad'});
  const a = result.nodes.find(node=>node.kind==='web' && node.locator===urlA);
  const b = result.nodes.find(node=>node.kind==='web' && node.locator===urlB);
  assert.ok(a); assert.ok(b); assert.equal(a.title,label); assert.equal(b.title,label); assert.notEqual(a.id,b.id);
  const conceptA = nodeId('concept',`url:${urlA}`), conceptB = nodeId('concept',`url:${urlB}`);
  assert.notEqual(conceptA,conceptB);
  assert.ok(a.mergedIds?.includes(conceptA)); assert.ok(b.mergedIds?.includes(conceptB));
  assert.ok(!a.mergedIds?.includes(conceptB)); assert.ok(!b.mergedIds?.includes(conceptA));
  assert.ok(!result.nodes.some(node=>node.kind==='concept' && node.title===label));
  assert.equal(new Set(fixture.requests).size,3);
  for (const target of [a,b]) assert.ok(result.edges.some(edge=>edge.relation==='mentions' && edge.to===target.id));
});

test('a previously generated page A is not reused for a same-label incoming link to URL B',async()=>{
  const existingPath = 'Knowledge Seed/网页/同名机构.md', ownerA = nodeId('web',urlA);
  const fixture = adapter([{url:urlB,label}],[{path:existingPath,title:label,managedId:ownerA,sourceUrl:urlA}]);
  const result = await generateGraph({kind:'url',value:rootUrl},fixture.value,{maxPages:1,depth:0,maxNotes:0,maxConcepts:8,searchLimit:0,relevance:'broad',generatedFolder:'Knowledge Seed'});
  const b = result.nodes.find(node=>node.kind==='concept' && node.entityUrl===urlB);
  assert.ok(b); assert.equal(b.id,nodeId('concept',`url:${urlB}`));
  assert.equal(b.locator,undefined); assert.equal(b.managedId,undefined);
  assert.ok(!result.nodes.some(node=>node.locator===existingPath || node.managedId===ownerA));
  assert.deepEqual(fixture.reads,[]); assert.deepEqual(fixture.requests,[rootUrl]);
});
