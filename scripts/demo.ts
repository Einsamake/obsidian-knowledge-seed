import { DOMParser } from 'linkedom';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { clampOptions, generateGraph, type EngineAdapter, type Seed } from '../src/engine';
import { exportGraph, saveBundle } from '../src/export';
import { publicUrl } from '../src/web';
Object.assign(globalThis, { DOMParser });
const demoVersion = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')).version;

const live = process.argv.includes('--live');
const canvas = process.argv.includes('--canvas');
// Validate before creating files or making network requests.
const values = new Map<string, string[]>();
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--live' || argument === '--canvas') continue;
  const equals = argument.indexOf('=');
  const flag = equals >= 0 ? argument.slice(0, equals) : argument;
  if (!['--seed', '--depth', '--mode', '--pages', '--terms'].includes(flag)) throw new Error(`未知演示参数：${flag}`);
  const value = equals >= 0 ? argument.slice(equals + 1) : process.argv[++index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个值。`);
  values.set(flag, [...(values.get(flag) ?? []), value]);
}
const lastValue = (flag: string, fallback: string) => values.get(flag)?.at(-1) ?? fallback;
const count = (flag: string, fallback: number, max: number) => {
  const value = lastValue(flag, String(fallback));
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`${flag} 必须为 0–${max} 的整数。`);
  return Number(value);
};
const mode = lastValue('--mode', 'balanced');
if (mode !== 'strict' && mode !== 'balanced' && mode !== 'broad') throw new Error('--mode 必须为 strict、balanced 或 broad。');
const seedValue = lastValue('--seed', '知识图谱').trim();
if (!seedValue) throw new Error('--seed 不能为空。');
const seed: Seed = { kind: /^https?:\/\//i.test(seedValue) ? 'url' : 'topic', value: seedValue };
const options = clampOptions({
  maxPages: count('--pages', live ? 3 : 1, 500), maxNotes: 3, maxConcepts: 10,
  depth: count('--depth', 0, 20), relevance: mode,
  searchTerms: [...new Set((values.get('--terms') ?? []).flatMap(value => value.split(/[,，;；\n]/)).map(value => value.trim()).filter(Boolean))].slice(0, 20)
});
const vault = resolve('demo-vault');
const notes: Record<string, string> = {
  '示例笔记/知识图谱.md': '# 知识图谱\n\n这是用于演示检索的本地示例笔记，不是文献结论。阅读知识图谱资料时，我会先关注[[来源核验]]和[[语义网络]]，再考虑如何表示实体关系。',
  '示例笔记/来源核验.md': '# 来源核验\n\n示例笔记：知识图谱中的每个候选关系都要留下来源和检索时间。这是一个待人工检查的工作记录。[[知识图谱]]',
  '示例笔记/语义网络.md': '# 语义网络\n\n示例笔记：将知识图谱和语义网络作为两个检索词进行比较，关系需要阅读来源后确认。[[知识图谱]]'
};
const fixture = '<html><head><title>知识图谱：离线演示材料</title></head><body><article><h1>知识图谱：离线演示材料</h1><p>这是人工编写的离线演示材料，不能作为真实文献或联网研究结果使用。知识图谱的演示包含来源、检索词和原文提及三个部分，用于展示插件如何生成可以人工核查的图谱。阅读这段材料时，应当将它与真实网页的内容明确区分。</p><p>演示将<a href="https://example.org/evidence">来源核验</a>作为正文链接，并讨论如何保存周围文字作为原文证据。此链接地址只是测试占位符，不代表真实可用的外部资料。</p></article></body></html>';
const adapter: EngineAdapter = {
  listNotes: () => Object.keys(notes).map(path => ({ path, title: path.split('/').pop()!.replace(/\.md$/, '') })),
  readNote: async path => notes[path],
  resolveLink: link => Object.keys(notes).find(path => path.endsWith(`/${link}.md`)) ?? null,
  request: async url => {
    if (!live) return url.includes('/w/api.php?') ? { status: 200, text: JSON.stringify({ query: { search: [{ title: '知识图谱' }] } }), headers: { 'content-type': 'application/json' } } : { status: 200, text: fixture, headers: { 'content-type': 'text/html' } };
    const response = await fetch(publicUrl(url), { signal: AbortSignal.timeout(20000), redirect: 'manual', headers: { 'User-Agent': `KnowledgeSeed/${demoVersion} (local Obsidian native graph demo)` } });
    return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers.entries()) };
  }
};
await mkdir(vault, { recursive: true });
for (const [path, text] of Object.entries(notes)) {
  const target = resolve(vault, path);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, text, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Preserve edits to existing demo notes and analyze the actual saved content.
  notes[path] = await readFile(target, 'utf8');
}
const graph = await generateGraph(seed, adapter, options, undefined, message => console.log(message));
if (live && !graph.nodes.some(n => n.kind === 'web')) throw new Error('联网演示未取得真实网页，不生成声称联网成功的结果。');
const runId = `${live ? 'live' : 'offline-fixture'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Each demonstration is isolated. Repeated runs need no overwrite or ownership update.
const bundle = exportGraph(graph, `Knowledge Seed Demo/${runId}`, runId, { canvas });
await saveBundle(bundle, {
  exists: async path => { try { await access(resolve(vault, path)); return true; } catch { return false; } },
  mkdir: async path => { await mkdir(resolve(vault, path)); },
  create: async (path, text) => { await writeFile(resolve(vault, path), text, { flag: 'wx' }); }
});
await writeFile(resolve(vault, 'last-run.json'), JSON.stringify({ live, simulated: !live, seed, options, folder: bundle.folder,
  rootPath: bundle.rootPath, nodePaths: bundle.nodePaths, search: bundle.search, ...(bundle.canvasPath ? { canvasPath: bundle.canvasPath } : {}), graph }, null, 2));
console.log(JSON.stringify({ live, seed, options, folder: bundle.folder, rootPath: bundle.rootPath, nodes: graph.nodes.length,
  edges: graph.edges.length, warnings: graph.warnings }, null, 2));
