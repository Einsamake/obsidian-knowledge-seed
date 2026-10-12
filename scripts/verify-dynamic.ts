import { readFile, writeFile } from 'node:fs/promises';
import { DOMParser } from 'linkedom';
import { discoverDynamic } from '../src/dynamic';
import { defaults, type EngineAdapter } from '../src/engine';
import { articleBodyTextChars } from '../src/article';
import { publicUrl } from '../src/web';
import type { KnowledgeGraph } from '../src/graph';

Object.assign(globalThis,{DOMParser});
const live = process.argv.includes('--live');
const version=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8')).version as string;
const release=version.replace(/\.0$/,'');
const source = 'https://en.wikipedia.org/wiki/Neuroscience';
const calls: string[] = [];
const events: Array<{elapsedMs:number;readable:number;pending:number;reading:string[]}> = [];
const start = Date.now();
let finish = false;
const adapter: EngineAdapter = {
  listNotes:()=>[],readNote:async()=>'',resolveLink:()=>null,
  request:async input=>{
    const url=publicUrl(input); calls.push(url);
    if(live){
      const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'User-Agent':`KnowledgeSeed/${version} (dynamic reading validation)`}});
      return {status:response.status,text:await response.text(),headers:{'content-type':response.headers.get('content-type')??'text/html'}};
    }
    const name = calls.length===1?'neuroscience':'google-knowledge-graph';
    return {status:200,text:await readFile(new URL(`../tests/fixtures/wikipedia-${name}.html`,import.meta.url),'utf8'),headers:{'content-type':'text/html'}};
  }
};
let finalSnapshot: KnowledgeGraph|undefined;
const graph = await discoverDynamic({kind:'url',value:source},adapter,{...defaults,wikiLanguage:'en',readingPace:'fast',readingMode:'adaptive'},undefined,()=>{}, {
  shouldFinish:()=>finish,
  onSnapshot:snapshot=>{
    finalSnapshot=snapshot;
    const readable=snapshot.nodes.filter(node=>node.article).length;
    events.push({elapsedMs:Date.now()-start,readable,pending:snapshot.nodes.filter(node=>node.reading?.state==='pending').length,
      reading:snapshot.nodes.filter(node=>node.reading?.state==='reading').map(node=>node.title)});
    if(readable>=3)finish=true;
  }
});
const ids=new Set(graph.nodes.map(node=>node.id));
const report={checkedAt:new Date().toISOString(),mode:live?'fresh public requests':'previous real HTML fixtures',elapsedMs:Date.now()-start,
  firstReadableMs:events.find(event=>event.readable>0)?.elapsedMs,finishRequested:finish,stopReason:graph.reading?.stopReason,
  events,calls,stats:graph.stats,sources:graph.nodes.filter(node=>node.article).map(node=>({title:node.title,url:node.locator,
    bodyChars:articleBodyTextChars(node.article!),truncated:node.article!.truncated,paragraphs:node.article!.blocks.filter(block=>block.type==='paragraph').length})),
  pending:graph.nodes.filter(node=>node.kind==='concept').map(node=>({title:node.title,state:node.reading?.state,reason:node.reading?.reason})),
  danglingEdges:graph.edges.filter(edge=>!ids.has(edge.from)||!ids.has(edge.to)||edge.evidence.some(item=>!ids.has(item.sourceId))).length,
  hasProgressiveSnapshots:events.some(event=>event.readable===1)&&events.some(event=>event.readable>1),warnings:graph.warnings,
  snapshotWasCloned:finalSnapshot!==graph};
const output=new URL(`../docs/dynamic-${release}-${live?'live':'fixtures'}.json`,import.meta.url);
const passed=report.sources.length>=3&&report.danglingEdges===0&&report.hasProgressiveSnapshots&&report.finishRequested;
await writeFile(output,JSON.stringify({...report,passed},null,2));
console.log(JSON.stringify({output:output.pathname,firstReadableMs:report.firstReadableMs,elapsedMs:report.elapsedMs,
  stopReason:report.stopReason,sources:report.sources,danglingEdges:report.danglingEdges,hasProgressiveSnapshots:report.hasProgressiveSnapshots},null,2));
if(!passed)throw new Error(`Dynamic verification incomplete: ${report.warnings.join('；')||'sources or snapshots missing'}`);
