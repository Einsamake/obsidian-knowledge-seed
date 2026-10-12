import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DOMParser } from 'linkedom';
import { extractWebDocument, publicUrl } from '../src/web';
import { articlePlainText, renderArticleContent } from '../src/article';
import { exportGraph } from '../src/export';
import { nodeId, type KnowledgeGraph } from '../src/graph';

Object.assign(globalThis, { DOMParser });
const live = process.argv.includes('--live');
const output = resolve(`demo-vault/reading-0.5/${live ? 'live' : 'fixtures'}`);
const report: unknown[] = [];
await mkdir(output, { recursive: true });
for (const [name, url] of [
  ['neuroscience', 'https://en.wikipedia.org/wiki/Neuroscience'],
  ['google-knowledge-graph', 'https://en.wikipedia.org/wiki/Knowledge_Graph_(Google)'],
] as const) {
  let html: string, retrievedAt: string;
  if (live) {
    const response = await fetch(publicUrl(url), { redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'KnowledgeSeed/0.5.0 (local reading quality verification)' } });
    if (!response.ok) throw new Error(`Real request ${url}: HTTP ${response.status}`);
    html = await response.text(); retrievedAt = new Date().toISOString();
  } else {
    html = await readFile(resolve(`tests/fixtures/wikipedia-${name}.html`), 'utf8');
    retrievedAt = '2026-10-05 (previously retrieved HTML fixture; not a new network request)';
  }
  const doc = extractWebDocument(html, url, 48000);
  const sourceId = nodeId('web', doc.url), seedId = nodeId('seed', 'reading:' + doc.url);
  const graph: KnowledgeGraph = { version: 1, seed: doc.title, createdAt: doc.retrievedAt,
    nodes: [{ id: seedId, kind: 'seed', title: doc.title, excerpt: '阅读核查', status: 'derived', depth: 0 },
      { id: sourceId, kind: 'web', title: doc.title, locator: doc.url, sourceTitle: doc.sourceTitle,
        excerpt: doc.text.slice(0, 900), article: doc.article, status: 'retrieved', depth: 1, retrievedAt: doc.retrievedAt, truncated: doc.truncated }],
    edges: [{ id: 'reading-source', from: seedId, to: sourceId, relation: 'seed_source', evidence: [{ sourceId, quote: doc.title, method: '真实网页正文读取' }] }],
    warnings: [], stats: { pagesAttempted: 1, requests: live ? 1 : 0, notesScanned: 0 } };
  const bundle = exportGraph(graph, 'Reading', name);
  const markdown = bundle.files.find(file => file.path === bundle.nodePaths[sourceId])!.content;
  await writeFile(resolve(output, `${name}.md`), markdown);
  await writeFile(resolve(output, `${name}.graph.json`), JSON.stringify(graph, null, 2));
  report.push({ name, url, input: live ? 'fresh public HTML request' : 'previous real HTML fixture', retrievedAt,
    title: doc.title, oldSavedExcerptChars: Math.min(900, doc.text.length), savedBodyChars: doc.article.textChars,
    totalExtractableChars: doc.article.totalTextChars, truncated: doc.article.truncated,
    headings: doc.headings.length, blocks: doc.article.blocks.length,
    blockTypes: Object.fromEntries(['heading', 'paragraph', 'list', 'table', 'quote', 'code'].map(type => [type, doc.article.blocks.filter(block => block.type === type).length])),
    bodyAgreesWithAnalysis: articlePlainText(doc.article) === doc.text, qualifiedExpansionLinks: doc.links.length,
    guide: markdown.includes('## 导读'), outline: markdown.includes('## 目录'), sourceBodyBeyond900: doc.text.length > 900 && markdown.includes(renderArticleContent(doc.article)),
    nativeWikiTargets: [...markdown.matchAll(/(?<!\\)\[\[([^\]\n]+)\]\]/g)].map(match => match[1]),
    samplePath: `demo-vault/reading-0.5/${live ? 'live' : 'fixtures'}/${name}.md` });
}
const reportPath = resolve(`docs/reading-quality-0.5${live ? '-live' : '-fixtures'}.json`);
await writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), live, results: report }, null, 2));
console.log(JSON.stringify({ reportPath, report }, null, 2));
