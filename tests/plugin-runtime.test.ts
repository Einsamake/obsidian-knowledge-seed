import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DOMParser } from 'linkedom';
import { exportGraph, nativeSearch } from '../src/export';
import { nodeId, stableId, type GraphNode, type KnowledgeGraph } from '../src/graph';
import { defaultPreviewSelection, readablePreviewSelection, previewSelectionSummary } from '../src/preview';
import { mergeManagedLinks } from '../src/export';
import { visibleLiveGraph, type LiveMapRecord } from '../src/live-map';

// Runs the shipped bundle through an in-memory public API shim. It checks
// wiring and I/O; actual Obsidian Graph rendering still needs visual validation.
function loadPlugin(options: { openFails?: boolean; writeFails?: boolean; saveFails?: boolean; metadataLag?: boolean; nativeLinkRanges?: boolean; missingCachePaths?: string[]; extraFiles?: Record<string, string>; data?: Record<string, unknown>;
  ignoreNativeStatePinned?:boolean;
  normalizeNativeGraphState?: (state:any)=>any;
  onCreate?: (path:string,files:Map<string,string>)=>void; onProcess?: (path:string,files:Map<string,string>)=>void;
  onRead?: (path:string,files:Map<string,string>)=>void;
  onSave?: (data:any)=>Promise<void>;
  request?: (url:string)=>Promise<{status:number;text:string;headers:Record<string,string>}> } = {}) {
  const notices: string[] = [], processed: string[] = [], created: string[] = [], saves: any[] = [], trashed: Array<{path:string;system?:boolean;retained?:string}> = [];
  const events = new Map<string, Set<(...args: any[]) => unknown>>();
  const metadataEvents = new Map<string, Set<(...args: any[]) => unknown>>();
  const reads: string[] = [], saveStarted: any[] = [];
  const statusItems: HTMLElement[] = [];
  const views = new Map<string, (leaf:unknown)=>unknown>();
  const viewStates: Array<{leaf:ShimLeaf;state:any}> = [];
  let activePath = '知识图谱.md';
  const setActiveFile = (path: string) => { activePath = path; };
  const emit = async (event: string, ...args: any[]) => {
    if (event === 'file-open' && args[0]?.path) {
      activePath = args[0].path;
      // Core local graphs follow the opened note until setPinned really pins
      // their leaf. A `pinned` field in setViewState is not a pin operation.
      if(options.ignoreNativeStatePinned)for(const leaf of leaves)
        if(leaf.state?.type==='localgraph'&&leaf.pinned!==true)leaf.state.state.file=activePath;
    }
    for (const callback of events.get(event) ?? []) await callback(...args);
  };
  const emitMetadata = async (event:string,...args:any[]) => {
    for (const callback of metadataEvents.get(event) ?? []) await callback(...args);
  };
  const files = new Map<string, string>([
    ['知识图谱.md', '# 知识图谱\n\n本地演示笔记。[[来源核验]]'],
    ['来源核验.md', '知识图谱中的来源核验示例。'], ...Object.entries(options.extraFiles ?? {}),
  ]);
  const folders = new Set<string>();
  interface ShimLeaf {
    kind: string; file?: string; pinned?: boolean; state?: any; attached: boolean;
    openFile(file: TFile): Promise<void>; setPinned(value: boolean): void;
    loadIfDeferred():Promise<void>;
    setViewState(state: any): Promise<void>; getViewState(): any;
  }
  const leaves: ShimLeaf[] = [];
  const loadedLeaves:ShimLeaf[] = [],revealedLeaves:ShimLeaf[] = [];
  class TFile {
    extension: string; basename: string;
    constructor(public path: string) { this.basename = path.split('/').pop()!.replace(/\.md$/, ''); this.extension = path.split('.').pop()!; }
  }
  function frontmatter(path: string): Record<string, any> | undefined {
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(files.get(path) ?? '');
    if (!header) return undefined;
    const result: Record<string, any> = {};
    for (const line of header[1].split(/\r?\n/)) {
      const item = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (!item) continue;
      try { result[item[1]] = JSON.parse(item[2]); } catch { result[item[1]] = item[2]; }
    }
    return result;
  }
  class Plugin {
    commands: Array<Record<string, any>> = [];
    constructor(public app: any) {}
    async loadData() { return saves.at(-1) ?? options.data ?? { web: false, liveGraph:false }; }
    async saveData(data: any) {
      if(options.saveFails) throw new Error('settings disk failure');
      saveStarted.push(JSON.parse(JSON.stringify(data))); await options.onSave?.(data);
      saves.push(JSON.parse(JSON.stringify(data)));
    }
    addCommand(command: any) { this.commands.push(command); }
    addSettingTab(_tab: any) {}
    registerView(type:string, factory:(leaf:unknown)=>unknown) {views.set(type,factory);}
    addRibbonIcon() {}
    registerEvent() {}
    addStatusBarItem() {
      const document = new DOMParser().parseFromString('<html><body></body></html>', 'text/html') as unknown as Document;
      const item = document.createElement('div') as HTMLElement & {setText(value:string):void};
      item.setText = value => { item.textContent = typeof value === 'string' ? value : value.textContent ?? ''; };
      statusItems.push(item); return item;
    }
  }
  class Empty {}
  class ItemView { constructor(public leaf:unknown) {} }
  const api = { Plugin, Modal: Empty, ItemView, FuzzySuggestModal: Empty, PluginSettingTab: Empty, Setting: Empty, App: Empty, TFile,
    normalizePath: (path: string) => path.replaceAll('\\', '/'),
    Notice: class { constructor(message: string) { notices.push(message); } },
    requestUrl: async ({url}:{url:string}) => { if(options.request)return options.request(url); throw new Error('unexpected network'); } };
  const module: { exports: any } = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), {
    module, exports: module.exports, require: (id: string) => { assert.equal(id, 'obsidian'); return api; },
    console, TextEncoder, URL, URLSearchParams, AbortController, DOMException, DOMParser, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: 'main.js' });
  function addLeaf(kind: string, state?: any): ShimLeaf {
    const leaf: ShimLeaf = {
      kind, state, file: state?.type === 'markdown' ? state.state?.file : undefined, pinned: state?.pinned, attached: true,
      openFile: async (file: TFile) => {
        if (options.openFails) throw new Error('UI unavailable');
        leaf.file = file.path; leaf.state = { type: 'markdown', state: { file: file.path } };
      },
      setPinned: (pinned: boolean) => { leaf.pinned = pinned; },
      loadIfDeferred:async()=>{loadedLeaves.push(leaf);},
      setViewState: async (state: any) => {
        if (options.openFails) throw new Error('UI unavailable');
        viewStates.push({leaf,state:JSON.parse(JSON.stringify(state))});
        const actual=JSON.parse(JSON.stringify(state));
        if(options.ignoreNativeStatePinned)delete actual.pinned;
        leaf.state = state.type==='localgraph'&&options.normalizeNativeGraphState?options.normalizeNativeGraphState(actual):actual;
        if (!options.ignoreNativeStatePinned && typeof state.pinned === 'boolean') leaf.pinned = state.pinned;
      },
      getViewState: () => JSON.parse(JSON.stringify({ ...(leaf.state ?? { type: 'empty' }),
        ...(!options.ignoreNativeStatePinned||leaf.pinned===true?{pinned:leaf.pinned}:{}) })),
    };
    leaves.push(leaf); return leaf;
  }
  let rightLeaf: ShimLeaf | undefined;
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: { exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => {
        if (!files.has(path)) throw new Error(`Missing file: ${path}`);
        return files.get(path)!;
      } },
      getMarkdownFiles: () => [...files.keys()].filter(path => path.endsWith('.md')).map(path => new TFile(path)),
      getFiles: () => [...files.keys()].map(path => new TFile(path)),
      getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : null,
      cachedRead: async (file: TFile) => { reads.push(file.path); options.onRead?.(file.path,files); return files.get(file.path); },
      read: async (file: TFile) => { reads.push(file.path); options.onRead?.(file.path,files); return files.get(file.path); },
      createFolder: async (path: string) => { assert.ok(!folders.has(path)); folders.add(path); },
      create: async (path: string, content: string) => {
        options.onCreate?.(path,files);
        if (options.writeFails && path.startsWith('Knowledge Seed/') && path.endsWith('.md')) throw new Error('disk full');
        assert.ok(!files.has(path), `create overwrote ${path}`);
        files.set(path, content); created.push(path); return new TFile(path);
      },
      process: async (file: TFile, transform: (content: string) => string) => {
        options.onProcess?.(file.path,files);
        assert.ok(files.has(file.path)); files.set(file.path, transform(files.get(file.path)!)); processed.push(file.path);
      },
      modify: async (file: TFile, content: string) => { assert.ok(files.has(file.path)); files.set(file.path, content); },
      trash: async (file: TFile, system: boolean) => { assert.ok(files.has(file.path)); files.delete(file.path); trashed.push({path:file.path,system}); },
      rename: async (file: TFile, retained: string) => {
        assert.ok(files.has(file.path)); assert.ok(!files.has(retained));
        const path = file.path; files.set(retained,files.get(path)!); files.delete(path); file.path = retained;
        trashed.push({path,retained});
      },
    },
    fileManager: { generateMarkdownLink: (file: TFile, _from: string, subpath = '', alias?: string) =>
      `[[${file.path.replace(/\.md$/, '')}${subpath}${alias ? `|${alias}` : ''}]]`,
      renameFile: async (file: TFile, to: string) => {
      const from = file.path;
      assert.ok(files.has(from)); assert.ok(!files.has(to));
      const content = files.get(from)!; files.delete(from); files.set(to, content);
      for (const [path, body] of files) files.set(path, body.replaceAll(`[[${from.slice(0, -3)}|`, `[[${to.slice(0, -3)}|`).replaceAll(`[[${from.slice(0, -3)}]]`, `[[${to.slice(0, -3)}]]`));
      for (const leaf of leaves) if (leaf.state?.state?.file === from) { leaf.state.state.file = to; leaf.file = to; }
    } },
    workspace: { getActiveFile: () => files.has(activePath) ? new TFile(activePath) : null,
      on: (event: string, callback: (...args: any[]) => unknown) => {
        const callbacks = events.get(event) ?? new Set(); callbacks.add(callback); events.set(event, callbacks);
        return { event, callback };
      }, getLeaf: addLeaf, getRightLeaf: () => rightLeaf ??= addLeaf('right'),
      getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.attached && leaf.state?.type === type),
      revealLeaf:async(leaf:ShimLeaf)=>{revealedLeaves.push(leaf);},
    },
    metadataCache: {
      on:(event:string,callback:(...args:any[])=>unknown)=>{
        const callbacks=metadataEvents.get(event)??new Set();callbacks.add(callback);metadataEvents.set(event,callbacks);
        return {event,callback};
      },
      getFileCache: (file: TFile) => {
        if (options.metadataLag || options.missingCachePaths?.includes(file.path)) return null;
        const content = files.get(file.path) ?? '';
        // New migration cases emulate native indexing: code is not a vault link.
        // Existing discovery fixtures retain their previous shim behavior.
        const codeRanges = options.nativeLinkRanges ? [
          ...content.matchAll(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm),
          ...content.matchAll(/`[^`\n]+`/g),
        ].map(match => ({start:match.index!,end:match.index!+match[0].length})) : [];
        const links = [...content.matchAll(options.nativeLinkRanges ? /(?<!\\)!?\[\[([^\]\n]+)\]\]/g : /(?<!\\)\[\[([^\]\n]+)\]\]/g)]
          .filter(match => !codeRanges.some(range => match.index! >= range.start && match.index! < range.end))
          .map(match => ({link:match[1].split('|')[0],displayText:match[1].split('|')[1],original:match[0],
            position:{start:{offset:match.index!},end:{offset:match.index!+match[0].length}}}));
        return {frontmatter:frontmatter(file.path),links};
      },
      getFirstLinkpathDest: (link: string) => {
        const path = [...files.keys()].find(path => path.replace(/\.md$/, '') === link
          || path.split('/').pop()!.replace(/\.md$/, '') === link || frontmatter(path)?.title === link);
        return path ? new TFile(path) : null;
      },
    },
  };
  const createPlugin = () => new module.exports.default(app);
  return { plugin: createPlugin(), createPlugin, addLeaf, files, folders, notices, leaves, saves, processed, created, trashed, frontmatter, emit, emitMetadata, setActiveFile, statusItems, reads, saveStarted, views, viewStates,loadedLeaves,revealedLeaves };
}
const ownedPaths = (fixture: ReturnType<typeof loadPlugin>) => [...fixture.files.keys()].filter(path => path.endsWith('.md') && fixture.frontmatter(path)?.knowledge_seed_id).sort();

test('built plugin registers eleven commands and defaults to real notes plus native local Graph', async () => {
  const fixture = loadPlugin(); const { plugin, files, leaves } = fixture; await plugin.onload();
  assert.equal(plugin.commands.length, 11);
  assert.ok(fixture.views.has('knowledge-seed-live-map'));
  assert.ok(plugin.commands.some((command: any) => command.id === 'open-native-graph'));
  const original = new Map(files);
  const graph = await plugin.discover({ kind: 'note', value: '知识图谱.md' }, () => {});
  assert.equal(files.size, original.size);
  assert.ok(graph.nodes.some((node: any) => node.locator === '来源核验.md'));
  const folder = await plugin.persist(graph);
  assert.ok(files.has(folder + '/COMPLETE.json'));
  assert.ok(![...files.keys()].some(path => path.endsWith('.canvas')));
  for (const [path, content] of original) assert.equal(files.get(path), content);
  assert.ok(files.has(plugin.lastRun.rootPath));
  const markdown = [...files.values()].join('\n');
  assert.ok(markdown.includes('[[来源核验') && markdown.includes('[[知识图谱'));
  assert.ok(leaves.some(leaf => leaf.kind === 'tab' && leaf.file === plugin.lastRun.rootPath));
  const graphLeaf = leaves.find(leaf => leaf.state?.type === 'localgraph')!;
  assert.ok(graphLeaf); assert.equal(graphLeaf.pinned, true);
  assert.equal(graphLeaf.state.state.file, plugin.lastRun.rootPath);
  assert.equal(graphLeaf.state.state.options.search, plugin.lastRun.search);
  assert.equal(graphLeaf.state.state.options.localInterlinks, true);
  assert.ok(graphLeaf.state.state.options.search.length > 0);
  assert.equal(fixture.saves.at(-1).lastRun.rootPath, plugin.lastRun.rootPath);
  assert.equal(plugin.busy, false);
});

test('native Graph command reopens the saved root without generating files', async () => {
  const fixture = loadPlugin(); const { plugin, files, leaves } = fixture; await plugin.onload();
  const graph = await plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {}); await plugin.persist(graph);
  const before = new Map(files), count = leaves.length;
  await plugin.commands.find((command: any) => command.id === 'open-native-graph').callback();
  assert.equal(files.size, before.size); assert.equal(leaves.length, count);
  assert.equal(leaves.at(-1)?.state?.type, 'localgraph');
  for (const [path, content] of before) assert.equal(files.get(path), content);
});

test('repeated and overlapping native opens reuse one pair across different runs', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const first = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await fixture.plugin.persist(first);
  const pair = [...fixture.leaves], firstPath = fixture.plugin.lastRun.rootPath;
  await Promise.all(Array.from({ length: 4 }, () => fixture.plugin.openNativeGraph(fixture.plugin.lastRun)));
  await fixture.plugin.persist(first);
  const second = await fixture.plugin.discover({ kind: 'topic', value: '来源核验' }, () => {});
  await fixture.plugin.persist(second);
  assert.equal(fixture.leaves.length, 2);
  assert.deepEqual(fixture.leaves, pair);
  assert.notEqual(fixture.plugin.lastRun.rootPath, firstPath);
  assert.equal(pair[0].state.state.file, fixture.plugin.lastRun.rootPath);
  assert.equal(pair[1].state.state.file, fixture.plugin.lastRun.rootPath);
  assert.equal(pair[1].state.state.options.search, fixture.plugin.lastRun.search);
});

test('detached native leaves are replaced while attached owned leaves stay reusable', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await fixture.plugin.persist(graph);
  const root = fixture.leaves[0], oldGraph = fixture.leaves[1], oldState = JSON.stringify(oldGraph.state);
  oldGraph.attached = false;
  await fixture.plugin.openNativeGraph(fixture.plugin.lastRun);
  assert.equal(fixture.leaves.length, 3);
  assert.equal(JSON.stringify(oldGraph.state), oldState);
  assert.equal(fixture.leaves[0], root);
  assert.equal(fixture.leaves.filter(leaf => leaf.attached).length, 2);
  root.attached = false; fixture.leaves[2].attached = false;
  await fixture.plugin.openNativeGraph(fixture.plugin.lastRun);
  assert.equal(fixture.leaves.length, 5);
  assert.equal(fixture.leaves.filter(leaf => leaf.attached).length, 2);
});

test('reload restores only the saved pinned graph and its matching Markdown leaf', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await fixture.plugin.persist(graph);
  const root = fixture.leaves[0], ownedGraph = fixture.leaves[1];
  const unrelated = fixture.addLeaf('split', { type: 'localgraph', pinned: true, state: { file: '来源核验.md', options: { search: 'manual filter' } } });
  const manualRoot = fixture.addLeaf('tab', { type: 'markdown', state: { file: '知识图谱.md' } });
  const unrelatedState = JSON.stringify(unrelated.state), manualState = JSON.stringify(manualRoot.state);
  const reloaded = fixture.createPlugin(); await reloaded.onload();
  await reloaded.commands.find((command: any) => command.id === 'open-native-graph').callback();
  assert.equal(fixture.leaves.length, 4);
  assert.equal(root.state.state.file, reloaded.lastRun.rootPath);
  assert.equal(ownedGraph.state.state.file, reloaded.lastRun.rootPath);
  assert.equal(JSON.stringify(unrelated.state), unrelatedState);
  assert.equal(JSON.stringify(manualRoot.state), manualState);
});

test('a previously owned root navigated to another file is left untouched', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await fixture.plugin.persist(graph);
  const root = fixture.leaves[0], ownedGraph = fixture.leaves[1];
  await root.setViewState({ type: 'markdown', state: { file: '来源核验.md' } });
  const manualState = JSON.stringify(root.state);
  await fixture.plugin.openNativeGraph(fixture.plugin.lastRun);
  assert.equal(fixture.leaves.length, 3);
  assert.equal(JSON.stringify(root.state), manualState);
  assert.equal(fixture.leaves[1], ownedGraph);
  assert.equal(fixture.leaves[2].state.state.file, fixture.plugin.lastRun.rootPath);
});

test('repeat persist reuses managed paths and preserves human edits through vault.process', async () => {
  const fixture = loadPlugin(); const { plugin, files, processed } = fixture; await plugin.onload();
  const graph = await plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  const first = await plugin.persist(graph), root = plugin.lastRun.rootPath, paths = ownedPaths(fixture);
  files.set(root, files.get(root)! + '\n## 人工补充\n这段内容必须保留。\n');
  const second = await plugin.persist(graph);
  assert.notEqual(second, first); assert.equal(plugin.lastRun.rootPath, root);
  assert.deepEqual(ownedPaths(fixture), paths); assert.ok(processed.includes(root));
  assert.ok(files.get(root)!.includes('这段内容必须保留。'));
  assert.ok(files.has(first + '/COMPLETE.json') && files.has(second + '/COMPLETE.json'));
  assert.equal(files.get('知识图谱.md'), '# 知识图谱\n\n本地演示笔记。[[来源核验]]');
});

test('generated seed restores its title and continues explicit previous-source links', async () => {
  const path = 'Knowledge Seed/概念/知识图谱-concept-hash.md', old = 'Knowledge Seed/网页/已有来源.md';
  const fixture = loadPlugin({ extraFiles: {
    [path]: '---\ntitle: "知识图谱"\nknowledge_seed_id: "concept-old"\n---\n\n参考 [[Knowledge Seed/网页/已有来源]]。',
    [old]: '---\ntitle: "已有来源"\nknowledge_seed_id: "web-old"\n---\n\n这是真实的已有来源。',
  } });
  await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'note', value: path }, () => {});
  assert.equal(graph.nodes[0].title, '知识图谱');
  const seed = graph.nodes.find((node: any) => node.locator === path)!;
  const source = graph.nodes.find((node: any) => node.locator === old)!;
  assert.equal(seed.managedId, 'concept-old'); assert.equal(source.managedId, 'web-old');
  assert.ok(graph.edges.some((edge: any) => edge.relation === 'wiki_link' && edge.from === seed.id && edge.to === source.id));
  const folder = await fixture.plugin.persist(graph);
  assert.ok(fixture.files.has(folder + '/COMPLETE.json'));
  assert.ok(fixture.files.has(path) && fixture.files.has(old));
});

test('same sanitized titles never overwrite user files or differently identified nodes', async () => {
  const collision = 'Knowledge Seed/起点/知识-图谱.md';
  const fixture = loadPlugin({ extraFiles: { [collision]: '这是用户已有文件，禁止覆盖。' } }); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  graph.nodes[0].title = '知识/图谱'; await fixture.plugin.persist(graph);
  const firstPath = fixture.plugin.lastRun.rootPath, second = JSON.parse(JSON.stringify(graph)), oldId = second.nodes[0].id;
  second.nodes[0].id = oldId + '-different'; second.nodes[0].title = '知识:图谱';
  for (const edge of second.edges) {
    if (edge.from === oldId) edge.from = second.nodes[0].id;
    if (edge.to === oldId) edge.to = second.nodes[0].id;
    for (const evidence of edge.evidence) if (evidence.sourceId === oldId) evidence.sourceId = second.nodes[0].id;
  }
  await fixture.plugin.persist(second);
  assert.equal(fixture.files.get(collision), '这是用户已有文件，禁止覆盖。');
  assert.notEqual(fixture.plugin.lastRun.rootPath, firstPath);
  assert.ok(fixture.files.has(firstPath) && fixture.files.has(fixture.plugin.lastRun.rootPath));
});

test('optional Canvas supplements native Graph rather than changing its default behavior', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload(); fixture.plugin.settings.exportCanvas = true;
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  const folder = await fixture.plugin.persist(graph);
  assert.ok(fixture.files.has(folder + '/knowledge-map.canvas'));
  assert.ok(fixture.leaves.some(leaf => leaf.state?.type === 'localgraph'));
});

test('saved files remain complete if opening native Graph fails', async () => {
  const { plugin, files, notices } = loadPlugin({ openFails: true }); await plugin.onload();
  const graph = await plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {}), folder = await plugin.persist(graph);
  assert.ok(files.has(folder + '/COMPLETE.json'));
  assert.ok(notices.some(message => message.includes('已保存') && message.includes('自动打开')));
  assert.equal(plugin.busy, false);
});

test('generated Markdown write failure leaves no completion marker and releases busy', async () => {
  const { plugin, files } = loadPlugin({ writeFails: true }); await plugin.onload();
  const graph = await plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await assert.rejects(plugin.persist(graph), /保存未完成/);
  assert.ok([...files.keys()].some(path => path.endsWith('/run-status.json')));
  assert.ok(![...files.keys()].some(path => path.endsWith('/COMPLETE.json')));
  assert.equal(plugin.busy, false);
});

test('invalid output path does not leave the plugin busy', async () => {
  const { plugin } = loadPlugin(); await plugin.onload();
  const graph = await plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {}); plugin.settings.outputFolder = '../outside';
  await assert.rejects(plugin.persist(graph), /输出目录/); assert.equal(plugin.busy, false);
});

test('delayed native metadata indexing does not duplicate generated nodes', async () => {
 const fixture=loadPlugin({metadataLag:true}); await fixture.plugin.onload();
 const graph=await fixture.plugin.discover({kind:'topic',value:'知识图谱'},()=>{});
 await fixture.plugin.persist(graph); const root=fixture.plugin.lastRun.rootPath, paths=ownedPaths(fixture);
 await fixture.plugin.persist(graph); assert.equal(fixture.plugin.lastRun.rootPath,root); assert.deepEqual(ownedPaths(fixture),paths);
 const next=await fixture.plugin.discover({kind:'note',value:root},()=>{}); assert.equal(next.nodes[0].title,'知识图谱');
});
test('settings persistence failure after COMPLETE does not report partial output', async () => {
 const fixture=loadPlugin({saveFails:true}); await fixture.plugin.onload();
 const graph=await fixture.plugin.discover({kind:'topic',value:'知识图谱'},()=>{});
 const folder=await fixture.plugin.persist(graph); assert.ok(fixture.files.has(folder+'/COMPLETE.json'));
 assert.ok(fixture.notices.some(n=>n.includes('已完整保存'))); assert.equal(fixture.plugin.busy,false);
});

test('per-run range and native display depth do not overwrite global defaults', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {}, { depth: 6, graphDepth: 7, maxPages: 90, maxNotes: 100 });
  assert.equal(fixture.plugin.settings.depth, 1); assert.equal(fixture.plugin.settings.graphDepth, 3);
  await fixture.plugin.persist(graph);
  assert.equal(fixture.plugin.lastRun.graphDepth, 5);
  assert.equal(fixture.leaves.at(-1)!.state.state.options.localJumps, 5);
  assert.equal(fixture.plugin.history[0].request.options.graphDepth,5);
  assert.equal(fixture.plugin.history[0].request.options.depth,6);
  assert.equal(fixture.plugin.history[0].request.options.outputFolder,undefined);
  assert.equal(fixture.plugin.history[0].request.options.generatedFolder,undefined);
});

test('generated filename collisions use readable numbers instead of hashes', async () => {
  const occupied = 'Knowledge Seed/起点/知识图谱.md';
  const fixture = loadPlugin({ extraFiles: { [occupied]: '# 用户手写，不可覆盖' } }); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({ kind: 'topic', value: '知识图谱' }, () => {});
  await fixture.plugin.persist(graph);
  assert.equal(fixture.plugin.lastRun.rootPath, 'Knowledge Seed/起点/知识图谱 (2).md');
  assert.equal(fixture.files.get(occupied), '# 用户手写，不可覆盖');
});

test('old generated name cleanup preserves text, core links, latest graph and immutable history', async () => {
  const oldPath = 'Knowledge Seed/网页/脑科学 - 维基百科-web-1234567812345678.md';
  const body = '---\nknowledge_seed_id: "web-1234567812345678"\ntitle: "脑科学 - 维基百科"\n---\n\n# 人工编辑保留\n正文';
  const fixture = loadPlugin({ extraFiles: { [oldPath]: body, '手工节点-2c6b95a5.md': '# 没有标识', '.obsidian/app.json': '{"alwaysUpdateLinks":true}' } });
  await fixture.plugin.onload();
  fixture.files.set('Knowledge Seed/Runs/old/native.json', JSON.stringify({ nodePaths: { web: oldPath }, rootPath: oldPath }));
  fixture.plugin.lastRun = { rootPath: oldPath, folder: 'Knowledge Seed/Runs/old', search: 'old', nodePaths: { web: oldPath }, graphDepth: 4 };
  fixture.plugin.history = [{run:fixture.plugin.lastRun, title:'脑科学', createdAt:'2026-10-05T00:00:00Z', nodes:1, relations:0,
    request:{seed:{kind:'note',value:oldPath},options:{...fixture.plugin.settings}}}];
  await fixture.plugin.openNativeGraph(fixture.plugin.lastRun);
  fixture.files.set('引用.md', `[[${oldPath.slice(0, -3)}|脑科学]]`);
  const history = fixture.files.get('Knowledge Seed/Runs/old/native.json');
  const changes = await fixture.plugin.nameCleanupPlan(); assert.equal(changes.length, 1);
  await fixture.plugin.applyNameCleanup(changes);
  const target = 'Knowledge Seed/网页/脑科学.md';
  assert.equal(fixture.files.get(target), body); assert.equal(fixture.files.has(oldPath), false);
  assert.equal(fixture.files.get('引用.md'), '[[Knowledge Seed/网页/脑科学|脑科学]]');
  assert.equal(fixture.files.get('Knowledge Seed/Runs/old/native.json'), history);
  assert.equal(fixture.plugin.lastRun.rootPath, target); assert.equal(fixture.plugin.lastRun.nodePaths.web, target);
  assert.equal(fixture.plugin.history[0].run.rootPath,target);
  assert.equal(fixture.plugin.history[0].request.seed.value,target);
  assert.equal(fixture.leaves.length, 2); assert.equal(fixture.leaves[1].state.state.file, target);
  assert.equal(fixture.files.get('手工节点-2c6b95a5.md'), '# 没有标识');
  assert.equal(fixture.plugin.busy, false);
});

test('cleanup refuses disabled core link updates or changed ownership before any rename', async () => {
  const oldPath = 'Knowledge Seed/概念/脑科学-2c6b95a5.md';
  const body = '---\nknowledge_seed_id: "concept-2c6b95a5"\ntitle: "脑科学"\n---\n\n手写正文';
  const fixture = loadPlugin({ extraFiles: { [oldPath]: body, '.obsidian/app.json': '{"alwaysUpdateLinks":false}' } }); await fixture.plugin.onload();
  const changes = await fixture.plugin.nameCleanupPlan();
  await assert.rejects(fixture.plugin.applyNameCleanup(changes), /始终更新内部链接/);
  assert.equal(fixture.files.get(oldPath), body); assert.equal(fixture.plugin.busy, false);
  fixture.files.delete('.obsidian/app.json');
  await assert.rejects(fixture.plugin.applyNameCleanup(changes), /始终更新内部链接/);
  assert.equal(fixture.files.get(oldPath), body);
  fixture.files.set('.obsidian/app.json', '{"alwaysUpdateLinks":true}'); fixture.files.set(oldPath, '# 所有权已移除');
  await assert.rejects(fixture.plugin.applyNameCleanup(changes), /不属于/);
  assert.equal(fixture.files.has('Knowledge Seed/概念/脑科学.md'), false); assert.equal(fixture.plugin.busy, false);
});

test('saved native runs retain normalized discovery configuration across restart without writing original notes', async () => {
  const fixture=loadPlugin(); await fixture.plugin.onload(); const before=new Map(fixture.files);
  const graph=await fixture.plugin.discover({kind:'note',value:'知识图谱.md'},()=>{}, {depth:999,maxPages:0,web:false,searchTerms:[' 神经科学 ','神经科学']});
  assert.equal(graph.request.options.depth,20); assert.deepEqual([...graph.request.options.searchTerms],['神经科学']);
  assert.equal(fixture.plugin.history.length,0); await fixture.plugin.persist(graph);
  const run=fixture.plugin.history[0]; assert.equal(run.run.rootPath,fixture.plugin.lastRun.rootPath);
  const audit=JSON.parse(fixture.files.get(`${run.run.folder}/graph.json`)!);
  assert.equal(audit.request.seed.value,'知识图谱.md'); assert.equal(audit.request.options.depth,20);
  const reopened=fixture.createPlugin(); await reopened.onload();
  assert.equal(reopened.history.length,1);assert.equal(reopened.history[0].request.seed.kind,'note');
  assert.equal(reopened.history[0].request.options.depth,20);
  for(const [path,body] of before)assert.equal(fixture.files.get(path),body);
});

test('partial save failure never adds a successful exploration history record', async () => {
  const fixture=loadPlugin({writeFails:true}); await fixture.plugin.onload();
  const graph=await fixture.plugin.discover({kind:'note',value:'知识图谱.md'},()=>{});
  await assert.rejects(fixture.plugin.persist(graph),/保存未完成/);assert.equal(fixture.plugin.history.length,0);
});

test('shipped plugin persists and refreshes detailed web bodies through atomic vault processing', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = await fixture.plugin.discover({kind:'note',value:'知识图谱.md'},()=>{});
  const body = '详细正文版本一：尾段有重要条件。';
  const source = {id:'web-reading-runtime',kind:'web',title:'阅读正文',locator:'https://example.org/reading',
    excerpt:'这是列表摘要。',retrievedAt:graph.createdAt,status:'retrieved',depth:1,
    article:{blocks:[{type:'paragraph',text:body}],textChars:body.length,totalTextChars:body.length,truncated:false}};
  graph.nodes.push(source);
  graph.edges.push({id:'reading-source-edge',from:graph.nodes[0].id,to:source.id,relation:'seed_source',
    evidence:[{sourceId:source.id,quote:'阅读正文',method:'用户指定网页'}]});
  await fixture.plugin.persist(graph);
  const path = fixture.plugin.lastRun.nodePaths[source.id];
  assert.ok(fixture.files.get(path)!.includes('## 正文'));
  assert.ok(fixture.files.get(path)!.includes(body));
  fixture.files.set(path, fixture.files.get(path)! + '\n人工笔记必须保留。\n');
  source.article.blocks[0].text = body.replace('版本一','版本二');
  await fixture.plugin.persist(graph);
  const updated = fixture.files.get(path)!;
  assert.ok(updated.includes('详细正文版本二'));
  assert.ok(!updated.includes('详细正文版本一'));
  assert.ok(updated.includes('人工笔记必须保留。'));
  assert.ok(fixture.processed.includes(path));
  const edited = updated.replaceAll('详细正文版本二','人工修订版本');
  fixture.files.set(path, edited);
  await fixture.plugin.persist(graph);
  assert.ok(fixture.files.get(path)!.startsWith(edited));
  const preserved = fixture.files.get(path)!;
  await fixture.plugin.persist(graph);
  assert.equal(fixture.files.get(path),preserved);
});

function bodyPriorityGraph(url = 'https://example.org/body-priority'): KnowledgeGraph {
  // Artificial paragraphs exercise saving only; this fixture performs no webpage request.
  const paragraphs = ['人工测试长段落：验证完整正文和段落边界保留。'.repeat(100), '人工测试结尾段落：尾部条件也必须完整保存。'.repeat(45)];
  const textChars = paragraphs.join('\n\n').length;
  const seed: GraphNode = { id: 'seed-body-priority-runtime', kind: 'seed', title: '正文优先测试', excerpt: '测试起点', status: 'derived', depth: 0 };
  const webpage: GraphNode = { id: nodeId('web', url), kind: 'web', title: '正文优先来源', locator: url, excerpt: '预览摘录不是正文。',
    retrievedAt: '2026-10-08T10:00:00.000Z', status: 'retrieved', depth: 1,
    article: { blocks: paragraphs.map(text => ({ type: 'paragraph' as const, text })), textChars, totalTextChars: textChars, truncated: false } };
  return { version: 1, seed: seed.title, createdAt: '2026-10-08T10:00:00.000Z', nodes: [seed, webpage],
    edges: [{ id: 'edge-body-priority-runtime', from: seed.id, to: webpage.id, relation: 'seed_source',
      evidence: [{ sourceId: webpage.id, quote: '人工测试来源', method: '测试注入，未执行网络请求' }] }],
    warnings: [], stats: { pagesAttempted: 0, notesScanned: 0, requests: 0 } };
}

function ownedEmptyConcept(id: string, url: string): string {
  return `---\nknowledge_seed_id: ${JSON.stringify(id)}\ntitle: "正文优先来源"\nkind: concept\nstatus: derived\nentity_url: ${JSON.stringify(url)}\ncustom_review: "保留人工属性"\n---\n\n`
    + `# 正文优先来源\n\n> 仅有提及证据，尚未读取正文。\n\n<!-- knowledge-seed:links:${id} -->\n- 原始提及证据：人工测试引用必须保留。\n<!-- /knowledge-seed:links:${id} -->\n\n`
    + '## 人工尾注\n手工补充事实必须保持不变。\n';
}

test('shipped bundle upgrades a unique owned entity URL placeholder in place, preserving evidence and manual edits across replay', async () => {
  const graph = bodyPriorityGraph(), webpage = graph.nodes[1], conceptId = nodeId('concept', `url:${webpage.locator}`);
  const originalPath = 'Knowledge Seed/概念/正文优先来源.md', original = ownedEmptyConcept(conceptId, webpage.locator!);
  const fixture = loadPlugin({ extraFiles: { [originalPath]: original } }); await fixture.plugin.onload();
  assert.ok(webpage.article!.blocks[0].type === 'paragraph' && webpage.article!.blocks[0].text.length >= 2000);
  await fixture.plugin.persist(graph);
  assert.equal(fixture.plugin.lastRun.nodePaths[webpage.id], originalPath);
  assert.equal(fixture.files.has('Knowledge Seed/网页/正文优先来源.md'), false, 'successful completion must reuse the existing entity file');
  const upgraded = fixture.files.get(originalPath)!;
  const metadata = fixture.frontmatter(originalPath)!;
  assert.equal(metadata.knowledge_seed_id, conceptId); assert.equal(metadata.kind, 'web');
  assert.equal(metadata.status, 'retrieved'); assert.equal(metadata.source, webpage.locator);
  assert.equal(metadata.entity_url, webpage.locator); assert.equal(metadata.custom_review, '保留人工属性');
  assert.ok(metadata.knowledge_seed_merged_ids.includes(webpage.id));
  assert.ok(upgraded.includes(original.slice(original.indexOf('# 正文优先来源'))), 'the complete prior body, evidence block and hand-written tail must survive');
  for (const block of webpage.article!.blocks) if (block.type === 'paragraph') assert.ok(upgraded.includes(block.text));
  assert.ok(upgraded.includes('## 正文'));
  const ownedBeforeReplay = ownedPaths(fixture);
  await fixture.plugin.persist(structuredClone(graph));
  assert.deepEqual(ownedPaths(fixture), ownedBeforeReplay);
  assert.equal(fixture.plugin.lastRun.nodePaths[webpage.id], originalPath);
  assert.equal(fixture.files.get(originalPath), upgraded, 'replaying the same source must neither duplicate the body nor revive an empty concept');
});

test('shipped bundle preserves ambiguous same-URL placeholders and different-URL notes without silently selecting an original', async () => {
  for (const scenario of ['ambiguous', 'different'] as const) {
    const graph = bodyPriorityGraph(); const url = graph.nodes[1].locator!;
    const originalFiles: Record<string, string> = scenario === 'ambiguous' ? {
      'Knowledge Seed/概念/来源甲.md': ownedEmptyConcept('concept-placeholder-a', url),
      'Knowledge Seed/概念/来源乙.md': ownedEmptyConcept('concept-placeholder-b', url),
    } : { 'Knowledge Seed/概念/同名不同网页.md': ownedEmptyConcept('concept-placeholder-different', 'https://example.org/different-entity') };
    const fixture = loadPlugin({ extraFiles: originalFiles }); await fixture.plugin.onload();
    await fixture.plugin.persist(graph);
    const retained = fixture.plugin.lastRun.nodePaths[graph.nodes[1].id];
    assert.equal(retained, 'Knowledge Seed/网页/正文优先来源.md');
    for (const [path, content] of Object.entries(originalFiles)) {
      assert.equal(fixture.files.get(path), content, `${scenario}: every original note must remain byte-for-byte unchanged`);
      assert.ok(!fixture.processed.includes(path));
    }
    assert.ok(fixture.files.get(retained)!.includes('## 正文'));
    assert.equal(fixture.frontmatter(retained)?.knowledge_seed_id, graph.nodes[1].id);
  }
});

test('default preview preserves unread concepts with source evidence while the readable-only filter remains optional', async () => {
  const fixture = loadPlugin(); await fixture.plugin.onload();
  const graph = bodyPriorityGraph(), source = graph.nodes[1];
  for (let index = 0; index < 45; index++) {
    const id = `concept-unread-runtime-${index}`;
    graph.nodes.push({ id, kind: 'concept', title: `未读概念 ${index}`, entityUrl: `https://example.org/unread/${index}`,
      excerpt: '仅有提及证据，尚未读取正文。', status: 'derived', depth: 2,
      reading: {state:'pending',reason:'等待补充正文'} });
    graph.edges.push({ id: `edge-unread-runtime-${index}`, from: source.id, to: id, relation: 'mentions',
      evidence: [{ sourceId: source.id, quote: `人工测试提及概念 ${index}`, method: '测试引用' }] });
  }
  const filtered = previewSelectionSummary(graph, defaultPreviewSelection(graph)).graph;
  assert.equal(filtered.nodes.length, 47); assert.equal(filtered.edges.length, 46);
  assert.equal(previewSelectionSummary(graph,readablePreviewSelection(graph)).graph.nodes.length,2);
  const folder = await fixture.plugin.persist(filtered);
  assert.ok(fixture.files.has(`${folder}/COMPLETE.json`));
  assert.equal([...fixture.files.keys()].filter(path => path.startsWith('Knowledge Seed/概念/') && path.endsWith('.md')).length, 45);
  assert.equal(ownedPaths(fixture).length, 47);
  const saved = fixture.files.get(fixture.plugin.lastRun.nodePaths[source.id])!;
  for (const block of source.article!.blocks) if (block.type === 'paragraph') assert.ok(saved.includes(block.text));
  assert.equal(graph.nodes.length, 47, 'the original candidate graph remains available for explicit choices or later body completion');
});

test('managed reading reasons remain visible without being misclassified as retrieved body',async()=>{
  const files:Record<string,string>={};
  for(const state of ['pending','reading','ready','failed','no_match','excluded','invalid']){
    const id=`concept-status-runtime-${state}`,path=`Knowledge Seed/概念/读取状态 ${state}.md`;
    files[path]=`---\nknowledge_seed_id: ${JSON.stringify(id)}\ntitle: "重要概念"\nkind: concept\nstatus: derived\nreading_state: ${JSON.stringify(state)}\n---\n\n# 重要概念\n\n> 仅有提及证据，尚未读取正文。\n\n`
      + `<!-- knowledge-seed:reading:${id} -->\n> 等待继续读取：该名词保留关系证据，尚未获取对应定义。\n<!-- /knowledge-seed:reading:${id} -->\n\n`
      + `<!-- knowledge-seed:links:${id} -->\n- 人工测试来源提供提及证据。\n<!-- /knowledge-seed:links:${id} -->\n`;
  }
  const manualPath='Knowledge Seed/概念/人工短定义与读取状态.md';
  files[manualPath]=files['Knowledge Seed/概念/读取状态 pending.md'].replaceAll('concept-status-runtime-pending','concept-status-runtime-manual')+'\n方差衡量观测值的离散程度。\n';
  const fixture=loadPlugin({extraFiles:files});await fixture.plugin.onload();await fixture.plugin.refreshManagedNotes();
  for(const state of ['pending','reading','ready','failed','no_match','excluded']){
    const ref=fixture.plugin.managedNotes.get(`Knowledge Seed/概念/读取状态 ${state}.md`);
    assert.equal(ref.readingState,state);assert.equal(ref.bodyAvailable,false);
  }
  assert.equal(fixture.plugin.managedNotes.get('Knowledge Seed/概念/读取状态 invalid.md').readingState,undefined);
  assert.equal(fixture.plugin.managedNotes.get(manualPath).bodyAvailable,true,'a real short manual definition still counts as content');
  for(const[path,content]of Object.entries(files))assert.equal(fixture.files.get(path),content,'status detection must not write or edit notes');
});

function pendingConceptExploration(name:string,state:NonNullable<GraphNode['reading']>['state']):KnowledgeGraph{
  const graph=bodyPriorityGraph(`https://example.org/pending-branch/${name}`),oldRoot=graph.nodes[0].id;
  graph.nodes[0].id=`seed-pending-branch-${name}`;graph.nodes[0].title=`探索 ${name}`;graph.seed=graph.nodes[0].title;
  graph.edges[0].from=graph.nodes[0].id;
  for(const evidence of graph.edges[0].evidence)if(evidence.sourceId===oldRoot)evidence.sourceId=graph.nodes[0].id;
  const entityUrl='https://example.org/important-unread';
  const concept:GraphNode={id:nodeId('concept',`url:${entityUrl}`),kind:'concept',title:'重要未读概念',entityUrl,
    excerpt:'仅有提及证据，尚未读取正文。',status:'derived',depth:2,reading:{state,reason:'等待独立正文补全'}};
  graph.nodes.push(concept);graph.edges.push({id:`edge-pending-${name}`,from:graph.nodes[1].id,to:concept.id,relation:'mentions',
    evidence:[{sourceId:graph.nodes[1].id,quote:'原文提及重要未读概念。',method:'人工测试来源正文'}]});return graph;
}

test('explicit unread concepts bridge completed native scopes and preserve their state across reopening',async()=>{
  for(const state of ['pending','reading','failed','no_match'] as const){
    const fixture=loadPlugin();await fixture.plugin.onload();
    const first=pendingConceptExploration(`first-${state}`,state),firstFolder=await fixture.plugin.persist(first);
    const firstRun=JSON.parse(fixture.files.get(`${firstFolder}/native.json`)!);
    const concept=first.nodes.find(node=>node.kind==='concept')!,path=firstRun.nodePaths[concept.id];
    const firstAudit=fixture.files.get(`${firstFolder}/graph.json`);
    await fixture.plugin.refreshManagedNotes();assert.equal(fixture.plugin.managedNotes.get(path).bodyAvailable,false);
    const secondFolder=await fixture.plugin.persist(pendingConceptExploration(`second-${state}`,state));
    assert.equal(fixture.plugin.lastRun.nodePaths[concept.id],path);
    assert.ok(fixture.plugin.lastRun.integratedFolders.includes(firstFolder));assert.ok(fixture.plugin.lastRun.integratedFolders.includes(secondFolder));
    assert.ok(Object.values(fixture.plugin.lastRun.nodePaths).includes(firstRun.rootPath),'the unread shared concept is a real bridge between exploration branches');
    assert.equal([...fixture.files.keys()].filter(file=>file.endsWith('.md')&&fixture.frontmatter(file)?.title===concept.title).length,1);
    const before=new Map(fixture.files),reopened=await fixture.plugin.integratedNativeRun(fixture.plugin.lastRun);
    assert.ok(reopened.integratedFolders.includes(firstFolder));assert.equal(fixture.files.get(`${firstFolder}/graph.json`),firstAudit);
    assert.deepEqual(fixture.files,before);
  }
});

test('completing a pending concept updates its one native node and preserves manual content and ordinary notes',async()=>{
  const ordinaryPath='研究/原始笔记.md',ordinaryBody='# 原始笔记\n\n普通用户正文不得由补全流程改写。';
  const fixture=loadPlugin({extraFiles:{[ordinaryPath]:ordinaryBody}});await fixture.plugin.onload();
  const first=pendingConceptExploration('pending-before-upgrade','pending'),firstFolder=await fixture.plugin.persist(first);
  const pending=first.nodes.find(node=>node.kind==='concept')!,path=fixture.plugin.lastRun.nodePaths[pending.id];
  const manual='\n## 人工阅读记录\n保留这个重要名词，下一轮再补全定义。\n';fixture.files.set(path,fixture.files.get(path)!+manual);
  const graph=bodyPriorityGraph(pending.entityUrl!);graph.nodes[0].id='seed-pending-completed';graph.edges[0].from=graph.nodes[0].id;
  graph.nodes[1].title=pending.title;graph.nodes[1].reading={state:'ready',reason:'已获取来源正文'};
  graph.nodes.push({id:nodeId('note',ordinaryPath),kind:'note',title:'原始笔记',locator:ordinaryPath,excerpt:ordinaryBody,status:'retrieved',depth:1,reading:{state:'ready'}});
  graph.edges.push({id:'edge-pending-original-note',from:graph.nodes[0].id,to:nodeId('note',ordinaryPath),relation:'wiki_link',
    evidence:[{sourceId:nodeId('note',ordinaryPath),quote:'原始笔记的真实内容',method:'人工测试'}]});
  await fixture.plugin.persist(graph);
  const ready=graph.nodes[1],saved=fixture.files.get(path)!;
  assert.equal(fixture.plugin.lastRun.nodePaths[ready.id],path);assert.equal(fixture.frontmatter(path)?.knowledge_seed_id,pending.id);
  assert.equal(fixture.frontmatter(path)?.reading_state,'ready');assert.equal(fixture.frontmatter(path)?.kind,'web');
  assert.ok(fixture.frontmatter(path)?.knowledge_seed_merged_ids.includes(ready.id));assert.ok(saved.includes(manual));
  assert.ok(saved.includes('原文提及重要未读概念。'));for(const block of ready.article!.blocks)if(block.type==='paragraph')assert.ok(saved.includes(block.text));
  assert.equal([...fixture.files.keys()].filter(file=>file.endsWith('.md')&&fixture.frontmatter(file)?.title===pending.title).length,1);
  assert.ok(fixture.plugin.lastRun.integratedFolders.includes(firstFolder));assert.equal(fixture.files.get(ordinaryPath),ordinaryBody);
  await fixture.plugin.refreshManagedNotes();assert.equal(fixture.plugin.managedNotes.get(path).bodyAvailable,true);
});

function unassignedConceptContent(id:string,title:string):string {
  return `---\nknowledge_seed_id: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\nkind: concept\nstatus: derived\nreading_state: pending\ncustom_review: "保留人工属性"\n---\n\n# ${title}\n\n> 仅有提及证据，尚未读取正文。\n\n`
    + `<!-- knowledge-seed:reading:${id} -->\n> 等待补充正文。\n<!-- /knowledge-seed:reading:${id} -->\n\n`
    + `<!-- knowledge-seed:links:${id} -->\n- 原始提及证据：人工测试引用必须保留。\n<!-- /knowledge-seed:links:${id} -->\n\n<!-- 人工内部记录必须保留。 -->\n`;
}

test('dynamic discovery confirms an unassigned empty owned concept source before upgrading its original file',async()=>{
  const title='方差',owner='concept-unassigned-runtime',path='Knowledge Seed/概念/方差.md',original=unassignedConceptContent(owner,title);
  const ordinaryPath='研究/方差.md',ordinary='# 方差\n\n普通用户已有定义必须保持不变。';
  const url=`https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`,body='方差衡量观测值围绕均值的离散程度。'.repeat(160);
  const calls:string[]=[];
  const fixture=loadPlugin({extraFiles:{[path]:original,[ordinaryPath]:ordinary},request:async address=>{
    calls.push(address);
    if(new URL(address).pathname==='/w/api.php')return{status:200,text:JSON.stringify({query:{search:[{title,snippet:'方差的准确来源'}]}}),headers:{'content-type':'application/json'}};
    assert.equal(address,url);return{status:200,text:`<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`,headers:{'content-type':'text/html'}};
  }});await fixture.plugin.onload();const before=new Map(fixture.files);
  const graph=await fixture.plugin.discover({kind:'note',value:path},()=>{},{readingMode:'adaptive',readingPace:'fast',web:true});
  assert.deepEqual(fixture.files,before,'progressive source discovery stays read-only until explicit save');
  const source=graph.nodes.find((node:any)=>node.kind==='web')!;
  assert.ok(source);assert.equal(source.managedId,owner);assert.equal(source.sourceResolution.term,title);
  assert.ok(calls.some(address=>new URL(address).pathname==='/w/api.php'));
  await fixture.plugin.persist(graph);
  assert.equal(fixture.plugin.lastRun.nodePaths[source.id],path);assert.equal(fixture.frontmatter(path)?.knowledge_seed_id,owner);
  assert.equal(fixture.frontmatter(path)?.kind,'web');assert.equal(fixture.frontmatter(path)?.source,url);assert.equal(fixture.frontmatter(path)?.reading_state,'ready');
  assert.equal(fixture.frontmatter(path)?.custom_review,'保留人工属性');assert.ok(fixture.files.get(path)!.includes('人工内部记录必须保留。'));
  assert.ok(fixture.files.get(path)!.includes('原始提及证据：人工测试引用必须保留。'));assert.ok(fixture.files.get(path)!.includes(body));
  assert.equal([...fixture.files.keys()].filter(file=>file.startsWith('Knowledge Seed/')&&file.endsWith('.md')&&fixture.frontmatter(file)?.title===title&&fixture.frontmatter(file)?.kind!=='seed').length,1);
  assert.equal(fixture.files.get(ordinaryPath),ordinary);
});

test('malformed or mismatched source-resolution claims cannot overwrite an unassigned owned concept',async()=>{
  const title='方差',owner='concept-invalid-resolution-runtime',path='Knowledge Seed/概念/方差.md';
  const queryUrl='https://zh.wikipedia.org/w/api.php?'+new URLSearchParams({action:'query',list:'search',srnamespace:'0',format:'json',srsearch:title});
  const sourceUrl=`https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  for(const resolution of [undefined,{term:title,queryUrl:'https://evil.example.org/w/api.php?srsearch=方差'},
    {term:'标准差',queryUrl},{term:title,queryUrl:queryUrl.replace('/w/api.php','/wiki/方差')},
    {term:title,queryUrl:queryUrl.replace('srnamespace=0','srnamespace=1')}]){
    const fixture=loadPlugin({extraFiles:{[path]:unassignedConceptContent(owner,title)}});await fixture.plugin.onload();
    const graph=bodyPriorityGraph(sourceUrl);graph.nodes[1].title=title;graph.nodes[1].managedId=owner;
    graph.nodes[1].reading={state:'ready'};graph.nodes[1].sourceResolution=resolution;
    const before=new Map(fixture.files);await assert.rejects(fixture.plugin.persist(graph),/来源确认信息无效/);
    assert.deepEqual(fixture.files,before);assert.equal(fixture.plugin.busy,false);
  }
});

test('merging a second owned concept identity into another generated file refuses before creating alias conflicts',async()=>{
  const url='https://example.org/runtime-existing-owned-source',graph=bodyPriorityGraph(url),title='重要概念';graph.nodes[1].title=title;
  const oldOwner='concept-second-owned-runtime',conceptPath='Knowledge Seed/概念/重要概念占位.md';
  const fixture=loadPlugin({extraFiles:{[conceptPath]:unassignedConceptContent(oldOwner,title)}});await fixture.plugin.onload();
  await fixture.plugin.persist(graph);const webPath=fixture.plugin.lastRun.nodePaths[graph.nodes[1].id];
  const second=structuredClone(graph);
  const concept:GraphNode={id:oldOwner,managedId:oldOwner,kind:'concept',title,entityUrl:url,
    excerpt:'来源正文中的术语或链接名称，定义与语义关系待核实。',status:'derived',depth:2,reading:{state:'ready'}};
  second.nodes.push(concept);second.edges.push({id:'owned-conflict-mentioned',from:second.nodes[0].id,to:concept.id,relation:'mentions',
    evidence:[{sourceId:second.nodes[1].id,quote:'原文提及重要概念。',method:'人工测试'}]});
  const before=new Map(fixture.files);await assert.rejects(fixture.plugin.persist(second),/合并重复概念与正文节点.*去重合并/);
  assert.deepEqual(fixture.files,before,'cross-file owned aliases must be rejected before any output or content mutation');
  assert.equal(fixture.frontmatter(webPath)?.knowledge_seed_merged_ids?.includes(oldOwner)??false,false);
  assert.equal(fixture.frontmatter(conceptPath)?.knowledge_seed_id,oldOwner);assert.equal(fixture.plugin.busy,false);
  await fixture.plugin.refreshManagedNotes();assert.equal(fixture.plugin.managedNotes.get(webPath).managedId,graph.nodes[1].id);
  assert.equal(fixture.plugin.managedNotes.get(conceptPath).managedId,oldOwner);
});

test('shipped dynamic reader separates finish-with-current-results from cancel and drops late transport results',async()=>{
  for(const action of ['finish','cancel'] as const){
    const rootUrl=`https://example.org/runtime-progress-${action}`,childUrl=`https://example.org/runtime-child-${action}`;
    let resolveChild!:(value:{status:number;text:string;headers:Record<string,string>})=>void;
    let childStarted!:()=>void;
    const waitingChild=new Promise<{status:number;text:string;headers:Record<string,string>}>(resolve=>{resolveChild=resolve;});
    const started=new Promise<void>(resolve=>{childStarted=resolve;});
    let freshWithoutLinks=false,finishRequested=false;
    const body='人工测试正文完整段落，保留到本段结尾。'.repeat(140);
    const fixture=loadPlugin({request:async address=>{
      if(address===childUrl){childStarted();return waitingChild;}
      assert.equal(address,rootUrl);
      return{status:200,text:`<html><head><title>动态阅读测试</title></head><body><article><h1>动态阅读测试</h1><p>${body}</p>${freshWithoutLinks?'':`<p>原文进一步介绍<a href="${childUrl}">关键概念</a>的完整定义和基本方法，相关材料与出处可以帮助读者深入了解这个被明确提及的重要概念。</p>`}</article></body></html>`,headers:{'content-type':'text/html'}};
    }});await fixture.plugin.onload();const before=new Map(fixture.files);
    const snapshots:any[]=[],progress:string[]=[];
    const discovery=fixture.plugin.discover({kind:'url',value:rootUrl},(message:string)=>progress.push(message),
      {readingMode:'adaptive',readingPace:'fast',web:true},{shouldFinish:()=>finishRequested,onSnapshot:(graph:any)=>snapshots.push(graph)});
    await Promise.race([started,discovery.then(()=>{throw new Error('The source link must start a related-page request before discovery finishes.');})]);
    assert.ok(snapshots.some(graph=>graph.nodes.some((node:any)=>node.kind==='web'&&node.article?.textChars>=2000)),'a full source is delivered before its related page finishes');
    assert.deepEqual(fixture.files,before,'progressive callbacks must not write notes');
    if(action==='finish')finishRequested=true;else fixture.plugin.activeController.abort();
    if(action==='finish'){
      const result=await discovery;assert.equal(result.reading.stopReason,'requested');
      assert.equal(result.nodes.find((node:any)=>node.kind==='concept').reading.state,'pending');
      assert.equal(result.nodes.filter((node:any)=>node.kind==='web').length,1);
    }else await assert.rejects(discovery,/已取消|取消/);
    assert.equal(fixture.plugin.busy,false);assert.equal(fixture.plugin.activeController,undefined);
    const callbackSnapshot=JSON.stringify({snapshots,progress});
    freshWithoutLinks=true;
    const newer=await fixture.plugin.discover({kind:'url',value:rootUrl},()=>{}, {readingMode:'adaptive',readingPace:'fast',web:true});
    const stableNewer=JSON.stringify(newer);
    resolveChild({status:200,text:`<html><head><title>关键概念</title></head><body><article><p>${body}</p></article></body></html>`,headers:{'content-type':'text/html'}});
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(JSON.stringify({snapshots,progress}),callbackSnapshot,'a discarded transport cannot emit a late snapshot or progress update');
    assert.equal(JSON.stringify(newer),stableNewer);assert.equal(newer.stats.requests,1);
    assert.deepEqual(fixture.files,before);
  }
});

test('exploring an owned webpage note with its retrieved web view saves one file and remaps note evidence without a path conflict', async () => {
  const fixture=loadPlugin({extraFiles:{'后续笔记.md':'# 后续笔记\n\n真实已有笔记内容必须保留。'}}); await fixture.plugin.onload();
  const originalGraph=bodyPriorityGraph('https://example.org/kernel-pca');
  originalGraph.nodes[1].title='核主成分分析';
  await fixture.plugin.persist(originalGraph);
  const web=originalGraph.nodes[1], path=fixture.plugin.lastRun.nodePaths[web.id];
  const manual='\n## 人工阅读记录\n原正文中的条件已经人工核验，补充内容必须保持不变。\n';
  fixture.files.set(path,fixture.files.get(path)!+manual);
  const before=fixture.files.get(path)!, childBefore=fixture.files.get('后续笔记.md')!;
  const graph=structuredClone(originalGraph), root=graph.nodes[0];
  const previousRoot=root.id; root.id='seed-from-owned-note-runtime'; root.title='继续探索核主成分分析';
  for(const edge of graph.edges){if(edge.from===previousRoot)edge.from=root.id;if(edge.to===previousRoot)edge.to=root.id;
    for(const evidence of edge.evidence)if(evidence.sourceId===previousRoot)evidence.sourceId=root.id;}
  const view:GraphNode={id:nodeId('note',path),kind:'note',title:web.title,locator:path,managedId:web.id,
    excerpt:'从已有笔记读取的正文摘录。',status:'retrieved',depth:1};
  const child:GraphNode={id:'note-owned-source-child',kind:'note',title:'后续笔记',locator:'后续笔记.md',excerpt:'已有正文。',status:'retrieved',depth:2};
  graph.nodes.push(view,child);
  graph.edges.push({id:'owned-note-seed',from:root.id,to:view.id,relation:'seed_source',evidence:[{sourceId:view.id,quote:'从已有核主成分分析笔记出发',method:'用户指定笔记'}]},
    {id:'owned-note-child',from:view.id,to:child.id,relation:'wiki_link',evidence:[{sourceId:view.id,quote:'原笔记引用后续笔记',method:'已有双链'}]},
    {id:'owned-note-self-source',from:view.id,to:web.id,relation:'links_to',evidence:[{sourceId:view.id,quote:'原笔记的来源网页',method:'同一实体网页'}]});
  const folder=await fixture.plugin.persist(graph);
  assert.ok(fixture.files.has(`${folder}/COMPLETE.json`));
  assert.equal(fixture.plugin.lastRun.nodePaths[web.id],path);
  assert.equal(fixture.plugin.lastRun.nodePaths[view.id],undefined);
  assert.equal([...fixture.files.keys()].filter(p=>p.endsWith('.md')&&fixture.frontmatter(p)?.title===web.title).length,1);
  const saved=fixture.files.get(path)!;
  assert.ok(saved.startsWith(before),'existing full reading and manual edits remain byte-for-byte as the prefix');
  assert.ok(saved.includes(manual)); assert.equal(fixture.files.get('后续笔记.md'),childBefore);
  const audit=JSON.parse(fixture.files.get(`${folder}/graph.json`)!);
  assert.ok(!audit.nodes.some((n:any)=>n.id===view.id));
  assert.ok(audit.nodes.find((n:any)=>n.id===web.id).article);
  assert.ok(audit.edges.some((edge:any)=>edge.from===web.id&&edge.to===child.id&&edge.relation==='wiki_link'
    &&edge.evidence.some((e:any)=>e.sourceId===web.id&&e.quote==='原笔记引用后续笔记')));
  assert.ok(audit.edges.some((edge:any)=>edge.from===root.id&&edge.to===web.id
    &&edge.evidence.some((e:any)=>e.sourceId===web.id&&e.quote==='从已有核主成分分析笔记出发')));
  assert.ok(audit.edges.every((edge:any)=>edge.from!==edge.to&&!edge.evidence.some((e:any)=>e.sourceId===view.id)));
});

test('real discover with mocked webpage retrieval folds an owned note and its full source before preview so preview and saved counts agree',async()=>{
  const title='核主成分分析',url=`https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const originalGraph=bodyPriorityGraph(url);originalGraph.nodes[1].title=title;
  const original=exportGraph(originalGraph,'Knowledge Seed','before-discovery-runtime');
  const path=original.nodePaths[originalGraph.nodes[1].id], files=Object.fromEntries(original.files.map(file=>[file.path,file.content]));
  const tail='\n## 人工补充\n原笔记的人工条件与阅读记录必须保持不变。\n';files[path]+=tail;
  const paragraphs=originalGraph.nodes[1].article!.blocks.filter(block=>block.type==='paragraph').map(block=>block.text);
  const html=`<!doctype html><html><head><title>${title} - 维基百科，自由的百科全书</title></head><body><h1 id="firstHeading">${title}</h1><div id="mw-content-text"><div class="mw-parser-output">${paragraphs.map(text=>`<p>${text}</p>`).join('')}</div></div></body></html>`;
  const requests:string[]=[];
  const fixture=loadPlugin({extraFiles:files,request:async address=>{
    requests.push(address);
    if(new URL(address).pathname==='/w/api.php')return{status:200,text:JSON.stringify({query:{search:[{title,snippet:'核主成分分析的人工测试检索记录'}]}}),headers:{'content-type':'application/json'}};
    assert.equal(address,url);return{status:200,text:html,headers:{'content-type':'text/html'}};
  }});await fixture.plugin.onload();const before=new Map(fixture.files);
  const discovered=await fixture.plugin.discover({kind:'note',value:path},()=>{}, {readingMode:'manual',web:true,maxPages:1,depth:0,maxNotes:0,maxConcepts:0,searchLimit:1,maxBodyChars:2000});
  assert.deepEqual(fixture.files,before,'read-only discovery and source-view folding cannot modify an existing note');
  assert.equal(discovered.nodes.length,2);assert.equal(discovered.nodes.filter((node:any)=>node.title===title&&node.kind!=='seed').length,1);
  assert.equal(discovered.nodes.some((node:any)=>node.kind==='note'&&node.locator===path),false);
  const webpage=discovered.nodes.find((node:any)=>node.kind==='web')!;
  assert.equal(webpage.managedId,originalGraph.nodes[1].id);assert.ok(webpage.article.textChars>=2000);
  assert.equal(requests.filter(address=>new URL(address).pathname==='/wiki/'+encodeURIComponent(title)).length,1);
  assert.ok(discovered.edges.every((edge:any)=>discovered.nodes.some((node:any)=>node.id===edge.from)
    &&discovered.nodes.some((node:any)=>node.id===edge.to)&&edge.evidence.every((e:any)=>discovered.nodes.some((node:any)=>node.id===e.sourceId))));
  const preview=previewSelectionSummary(discovered,defaultPreviewSelection(discovered));assert.equal(preview.nodeCount,2);
  const folder=await fixture.plugin.persist(preview.graph),audit=JSON.parse(fixture.files.get(`${folder}/graph.json`)!);
  assert.equal(audit.nodes.length,preview.nodeCount);assert.equal(fixture.plugin.lastRun.nodePaths[webpage.id],path);
  assert.ok(fixture.files.get(path)!.includes(paragraphs[0]));assert.ok(fixture.files.get(path)!.includes(tail));
  assert.equal([...fixture.files.keys()].filter(p=>p.endsWith('.md')&&fixture.frontmatter(p)?.title===title&&fixture.frontmatter(p)?.kind==='web').length,1);
});

test('an ordinary same-title user note stays separate from the generated webpage and every original byte is preserved', async () => {
  const graph=bodyPriorityGraph(), source=graph.nodes[1], path='个人研究/正文优先来源.md';
  const original=`---\ntitle: "正文优先来源"\nsource: ${JSON.stringify(source.locator)}\n---\n\n# 用户正文\n这份笔记拥有独立内容，不能只凭相同名称和来源就折叠。\n`;
  const fixture=loadPlugin({extraFiles:{[path]:original}}); await fixture.plugin.onload();
  const note:GraphNode={id:'note-independent-runtime',kind:'note',title:source.title,locator:path,excerpt:'独立笔记正文。',status:'retrieved',depth:1};
  graph.nodes.push(note); graph.edges.push({id:'independent-note-edge',from:graph.nodes[0].id,to:note.id,relation:'keyword_match',
    evidence:[{sourceId:note.id,quote:'用户独立笔记',method:'已有笔记匹配'}]});
  const folder=await fixture.plugin.persist(graph);
  assert.equal(fixture.files.get(path),original); assert.equal(fixture.plugin.lastRun.nodePaths[note.id],path);
  assert.notEqual(fixture.plugin.lastRun.nodePaths[source.id],path);
  const audit=JSON.parse(fixture.files.get(`${folder}/graph.json`)!);
  assert.ok(audit.nodes.some((n:any)=>n.id===note.id)); assert.ok(audit.nodes.some((n:any)=>n.id===source.id));
});

test('an owned webpage whose live source URL conflicts with its new retrieved view rejects before modifying any note', async () => {
  const graph=bodyPriorityGraph(), web=graph.nodes[1], path='Knowledge Seed/网页/正文优先来源.md';
  const original=`---\nknowledge_seed_id: ${JSON.stringify(web.id)}\ntitle: "正文优先来源"\nkind: web\nsource: "https://example.org/different-live-source"\n---\n\n已有完整网页和人工记录不能被其他网址正文覆盖。\n`;
  const fixture=loadPlugin({extraFiles:{[path]:original}}); await fixture.plugin.onload(); const before=new Map(fixture.files);
  await assert.rejects(fixture.plugin.persist(graph),/来源.*网址冲突/);
  assert.deepEqual(fixture.files,before); assert.equal(fixture.created.length,0); assert.equal(fixture.processed.length,0);
});

function sharedNoteExploration(url:string,rootId:string,title:string):KnowledgeGraph {
  const graph=bodyPriorityGraph(url), priorRoot=graph.nodes[0].id;
  graph.nodes[0].id=rootId; graph.nodes[0].title=title; graph.seed=title;
  graph.nodes[1].title=`${title}来源`;
  for(const edge of graph.edges)if(edge.from===priorRoot)edge.from=rootId;
  const shared:GraphNode={id:nodeId('note','共同笔记.md'),kind:'note',title:'共同笔记',locator:'共同笔记.md',excerpt:'实际共有的笔记正文。',status:'retrieved',depth:1};
  graph.nodes.push(shared);graph.edges.push({id:`${rootId}-shared-edge`,from:rootId,to:shared.id,relation:'keyword_match',
    evidence:[{sourceId:shared.id,quote:'共同笔记中的原文条件',method:'人工测试笔记匹配'}]});
  return graph;
}

test('separate completed explorations sharing a real note retain one connected native scope even when the earlier history entry was evicted',async()=>{
  const originalShared='# 共同笔记\n\n共同笔记中的原文条件必须保持不变。\n';
  const fixture=loadPlugin({extraFiles:{'共同笔记.md':originalShared}});await fixture.plugin.onload();
  const first=sharedNoteExploration('https://example.org/connected-first','seed-connected-first','第一探索');
  const firstFolder=await fixture.plugin.persist(first), firstNative=JSON.parse(fixture.files.get(`${firstFolder}/native.json`)!);
  const auditBefore=new Map(['graph.json','native.json','Overview.md','COMPLETE.json'].map(name=>[name,fixture.files.get(`${firstFolder}/${name}`)]));
  fixture.plugin.history=[]; // Emulate an old completed run no longer retained among the latest 20 UI records.
  const second=sharedNoteExploration('https://example.org/connected-second','seed-connected-second','第二探索');
  const secondFolder=await fixture.plugin.persist(second), secondNative=JSON.parse(fixture.files.get(`${secondFolder}/native.json`)!);
  const integrated=fixture.plugin.lastRun, expected=new Set([...Object.values(firstNative.nodePaths),...Object.values(secondNative.nodePaths)]);
  assert.equal(expected.size,5);assert.deepEqual(new Set(Object.values(integrated.nodePaths)),expected);
  assert.ok(integrated.integratedFolders.includes(firstFolder));assert.ok(integrated.integratedFolders.includes(secondFolder));
  assert.equal(integrated.rootPath,secondNative.rootPath);assert.equal(integrated.folder,secondFolder);
  assert.equal(Object.keys(secondNative.nodePaths).length,3,'the single-run manifest remains a faithful account of the current discovery');
  assert.equal(JSON.parse(fixture.files.get(`${secondFolder}/graph.json`)!).nodes.length,3);
  assert.deepEqual(new Set(Object.values(JSON.parse(fixture.files.get(`${secondFolder}/integrated.json`)!).nodePaths)),expected);
  const graphLeaf=fixture.leaves.find(leaf=>leaf.state?.type==='localgraph')!;
  assert.equal(graphLeaf.state.state.options.search,integrated.search);
  for(const path of expected)assert.ok(new RegExp(integrated.search.slice('path:/'.length,-1)).test(path as string));
  assert.equal(fixture.leaves.filter(leaf=>leaf.state?.type==='localgraph').length,1);
  assert.equal(fixture.files.get('共同笔记.md'),originalShared);
  for(const [name,content]of auditBefore)assert.equal(fixture.files.get(`${firstFolder}/${name}`),content,'completed prior audits remain immutable');
});

test('completed isolated runs with equal display names stay outside the current native connected scope',async()=>{
  const fixture=loadPlugin();await fixture.plugin.onload();
  const first=bodyPriorityGraph('https://example.org/isolated-first');first.nodes[0].id='seed-isolated-first';first.nodes[0].title='主题甲';first.nodes[1].title='同名来源';first.edges[0].from=first.nodes[0].id;
  const firstFolder=await fixture.plugin.persist(first), firstNative=JSON.parse(fixture.files.get(`${firstFolder}/native.json`)!);
  const firstBodies=new Map(Object.values(firstNative.nodePaths).map(path=>[path,fixture.files.get(path as string)]));
  const second=bodyPriorityGraph('https://example.org/isolated-second');second.nodes[0].id='seed-isolated-second';second.nodes[0].title='主题乙';second.nodes[1].title='同名来源';second.edges[0].from=second.nodes[0].id;
  const secondFolder=await fixture.plugin.persist(second), current=JSON.parse(fixture.files.get(`${secondFolder}/native.json`)!);
  assert.deepEqual(new Set(Object.values(fixture.plugin.lastRun.nodePaths)),new Set(Object.values(current.nodePaths)));
  assert.deepEqual([...fixture.plugin.lastRun.integratedFolders],[secondFolder]);
  assert.equal(Object.values(fixture.plugin.lastRun.nodePaths).length,2);
  for(const[path,body]of firstBodies)assert.equal(fixture.files.get(path as string),body);
  assert.notEqual(firstNative.nodePaths[first.nodes[1].id],current.nodePaths[second.nodes[1].id]);
});

test('partially written overlapping runs without a successful completion marker never extend the native graph scope',async()=>{
  const originals={'共同笔记.md':'# 共同笔记\n\n共有原文。','半成品甲.md':'# 半成品甲\n\n不完整任务的来源文件。','半成品乙.md':'# 半成品乙\n\n失败任务的来源文件。'};
  const fixture=loadPlugin({extraFiles:originals});await fixture.plugin.onload();
  for(const[index,name]of ['半成品甲.md','半成品乙.md'].entries()){
    const folder=`Knowledge Seed/Runs/incomplete-runtime-${index}`;
    fixture.files.set(`${folder}/native.json`,JSON.stringify({rootPath:name,nodePaths:{partial:name,shared:'共同笔记.md'}}));
    if(index)fixture.files.set(`${folder}/COMPLETE.json`,JSON.stringify({status:'writing'}));
  }
  const graph=sharedNoteExploration('https://example.org/complete-only','seed-complete-only','完整探索');
  const folder=await fixture.plugin.persist(graph),native=JSON.parse(fixture.files.get(`${folder}/native.json`)!);
  assert.deepEqual(new Set(Object.values(fixture.plugin.lastRun.nodePaths)),new Set(Object.values(native.nodePaths)));
  assert.deepEqual([...fixture.plugin.lastRun.integratedFolders],[folder]);
  assert.equal(Object.values(fixture.plugin.lastRun.nodePaths).includes('半成品甲.md'),false);
  assert.equal(Object.values(fixture.plugin.lastRun.nodePaths).includes('半成品乙.md'),false);
  for(const[path,content]of Object.entries(originals))assert.equal(fixture.files.get(path),content);
});

test('reopening an integrated scope respects a newly excluded Private folder without changing its original note',async()=>{
  const privatePath='Private/私人笔记.md',privateBody='# 私人笔记\n\n该已有笔记必须保持不变。';
  const fixture=loadPlugin({extraFiles:{'共同笔记.md':'# 共同笔记\n\n共有条件。',[privatePath]:privateBody}});await fixture.plugin.onload();
  const first=sharedNoteExploration('https://example.org/private-earlier','seed-private-earlier','有私人笔记的旧探索');
  first.nodes.push({id:'note-private-runtime',kind:'note',title:'私人笔记',locator:privatePath,excerpt:'私人笔记的正文。',status:'retrieved',depth:1});
  first.edges.push({id:'private-earlier-edge',from:first.nodes[0].id,to:'note-private-runtime',relation:'keyword_match',
    evidence:[{sourceId:'note-private-runtime',quote:'私有条件',method:'人工测试注入'}]});
  await fixture.plugin.persist(first);
  await fixture.plugin.persist(sharedNoteExploration('https://example.org/private-current','seed-private-current','当前探索'));
  assert.ok(Object.values(fixture.plugin.lastRun.nodePaths).includes(privatePath),'the initial union demonstrates the historical overlap');
  const before=new Map(fixture.files);fixture.plugin.settings.excludeFolders=['Private'];
  const reopened=await fixture.plugin.integratedNativeRun(fixture.plugin.lastRun);
  assert.equal(Object.values(reopened.nodePaths).includes(privatePath),false);
  assert.equal(new RegExp(reopened.search.slice('path:/'.length,-1)).test(privatePath),false);
  await fixture.plugin.openNativeGraph(fixture.plugin.lastRun);
  const actual=fixture.leaves.find(leaf=>leaf.state?.type==='localgraph')!.state.state.options.search;
  assert.equal(new RegExp(actual.slice('path:/'.length,-1)).test(privatePath),false);
  assert.deepEqual(fixture.files,before);assert.equal(fixture.files.get(privatePath),privateBody);
});

test('reopening recomputes a connected scope after its only shared bridge is deleted or excluded',async()=>{
  for(const action of ['deleted','excluded'] as const){
    const fixture=loadPlugin({extraFiles:{'共同笔记.md':'# 共同笔记\n\n真实的共同条件。'}});await fixture.plugin.onload();
    const first=sharedNoteExploration(`https://example.org/bridge-first-${action}`,`seed-bridge-first-${action}`,'桥接前序探索');
    const firstFolder=await fixture.plugin.persist(first),firstNative=JSON.parse(fixture.files.get(`${firstFolder}/native.json`)!);
    const firstAudit=fixture.files.get(`${firstFolder}/graph.json`);
    const second=sharedNoteExploration(`https://example.org/bridge-current-${action}`,`seed-bridge-current-${action}`,'桥接当前探索');
    const secondFolder=await fixture.plugin.persist(second),currentNative=JSON.parse(fixture.files.get(`${secondFolder}/native.json`)!);
    const prior=structuredClone(fixture.plugin.lastRun);
    assert.ok(prior.integratedFolders.includes(firstFolder));
    assert.ok(Object.values(prior.nodePaths).includes(firstNative.rootPath));
    if(action==='deleted')fixture.files.delete('共同笔记.md');else fixture.plugin.settings.excludeFolders=['共同笔记.md'];
    const before=new Map(fixture.files),reopened=await fixture.plugin.integratedNativeRun(prior);
    assert.deepEqual(new Set(Object.values(reopened.nodePaths)),new Set(Object.values(currentNative.nodePaths).filter(path=>path!=='共同笔记.md')));
    assert.deepEqual([...reopened.integratedFolders],[secondFolder]);
    assert.equal(reopened.rootPath,currentNative.rootPath);
    assert.equal(Object.values(reopened.nodePaths).includes(firstNative.rootPath),false);
    assert.equal(Object.values(reopened.nodePaths).includes('共同笔记.md'),false);
    assert.equal(fixture.files.get(`${firstFolder}/graph.json`),firstAudit);
    assert.deepEqual(fixture.files,before,'scope refresh must not rewrite notes or immutable manifests');
  }
});

test('a missing single-run snapshot cannot let an old integrated union seed disconnected historical scope',async()=>{
  const fixture=loadPlugin({extraFiles:{'共同笔记.md':'# 共同笔记\n\n桥接的实际笔记。'}});await fixture.plugin.onload();
  const first=sharedNoteExploration('https://example.org/missing-snapshot-first','seed-missing-snapshot-first','旧整合探索');
  const firstFolder=await fixture.plugin.persist(first),firstNative=JSON.parse(fixture.files.get(`${firstFolder}/native.json`)!);
  const second=sharedNoteExploration('https://example.org/missing-snapshot-current','seed-missing-snapshot-current','当前整合探索');
  const secondFolder=await fixture.plugin.persist(second),prior=structuredClone(fixture.plugin.lastRun),oldRoot=prior.rootPath;
  assert.ok(prior.integratedFolders.includes(firstFolder));
  const newRoot='Knowledge Seed/起点/缺快照的起点已改名.md';
  await fixture.plugin.app.fileManager.renameFile(fixture.plugin.app.vault.getAbstractFileByPath(oldRoot),newRoot);
  fixture.files.delete(`${secondFolder}/native.json`);fixture.files.delete('共同笔记.md');
  const before=new Map(fixture.files),reopened=await fixture.plugin.integratedNativeRun(prior);
  assert.equal(reopened.rootPath,newRoot);
  assert.deepEqual(new Set(Object.values(reopened.nodePaths)),new Set([newRoot]));
  assert.deepEqual([...reopened.integratedFolders],[secondFolder]);
  assert.equal(Object.values(reopened.nodePaths).includes(firstNative.rootPath),false);
  assert.deepEqual(fixture.files,before);
});

test('legacy single-run selections without an integration snapshot still retain their real source files',async()=>{
  const fixture=loadPlugin({extraFiles:{'旧单次起点.md':'# 起点\n\n原始起点内容。','旧单次来源.md':'# 来源\n\n保留的源正文。'}});await fixture.plugin.onload();
  const run={folder:'Knowledge Seed/Runs/legacy-single-no-snapshot',rootPath:'旧单次起点.md',nodePaths:{'seed-legacy-single':'旧单次起点.md','note-legacy-source':'旧单次来源.md'},search:''};
  const before=new Map(fixture.files),reopened=await fixture.plugin.integratedNativeRun(run);
  assert.deepEqual(new Set(Object.values(reopened.nodePaths)),new Set(['旧单次起点.md','旧单次来源.md']));
  assert.deepEqual([...reopened.integratedFolders],[run.folder]);assert.deepEqual(fixture.files,before);
});

test('short hand-written concept definitions count as body while placeholders and hidden comments do not',async()=>{
  const manualPath='Knowledge Seed/概念/方差短定义.md',emptyPath='Knowledge Seed/概念/方差占位.md',hiddenPath='Knowledge Seed/概念/仅隐藏注释.md';
  const concept=(id:string,body:string)=>`---\nknowledge_seed_id: ${JSON.stringify(id)}\ntitle: "方差"\nkind: concept\nstatus: derived\n---\n\n# 方差\n\n> 来源正文中的术语或链接名称，定义与语义关系待核实。\n\n${body}\n\n## 关系与证据\n<!-- knowledge-seed:links:${id} -->\n- 来源仅提供提及，属于管理区，不应被当作正文。\n<!-- /knowledge-seed:links:${id} -->\n`;
  const definition='方差衡量观测值围绕均值的离散程度。';
  const originals={
    [manualPath]:concept('concept-short-definition',definition),
    [emptyPath]:concept('concept-empty-placeholder','> 仅有提及证据，尚未读取正文。'),
    [hiddenPath]:concept('concept-hidden-comment',`<!-- ${'隐藏记录不属于可阅读正文。'.repeat(20)} -->\n%% ${'隐藏的Obsidian注释。'.repeat(20)} %%`),
    '共同笔记.md':'# 共同笔记\n\n共有原文。',
    '旧定义探索.md':'# 旧定义探索\n\n旧探索的实际起点。',
  };
  const fixture=loadPlugin({extraFiles:originals});await fixture.plugin.onload();await fixture.plugin.refreshManagedNotes();
  const refs=fixture.plugin.adapter().listNotes();
  assert.equal(refs.find((note:any)=>note.path===manualPath)?.bodyAvailable,true);
  assert.equal(refs.find((note:any)=>note.path===emptyPath)?.bodyAvailable,false);
  assert.equal(refs.find((note:any)=>note.path===hiddenPath)?.bodyAvailable,false);
  const graph=bodyPriorityGraph('https://example.org/short-definition-preview');
  for(const path of [manualPath,emptyPath,hiddenPath]){const ref=refs.find((note:any)=>note.path===path)!;
    graph.nodes.push({id:ref.managedId,managedId:ref.managedId,kind:'concept',title:ref.title,locator:path,excerpt:'已有概念笔记',bodyAvailable:ref.bodyAvailable,status:'derived',depth:2});}
  const selected=defaultPreviewSelection(graph);
  assert.equal(selected.has('concept-short-definition'),true);assert.equal(selected.has('concept-empty-placeholder'),true);assert.equal(selected.has('concept-hidden-comment'),true);
  const oldFolder='Knowledge Seed/Runs/short-definition-earlier';
  fixture.files.set(`${oldFolder}/native.json`,JSON.stringify({rootPath:'旧定义探索.md',nodePaths:{'seed-short-old':'旧定义探索.md','note-shared':'共同笔记.md','concept-short-definition':manualPath,'concept-empty-placeholder':emptyPath,'concept-hidden-comment':hiddenPath}}));
  fixture.files.set(`${oldFolder}/COMPLETE.json`,JSON.stringify({status:'complete'}));
  await fixture.plugin.persist(sharedNoteExploration('https://example.org/short-definition-current','seed-short-current','当前定义探索'));
  const integrated=new Set(Object.values(fixture.plugin.lastRun.nodePaths));
  assert.equal(integrated.has(manualPath),true);assert.equal(integrated.has(emptyPath),false);assert.equal(integrated.has(hiddenPath),false);
  for(const[path,content]of Object.entries(originals))assert.equal(fixture.files.get(path),content,'availability detection must preserve every user-authored byte');
});

test('an existing generated root renamed by the core file manager restores through its live owner without editing old manifests',async()=>{
  const fixture=loadPlugin();await fixture.plugin.onload();const graph=bodyPriorityGraph('https://example.org/rename-root');
  const folder=await fixture.plugin.persist(graph),beforeRun=structuredClone(fixture.plugin.lastRun),oldRoot=beforeRun.rootPath;
  const newRoot='Knowledge Seed/起点/阅读起点已改名.md',rootBody=fixture.files.get(oldRoot)!;
  const oldNative=fixture.files.get(`${folder}/native.json`),oldAudit=fixture.files.get(`${folder}/graph.json`);
  await fixture.plugin.app.fileManager.renameFile(fixture.plugin.app.vault.getAbstractFileByPath(oldRoot),newRoot);
  const restored=await fixture.plugin.integratedNativeRun(beforeRun);
  assert.equal(restored.rootPath,newRoot);assert.equal(restored.nodePaths[graph.nodes[0].id],newRoot);
  assert.equal(Object.values(restored.nodePaths).includes(oldRoot),false);assert.equal(fixture.files.get(newRoot),rootBody);
  await fixture.plugin.openNativeGraph(beforeRun);
  assert.equal(fixture.leaves.find(leaf=>leaf.state?.type==='localgraph')!.state.state.file,newRoot);
  assert.equal(fixture.files.get(`${folder}/native.json`),oldNative);assert.equal(fixture.files.get(`${folder}/graph.json`),oldAudit);
});

test('a legitimate user Research/Runs note can connect completed explorations while only plugin audit folders are excluded',async()=>{
  const path='Research/Runs/实验结果.md',body='# 实验结果\n\n合法用户笔记的正文必须保持不变。';
  const fixture=loadPlugin({extraFiles:{[path]:body}});await fixture.plugin.onload();
  const graphs=['one','two'].map((name,index)=>{
    const graph=bodyPriorityGraph(`https://example.org/user-run-${name}`);graph.nodes[0].id=`seed-user-run-${name}`;graph.nodes[0].title=`实验探索 ${index}`;graph.edges[0].from=graph.nodes[0].id;
    const id=nodeId('note',path);graph.nodes.push({id,kind:'note',title:'实验结果',locator:path,excerpt:body,status:'retrieved',depth:1});
    graph.edges.push({id:`user-run-edge-${name}`,from:graph.nodes[0].id,to:id,relation:'keyword_match',evidence:[{sourceId:id,quote:'合法实验结果',method:'已有笔记匹配'}]});return graph;
  });
  const firstFolder=await fixture.plugin.persist(graphs[0]);await fixture.plugin.persist(graphs[1]);
  assert.ok(Object.values(fixture.plugin.lastRun.nodePaths).includes(path));assert.equal(new Set(Object.values(fixture.plugin.lastRun.nodePaths)).size,5);
  assert.ok(fixture.plugin.lastRun.integratedFolders.includes(firstFolder));assert.equal(fixture.files.get(path),body);
});

function setupDuplicateRun(fixture: ReturnType<typeof loadPlugin>) {
  const title = '日本电信电话公社', url = 'https://zh.wikipedia.org/wiki/日本电信电话公社';
  const fullBody = '日本电信电话公社的网页正文必须完整保留；历史沿革与研究事实可追溯。'.repeat(45);
  const seed: GraphNode = {id:'seed-runtime-duplicate',kind:'seed',title:'预测编码',excerpt:'知识起点',status:'derived',depth:0};
  const source: GraphNode = {id:'web-runtime-source',kind:'web',title:'线性预测编码',locator:'https://zh.wikipedia.org/wiki/线性预测编码',
    excerpt:'来源正文提及该机构，且含有通向该机构网页的链接。',status:'retrieved',depth:1};
  const concept: GraphNode = {id:nodeId('concept',title),kind:'concept',title,
    excerpt:'来源正文中的术语或链接名称，定义与语义关系待核实。',status:'derived',depth:2};
  const webpage: GraphNode = {id:nodeId('web',url),kind:'web',title,locator:url,excerpt:fullBody.slice(0,900),status:'retrieved',depth:2,
    retrievedAt:'2026-10-08T05:15:08.123Z',article:{blocks:[{type:'paragraph',text:fullBody}],textChars:fullBody.length,totalTextChars:fullBody.length,truncated:false}};
  const graph: KnowledgeGraph = {version:1,seed:seed.title,createdAt:'2026-10-08T05:14:52.205Z',nodes:[seed,source,concept,webpage],
    edges:[
      {id:stableId('seed-source-runtime'),from:seed.id,to:source.id,relation:'seed_source',evidence:[{sourceId:source.id,quote:source.excerpt,method:'种子网页'}]},
      ...(['mentions','links_to'] as const).map((relation,index)=>({id:stableId(`duplicate-runtime-${index}`),from:source.id,
        to:index ? webpage.id : concept.id,relation,evidence:[{sourceId:source.id,quote:'1966年的研究提到了日本电信电话公社。',method:'网页正文链接',locator:source.locator}]})),
    ],warnings:[],stats:{pagesAttempted:2,notesScanned:0,requests:2}};
  const bundle = exportGraph(graph,'Knowledge Seed','legacy-runtime-duplicate');
  for (const file of bundle.files) fixture.files.set(file.path,file.content);
  const conceptPath = bundle.nodePaths[concept.id], webPath = bundle.nodePaths[webpage.id], sourcePath = bundle.nodePaths[source.id];
  const conceptOriginal = fixture.files.get(conceptPath)!.replace(/^---\n/,'---\ncustom_review: "人工已核实身份"\n')
    + '\n## 概念手工记录\n人工概念正文与补充事实必须保留。\n';
  fixture.files.set(conceptPath,conceptOriginal);
  fixture.files.set(webPath,fixture.files.get(webPath)!+'\n网页人工尾注必须保留。\n');
  const parentPath = '父笔记.md';
  const oldTarget = conceptPath.replace(/\.md$/,'');
  const code = `\`[[${oldTarget}]]\`\n\n\`\`\`text\n[[${oldTarget}]]\n\`\`\``;
  fixture.files.set(parentPath,`# 父笔记\n\n[[${oldTarget}#关系与证据|机构历史]]\n![[${oldTarget}]]\n\n${code}\n`);
  const run = {rootPath:conceptPath,search:nativeSearch(Object.values(bundle.nodePaths)),folder:bundle.folder,graphDepth:3,nodePaths:bundle.nodePaths};
  fixture.plugin.lastRun = run;
  fixture.plugin.history = [{run:JSON.parse(JSON.stringify(run)),title:seed.title,createdAt:graph.createdAt,nodes:4,relations:3,
    request:{seed:{kind:'note',value:conceptPath},options:{...fixture.plugin.settings}}}];
  const immutableGraph = fixture.files.get(`${bundle.folder}/graph.json`), immutableNative = fixture.files.get(`${bundle.folder}/native.json`);
  return {title,graph,concept,webpage,conceptPath,webPath,sourcePath,parentPath,fullBody,conceptOriginal,code,bundle,immutableGraph,immutableNative};
}

test('built plugin merges owned duplicate nodes with backups, redirects indexed native links, and remembers aliases without reviving placeholders', async () => {
  const fixture = loadPlugin({nativeLinkRanges:true}); await fixture.plugin.onload();
  const f = setupDuplicateRun(fixture);
  await fixture.plugin.saveSettings();
  const pluginDataBefore = structuredClone(fixture.saves.at(-1));
  const conceptBefore = fixture.files.get(f.conceptPath)!, webBefore = fixture.files.get(f.webPath)!, parentBefore = fixture.files.get(f.parentPath)!;
  const plans = await fixture.plugin.duplicateMergePlan();
  assert.equal(plans.length,1); assert.equal(plans[0].from,f.conceptPath); assert.equal(plans[0].to,f.webPath);
  const folder = await fixture.plugin.applyDuplicateMerge(plans);
  assert.equal(fixture.files.has(f.conceptPath),false);
  assert.equal(fixture.trashed.length,1); assert.equal(fixture.trashed[0].path,f.conceptPath);
  assert.match(fixture.trashed[0].retained!,new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/source-\\d+\\.bak$`));
  assert.equal(fixture.files.get(fixture.trashed[0].retained!),conceptBefore);
  const merged = fixture.files.get(f.webPath)!;
  assert.ok(merged.includes(f.fullBody)); assert.ok(merged.includes('网页人工尾注必须保留。'));
  assert.ok(merged.includes('人工概念正文与补充事实必须保留。'));
  assert.ok(merged.includes('custom_review: "人工已核实身份"'));
  assert.ok(merged.includes('1966年的研究提到了日本电信电话公社。'));
  assert.equal(fixture.frontmatter(f.webPath)?.knowledge_seed_id,f.webpage.id);
  assert.ok(fixture.frontmatter(f.webPath)?.knowledge_seed_merged_ids.includes(f.concept.id));
  const parent = fixture.files.get(f.parentPath)!;
  const canonical = f.webPath.replace(/\.md$/,'');
  assert.ok(parent.includes(`[[${canonical}#关系与证据|机构历史]]`));
  assert.ok(parent.includes(`![[${canonical}]]`));
  assert.ok(parent.includes(f.code),'fenced and inline code references must remain literal');
  assert.ok(fixture.files.get(f.sourcePath)!.includes(`[[${canonical}|${f.title}]]`));
  const journal = JSON.parse(fixture.files.get(`${folder}/journal.json`)!);
  assert.equal(journal.status,'complete'); assert.equal(journal.completed.length,1);
  assert.deepEqual(journal.completed,[{from:f.conceptPath,to:f.webPath}]);
  const pluginDataBackup = JSON.parse(fixture.files.get(`${folder}/plugin-data-before.bak`)!);
  assert.deepEqual(pluginDataBackup,pluginDataBefore,'settings backup must restore the original history and current paths');
  assert.equal(pluginDataBackup.lastRun.rootPath,f.conceptPath);
  assert.equal(pluginDataBackup.history[0].request.seed.value,f.conceptPath);
  for (const [path,body] of [[f.conceptPath,conceptBefore],[f.webPath,webBefore],[f.parentPath,parentBefore]]) {
    const backup = journal.backups.find((entry:any)=>entry.path===path);
    assert.ok(backup); assert.match(backup.backup,/\.bak$/);
    assert.equal(fixture.files.get(`${folder}/${backup.backup}`),body);
  }
  assert.equal(fixture.files.get(`${f.bundle.folder}/graph.json`),f.immutableGraph);
  assert.equal(fixture.files.get(`${f.bundle.folder}/native.json`),f.immutableNative);
  assert.equal(fixture.plugin.lastRun.rootPath,f.webPath);
  assert.equal(fixture.plugin.lastRun.folder,folder);
  assert.equal(fixture.plugin.lastRun.nodePaths[f.concept.id],undefined,'current projection removes the duplicate identity');
  assert.equal(fixture.plugin.lastRun.nodePaths[f.webpage.id],f.webPath);
  const historical = fixture.plugin.history.find((record:any)=>record.run.folder===f.bundle.folder);
  assert.ok(historical); assert.equal(historical.run.rootPath,f.webPath);
  assert.equal(historical.run.nodePaths[f.concept.id],f.webPath);
  assert.equal(historical.request.seed.value,f.webPath);
  const projected = JSON.parse(fixture.files.get(`${folder}/graph.json`)!);
  assert.equal(projected.operation,'merge'); assert.equal(projected.mergedFromRun,f.bundle.folder);
  assert.ok(!projected.nodes.some((node:any)=>node.id===f.concept.id));
  assert.ok(projected.nodes.find((node:any)=>node.id===f.webpage.id).mergedIds.includes(f.concept.id));
  const projectedNative = JSON.parse(fixture.files.get(`${folder}/native.json`)!);
  assert.equal(projectedNative.rootPath,f.webPath); assert.equal(projectedNative.nodePaths[f.webpage.id],f.webPath);
  assert.equal(JSON.parse(fixture.files.get(`${folder}/COMPLETE.json`)!).status,'complete');
  const overview = fixture.files.get(`${folder}/Overview.md`);
  assert.ok(overview,'a completed merge must remain readable from exploration history');
  assert.ok(overview.includes(f.conceptPath) && overview.includes(f.webPath),'overview must explain the actual source and surviving paths');
  assert.ok(overview.includes('journal.json') && overview.includes('plugin-data-before.bak'),'overview must explain how note and plugin configuration backups restore the merge');
  assert.ok(!fixture.plugin.lastRun.search.includes('概念'));
  assert.equal((await fixture.plugin.duplicateMergePlan()).length,0);
  assert.equal(fixture.plugin.busy,false);
  // Persisting an old audit identity must reuse the alias even when no new URL
  // match is available in that graph. Native discovery also follows the new path.
  const discovered = await fixture.plugin.discover({kind:'note',value:f.sourcePath},()=>{}, {web:false,maxPages:0});
  assert.ok(discovered.nodes.some((node:any)=>node.locator===f.webPath));
  assert.ok(!discovered.nodes.some((node:any)=>node.locator===f.conceptPath));
  await fixture.plugin.persist(structuredClone(f.graph));
  assert.equal(fixture.files.has(f.conceptPath),false);
  assert.equal(fixture.plugin.lastRun.nodePaths[f.concept.id],undefined);
  assert.equal(fixture.plugin.lastRun.nodePaths[f.webpage.id],f.webPath);
  assert.equal([...fixture.files.keys()].filter(path=>path.startsWith('Knowledge Seed/概念/') && fixture.frontmatter(path)?.title===f.title).length,0);
  assert.ok(fixture.files.get(f.webPath)!.includes('人工概念正文与补充事实必须保留。'));
});

test('built duplicate merge rejects a hand edit made after preview before creating backups or archiving notes', async () => {
  const fixture = loadPlugin({nativeLinkRanges:true}); await fixture.plugin.onload(); const f = setupDuplicateRun(fixture);
  const plans = await fixture.plugin.duplicateMergePlan(); assert.equal(plans.length,1);
  fixture.files.set(f.conceptPath,fixture.files.get(f.conceptPath)!+'\n预览后新写的概念事实。\n');
  const before = new Map(fixture.files), created = fixture.created.length;
  await assert.rejects(fixture.plugin.applyDuplicateMerge(plans),/预览|候选|修改/);
  assert.deepEqual(fixture.files,before); assert.equal(fixture.created.length,created);
  assert.equal(fixture.trashed.length,0); assert.equal(fixture.plugin.busy,false);
});

test('built duplicate merge refuses a missing native link cache and leaves every source and target intact', async () => {
  const fixture = loadPlugin({nativeLinkRanges:true,missingCachePaths:['父笔记.md']}); await fixture.plugin.onload(); const f = setupDuplicateRun(fixture);
  const plans = await fixture.plugin.duplicateMergePlan(); assert.equal(plans.length,1);
  const before = new Map(fixture.files), created = fixture.created.length;
  await assert.rejects(fixture.plugin.applyDuplicateMerge(plans),/索引/);
  assert.deepEqual(fixture.files,before); assert.equal(fixture.created.length,created);
  assert.equal(fixture.trashed.length,0); assert.equal(fixture.plugin.busy,false);
  assert.ok(fixture.files.has(f.conceptPath)); assert.ok(fixture.files.has(f.webPath));
});

test('native property edits to ownership quotes and block-list aliases preserve one reusable real file',async()=>{
  const path='Knowledge Seed/概念/待补名词.md';
  const original="---\nknowledge_seed_id: 'concept-edited' # Native property edit\nknowledge_seed_merged_ids:\n  - concept-older\n  - 'concept-oldest'\ntitle: '待补名词'\nkind: 'concept'\nsource: 'https://zh.wikipedia.org/wiki/待补名词'\nreading_state: pending\n---\n\n# 待补名词\n\n手写定义必须保留。\n";
  const fixture=loadPlugin({metadataLag:true,extraFiles:{[path]:original}});await fixture.plugin.onload();
  await fixture.plugin.refreshManagedNotes();
  const ref=fixture.plugin.managedNotes.get(path);
  assert.ok(ref);assert.equal(ref.managedId,'concept-edited');
  assert.deepEqual(Array.from(ref.mergedIds),['concept-older','concept-oldest']);
  assert.equal(ref.kind,'concept');assert.equal(ref.title,'待补名词');assert.equal(ref.bodyAvailable,true);
  const graph:KnowledgeGraph={version:1,seed:'复用验证',createdAt:'2026-10-08T00:00:00Z',stats:{pagesAttempted:0,notesScanned:1,requests:0},warnings:[],
    nodes:[{id:'seed-reuse-edited',kind:'seed',title:'复用验证',status:'derived',excerpt:'',depth:0},
      {id:'concept-oldest',kind:'concept',title:'待补名词',status:'retrieved',excerpt:'手写定义必须保留。',depth:1}],
    edges:[{id:'owned-reuse-edge',from:'seed-reuse-edited',to:'concept-oldest',relation:'mentions',evidence:[{sourceId:'concept-oldest',quote:'手写定义必须保留。',method:'原文'}]}]};
  await fixture.plugin.persist(graph);
  assert.equal(fixture.plugin.lastRun.nodePaths['concept-oldest'],path);
  assert.ok(fixture.files.get(path)!.includes('手写定义必须保留。'));
  assert.equal([...fixture.files.keys()].filter(item=>item.endsWith('/待补名词.md')).length,1);
});

test('duplicate managed identity properties are excluded from reuse even when the metadata cache is stale',async()=>{
  const path='Knowledge Seed/概念/身份冲突.md';
  const fixture=loadPlugin({metadataLag:true,extraFiles:{[path]:'---\nknowledge_seed_id: concept-first\nknowledge_seed_id: concept-second\ntitle: 身份冲突\n---\n\n私有正文'}});
  await fixture.plugin.onload();await fixture.plugin.refreshManagedNotes();
  assert.equal(fixture.plugin.managedNotes.has(path),false);
  const before=fixture.files.get(path);
  const graph=await fixture.plugin.discover({kind:'topic',value:'知识图谱'},()=>{},{web:false});
  await fixture.plugin.persist(graph);
  assert.equal(fixture.files.get(path),before);
});

test('merged source alias chains remain reusable after reload and do not revive a second native node',async()=>{
  const fixture=loadPlugin({nativeLinkRanges:true});await fixture.plugin.onload();const f=setupDuplicateRun(fixture);
  fixture.files.set(f.conceptPath,fixture.files.get(f.conceptPath)!.replace('title:', 'knowledge_seed_merged_ids:\n  - concept-earlier-owner\n  - concept-oldest-owner\ntitle:'));
  const plans=await fixture.plugin.duplicateMergePlan();assert.equal(plans.length,1);
  await fixture.plugin.applyDuplicateMerge(plans);
  const reloaded=fixture.createPlugin();await reloaded.onload();await reloaded.refreshManagedNotes();
  assert.ok(reloaded.managedNotes.get(f.webPath)?.mergedIds.includes('concept-oldest-owner'));
  const graph=structuredClone(f.graph);
  graph.nodes=graph.nodes.filter(node=>node.id!==f.webpage.id).map(node=>node.id===f.concept.id?{...node,id:'concept-oldest-owner'}:node);
  graph.edges=graph.edges.filter(edge=>edge.to!==f.webpage.id).map(edge=>({...edge,to:edge.to===f.concept.id?'concept-oldest-owner':edge.to}));
  await reloaded.persist(graph);
  assert.equal(reloaded.lastRun.nodePaths['concept-oldest-owner'],f.webPath);
  assert.equal(fixture.files.has(f.conceptPath),false);
  assert.ok(fixture.files.get(f.webPath)!.includes(f.fullBody));
});

function savedReadingGraph():KnowledgeGraph{
  const url='https://zh.wikipedia.org/wiki/可靠性验证',body='可靠性验证需要保留完整原文与人工内容。'.repeat(140);
  const root:GraphNode={id:'seed-safe-save',kind:'seed',title:'可靠性验证',status:'derived',excerpt:'',depth:0};
  const source:GraphNode={id:nodeId('web',url),kind:'web',title:'可靠性验证正文',locator:url,status:'retrieved',excerpt:body.slice(0,200),depth:1,
    reading:{state:'ready'},article:{blocks:[{type:'paragraph',text:body}],textChars:body.length,totalTextChars:body.length,truncated:false}};
  return{version:1,seed:root.title,createdAt:'2026-10-08T00:00:00Z',nodes:[root,source],warnings:[],stats:{pagesAttempted:1,notesScanned:0,requests:1},
    edges:[{id:'safe-save-edge',from:root.id,to:source.id,relation:'seed_source',evidence:[{sourceId:source.id,quote:'可靠性验证',method:'实际正文'}]}]};
}

test('shipped save preflights a malformed final reading before creating any files or changing an earlier owner',async()=>{
  const fixture=loadPlugin();await fixture.plugin.onload();const graph=savedReadingGraph();await fixture.plugin.persist(graph);
  const source=fixture.plugin.lastRun.nodePaths[graph.nodes[1].id];
  fixture.files.set(source,fixture.files.get(source)!+'\n<!-- knowledge-seed:article:'+graph.nodes[1].id+':bad-marker -->\n');
  const before=new Map(fixture.files),created=fixture.created.length,history=fixture.plugin.history.length;
  await assert.rejects(fixture.plugin.persist(graph),/区块标记不完整/);
  assert.deepEqual(fixture.files,before);assert.equal(fixture.created.length,created);assert.equal(fixture.plugin.history.length,history);
  assert.equal(fixture.plugin.busy,false);
});

test('shipped partial save preserves old UTF-8 bodies and manual edits with exact backup and failure progress',async()=>{
  let sourcePath:string|undefined,rootPath:string|undefined,fail=false;
  const fixture=loadPlugin({onProcess:(path,files)=>{if(fail&&path===sourcePath){files.set(rootPath!,files.get(rootPath!)+'\n失败期间新增的人工编辑。');throw new Error('simulated source update failure');}}});
  await fixture.plugin.onload();const graph=savedReadingGraph();const originalFolder=await fixture.plugin.persist(graph);
  rootPath=fixture.plugin.lastRun.rootPath;sourcePath=fixture.plugin.lastRun.nodePaths[graph.nodes[1].id];
  fixture.files.set(sourcePath!,fixture.files.get(sourcePath!)+'\n人工尾注 😀\r\n原文格式保留。\n');
  const originals=new Map([[rootPath!,fixture.files.get(rootPath!)!],[sourcePath!,fixture.files.get(sourcePath!)!]]);
  const history=fixture.plugin.history.length;fail=true;
  await assert.rejects(fixture.plugin.persist(graph),/simulated source update failure/);
  const statusPath=[...fixture.files.keys()].find(path=>path.endsWith('/run-status.json')&&!path.startsWith(originalFolder+'/'))!;
  assert.ok(statusPath);const status=JSON.parse(fixture.files.get(statusPath)!);
  assert.equal(status.status,'partial');assert.deepEqual(status.updated,[rootPath]);assert.match(status.error,/source update failure/);
  const folder=statusPath.slice(0,-'/run-status.json'.length);
  for(const backup of status.backups)assert.equal(fixture.files.get(`${folder}/${backup.backup}`),originals.get(backup.path));
  assert.equal(status.backups.length,2);assert.ok(fixture.files.get(rootPath!)!.includes('失败期间新增的人工编辑。'));
  assert.equal(fixture.files.get(sourcePath!),originals.get(sourcePath!));
  assert.equal(fixture.files.has(`${folder}/COMPLETE.json`),false);assert.equal(fixture.plugin.history.length,history);
  assert.equal(fixture.plugin.lastRun.folder,originalFolder);assert.equal(fixture.plugin.busy,false);
});

test('shipped save refuses a human edit made after full preflight and retains both old backup and new user bytes',async()=>{
  let target:string|undefined,edit=false;
  const fixture=loadPlugin({onCreate:(path,files)=>{if(edit&&path.endsWith('/graph.json')){files.set(target!,files.get(target!)+'\n预检后新增人工事实。');edit=false;}}});
  await fixture.plugin.onload();const graph=savedReadingGraph();const first=await fixture.plugin.persist(graph);
  target=fixture.plugin.lastRun.rootPath;assert.ok(target);const before=fixture.files.get(target)!;edit=true;
  await assert.rejects(fixture.plugin.persist(graph),/预检后被编辑/);
  assert.equal(fixture.files.get(target),before+'\n预检后新增人工事实。');
  const statusPath=[...fixture.files.keys()].find(path=>path.endsWith('/run-status.json')&&!path.startsWith(first+'/'))!;
  const status=JSON.parse(fixture.files.get(statusPath)!);
  assert.deepEqual(status.updated,[]);assert.equal(status.status,'partial');
  const backup=status.backups.find((entry:{path:string})=>entry.path===target);
  assert.ok(backup);assert.equal(fixture.files.get(statusPath.slice(0,-'run-status.json'.length)+backup.backup),before);
});

test('same explicit source URL offers a reviewed merge after the originating run history has disappeared',async()=>{
  const fixture=loadPlugin({nativeLinkRanges:true});await fixture.plugin.onload();const f=setupDuplicateRun(fixture);
  fixture.files.set(f.conceptPath,fixture.files.get(f.conceptPath)!.replace('title:',`entity_url: ${JSON.stringify(f.webpage.locator)}\ntitle:`));
  fixture.plugin.history=[];fixture.plugin.lastRun=undefined;
  const plans=await fixture.plugin.duplicateMergePlan();assert.equal(plans.length,1);assert.equal(plans[0].to,f.webPath);
  await fixture.plugin.applyDuplicateMerge(plans);
  assert.equal(fixture.files.has(f.conceptPath),false);assert.ok(fixture.files.get(f.webPath)!.includes(f.fullBody));
  assert.ok(fixture.files.get(f.webPath)!.includes('人工概念正文与补充事实必须保留。'));
});

const backgroundPath = 'Knowledge Seed/概念/后台测试概念.md';
const backgroundOwner = 'concept-background-test';
const backgroundUrl = 'https://example.org/background-body';
const backgroundBody = '后台补全应完整保留来源段落，打开已有概念不必重复生成图谱，也不能覆盖人工修改。'.repeat(90);
function backgroundPlaceholder(source: string | null = backgroundUrl, owner = backgroundOwner): string {
  return `---\nknowledge_seed_id: ${JSON.stringify(owner)}\ntitle: "后台测试概念"\nkind: concept\nstatus: derived\nreading_state: pending\n${source ? `entity_url: ${JSON.stringify(source)}\n` : ''}custom_manual: keep\n---\n\n# 后台测试概念\n\n> 来源正文中的术语或链接名称，定义与语义关系待核实。\n\n## 关系与证据\n<!-- knowledge-seed:links:${owner} -->\n<!-- /knowledge-seed:links:${owner} -->\n`;
}
function backgroundHtml(): string {
  return '<!doctype html><html><head><title>后台测试概念</title></head><body><div class="mw-parser-output"><p>'
    + backgroundBody + '</p><h2>原文结构</h2><p>这是完整保留的第二个段落，原文件路径保持不变。</p></div></body></html>';
}
const backgroundResponse = (status = 200, text = backgroundHtml()) => ({ status, text, headers: { 'content-type': 'text/html; charset=utf-8' } });
function backgroundJobs(fixture: ReturnType<typeof loadPlugin>): any[] {
  const reader = fixture.plugin.backgroundReader;
  assert.ok(reader, 'background reader must be wired on load');
  return Array.from(typeof reader.jobs === 'function' ? reader.jobs() : reader.jobs);
}
async function waitBackground(fixture: ReturnType<typeof loadPlugin>, id: string | undefined, states = ['ready', 'no_match', 'failed', 'skipped', 'cancelled']): Promise<any> {
  assert.equal(typeof id, 'string', 'eligible concept must produce a task ID');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = backgroundJobs(fixture).find(item => item.id === id);
    if (job && states.includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`background task did not finish: ${JSON.stringify(backgroundJobs(fixture))}`);
}
async function waitCondition(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

test('a real file-open event fills one owned empty concept in place without navigating or creating graph nodes', async t => {
  const requests: string[] = [], original = backgroundPlaceholder();
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: original }, data: { web: true }, request: async url => {
    requests.push(url); return backgroundResponse(200, backgroundHtml().replace('</div>', '<p>来源还提及<a href="https://example.org/unselected-neighbour">另一个重要概念</a>，后台补全应保留其原文，但不能擅自创建相邻节点或扩展请求。</p></div>'));
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  assert.equal(fixture.plugin.settings.backgroundReading, true);
  const previousRun = { rootPath: '知识图谱.md', search: 'existing filter', folder: 'Knowledge Seed/Runs/existing' };
  fixture.plugin.lastRun = previousRun; fixture.plugin.history = [];
  const graphNotes = () => [...fixture.files.keys()].filter(path => path.endsWith('.md') && !path.startsWith('Knowledge Seed/Runs/')).sort();
  const markdownBefore = graphNotes();
  const leaf = fixture.addLeaf('tab', { type: 'markdown', state: { file: '知识图谱.md' } });
  const leafBefore = JSON.stringify(leaf.state);
  await fixture.emit('file-open', fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.deepEqual(requests, [], 'automatic background work is debounced instead of blocking the open event');
  await waitCondition(() => backgroundJobs(fixture).length > 0, 'file-open did not enqueue the concept');
  const job = await waitBackground(fixture, backgroundJobs(fixture)[0].id);
  assert.equal(job.state, 'ready'); assert.deepEqual(requests, [backgroundUrl]);
  const completed = fixture.files.get(backgroundPath)!;
  assert.ok(completed.includes(backgroundBody)); assert.ok(completed.includes('custom_manual: keep'));
  assert.equal(fixture.frontmatter(backgroundPath)?.knowledge_seed_id, backgroundOwner);
  assert.equal(fixture.frontmatter(backgroundPath)?.kind, 'web');
  assert.equal(fixture.frontmatter(backgroundPath)?.reading_state, 'ready');
  assert.deepEqual(graphNotes(), markdownBefore);
  assert.equal(fixture.leaves.length, 1); assert.equal(JSON.stringify(leaf.state), leafBefore);
  assert.deepEqual(fixture.plugin.lastRun, previousRun); assert.deepEqual(fixture.plugin.history, []);
  const artifacts = [...fixture.files].filter(([path]) => path.startsWith('Knowledge Seed/Runs/read-'));
  assert.ok(artifacts.some(([path, content]) => path.endsWith('.bak') && content === original), 'backup must retain all original bytes');
  assert.ok(artifacts.some(([path]) => path.endsWith('/reading.json')));
  assert.ok(artifacts.some(([path]) => /(?:status|journal|log)\.json$/.test(path)));
  assert.ok(artifacts.some(([path, content]) => path.endsWith('/COMPLETE.json') && JSON.parse(content).status === 'complete'));
  assert.ok(fixture.statusItems.length > 0);
  assert.equal(await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath)), undefined);
  assert.deepEqual(requests, [backgroundUrl], 'ready concepts never auto-refetch');
});

test('plugin load does not fetch an already active concept until a new file-open event occurs', async t => {
  let requests = 0;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    requests++; return backgroundResponse();
  } });
  await fixture.emit('file-open', fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(requests, 0); assert.deepEqual(backgroundJobs(fixture), []);
});

test('background qualification excludes user notes, readable definitions, disabled network and disabled automation', async t => {
  for (const scenario of ['user', 'readable', 'network-off', 'automatic-off', 'excluded'] as const) {
    const text = scenario === 'user' ? '# 后台测试概念\n\n这是普通用户笔记。'
      : backgroundPlaceholder() + (scenario === 'readable' ? '\n这是已有人工定义，必须保持。\n' : '');
    const fixture = loadPlugin({ extraFiles: { [backgroundPath]: text }, data: { web: scenario !== 'network-off' }, request: async () => {
      assert.fail(`unexpected request for ${scenario}`);
    } });
    await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
    if (scenario === 'automatic-off') fixture.plugin.settings.backgroundReading = false;
    if (scenario === 'excluded') fixture.plugin.settings.excludeFolders = ['Knowledge Seed/概念'];
    const before = new Map(fixture.files);
    const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
    assert.equal(id, undefined, scenario); assert.deepEqual(fixture.files, before, scenario);
    assert.deepEqual(backgroundJobs(fixture), [], scenario);
  }
});

test('duplicate opens share a task while manual retry refreshes a failed pass without its old request cache', async t => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void; let requests = 0;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    requests++; if (requests === 1) return new Promise(resolve => { release = resolve; });
    return backgroundResponse();
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const file = fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath);
  const first = await fixture.plugin.queueConceptBody(file, true);
  await waitCondition(() => requests === 1, 'first request did not start');
  const same = await fixture.plugin.queueConceptBody(file, true);
  assert.equal(same, first); assert.equal(backgroundJobs(fixture).length, 1); assert.equal(requests, 1);
  release(backgroundResponse(503, 'Service unavailable'));
  const failed = await waitBackground(fixture, first); assert.equal(failed.state, 'failed');
  assert.equal(fixture.frontmatter(backgroundPath)?.reading_state, 'failed');
  assert.ok(!fixture.files.get(backgroundPath)!.includes(backgroundBody));
  const automatic = await fixture.plugin.queueConceptBody(file);
  assert.equal(automatic, first, 'automatic reopens identify the existing cooldown task');
  assert.equal(backgroundJobs(fixture)[0].state, 'failed'); assert.equal(requests, 1);
  const retry = await fixture.plugin.retryConceptBody(backgroundPath);
  assert.equal((await waitBackground(fixture, retry)).state, 'ready');
  assert.equal(requests, 2); assert.ok(fixture.files.get(backgroundPath)!.includes(backgroundBody));
});

test('a source-less concept persists a confirmed empty search as no_match without fabricating a body', async t => {
  const requests: string[] = [];
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder(null) }, data: { web: true }, request: async url => {
    requests.push(url); assert.match(url, /^https:\/\/zh\.wikipedia\.org\/w\/api\.php\?/);
    return { status: 200, text: JSON.stringify({ query: { search: [] } }), headers: { 'content-type': 'application/json' } };
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath), true);
  assert.equal((await waitBackground(fixture, id)).state, 'no_match');
  assert.ok(requests.length > 0); assert.equal(fixture.frontmatter(backgroundPath)?.reading_state, 'no_match');
  assert.ok(!fixture.files.get(backgroundPath)!.includes('knowledge-seed:article:'));
  const requestCount = requests.length;
  assert.equal(await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath)), id);
  assert.equal(backgroundJobs(fixture)[0].state, 'no_match'); assert.equal(requests.length, requestCount);
});

test('an exact search resolution fills a source-less concept without renaming its native node or losing aliases', async t => {
  const requests: string[] = [], original = backgroundPlaceholder(null).replace('custom_manual:', 'knowledge_seed_merged_ids: ["concept-earlier-background"]\ncustom_manual:');
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: original }, data: { web: true }, request: async url => {
    requests.push(url);
    if (url.includes('/w/api.php?')) return { status: 200, text: JSON.stringify({ query: { search: [{ title: '后台测试概念' }] } }), headers: { 'content-type': 'application/json' } };
    assert.match(url, /^https:\/\/zh\.wikipedia\.org\/wiki\//); return backgroundResponse();
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  assert.equal((await waitBackground(fixture, id)).state, 'ready');
  assert.equal(requests.filter(url => url.includes('/w/api.php?')).length, 1);
  assert.equal(requests.filter(url => url.includes('/wiki/')).length, 1);
  const properties = fixture.frontmatter(backgroundPath)!;
  assert.equal(properties.knowledge_seed_id, backgroundOwner); assert.equal(properties.kind, 'web');
  assert.match(properties.source, /^https:\/\/zh\.wikipedia\.org\/wiki\//);
  assert.ok(properties.knowledge_seed_merged_ids.includes('concept-earlier-background'));
  assert.ok(fixture.files.get(backgroundPath)!.includes(backgroundBody));
  assert.ok(!fixture.created.some(path => path.endsWith('/后台测试概念.md')));
});

test('a same-source independent owner requires reviewed merging instead of silently duplicating its body', async t => {
  const sourcePath = 'Knowledge Seed/网页/已有独立正文.md';
  const sourceText = `---\nknowledge_seed_id: "web-independent-owner"\nkind: web\nsource: ${JSON.stringify(backgroundUrl)}\n---\n\n已有独立正文，不应复制出第二份。\n`;
  const original = backgroundPlaceholder();
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: original, [sourcePath]: sourceText }, data: { web: true }, request: async () => backgroundResponse() });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  const result = await waitBackground(fixture, id);
  assert.equal(result.state, 'failed'); assert.match(result.reason, /独立节点|重复|合并/);
  assert.equal(fixture.files.get(backgroundPath), original); assert.equal(fixture.files.get(sourcePath), sourceText);
  assert.deepEqual(fixture.processed, []);
});

test('foreground discovery can preempt a waiting background request and its late response remains discarded', async () => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void, started = false;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    started = true; return new Promise(resolve => { release = resolve; });
  } });
  await fixture.plugin.onload(); const before = new Map(fixture.files);
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  await waitCondition(() => started, 'background source did not start');
  const discovered = await fixture.plugin.discover({ kind: 'note', value: '知识图谱.md' }, () => {}, { web: false });
  assert.ok(discovered.nodes.some((node: any) => node.locator === '知识图谱.md'));
  assert.equal(fixture.plugin.busy, false);
  fixture.plugin.onunload(); release(backgroundResponse());
  await waitBackground(fixture, id, ['cancelled']); await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(fixture.files, before); assert.deepEqual(fixture.processed, []);
});

test('moving a concept during network reading skips the old task without recreating the old path', async t => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void, started = false;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    started = true; return new Promise(resolve => { release = resolve; });
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  await waitCondition(() => started, 'background source did not start');
  const movedPath = 'Knowledge Seed/概念/用户移动的概念.md', original = fixture.files.get(backgroundPath)!;
  fixture.files.delete(backgroundPath); fixture.files.set(movedPath, original); release(backgroundResponse());
  assert.equal((await waitBackground(fixture, id)).state, 'skipped');
  assert.equal(fixture.files.has(backgroundPath), false); assert.equal(fixture.files.get(movedPath), original);
  assert.deepEqual(fixture.processed, []);
});

test('background completion refuses any intervening definition or source edit and preserves the new user bytes', async t => {
  for (const change of ['definition', 'source'] as const) {
    let release!: (response: ReturnType<typeof backgroundResponse>) => void, started = false;
    const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
      started = true; return new Promise(resolve => { release = resolve; });
    } });
    await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
    const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath), true);
    await waitCondition(() => started, 'background source did not start');
    const edited = change === 'definition' ? fixture.files.get(backgroundPath)! + '\n等待时写入的个人定义。\n'
      : fixture.files.get(backgroundPath)!.replace(backgroundUrl, 'https://example.org/changed-source');
    fixture.files.set(backgroundPath, edited); release(backgroundResponse());
    assert.equal((await waitBackground(fixture, id)).state, 'skipped', change);
    assert.equal(fixture.files.get(backgroundPath), edited, change);
    assert.ok(!fixture.created.some(path => path.endsWith('/COMPLETE.json')), change);
  }
});

test('background completion refuses conflicting owners on two real paths before any network or note mutation', async t => {
  const copyPath = 'Knowledge Seed/概念/冲突副本.md';
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder(), [copyPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    assert.fail('duplicate owner must not issue a request');
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); const before = new Map(fixture.files);
  let id: string | undefined;
  try { id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath), true); }
  catch (error) { assert.match(String(error), /身份|重复|拥有|归属|冲突/); }
  if (id) assert.ok(['failed', 'skipped'].includes((await waitBackground(fixture, id)).state));
  assert.deepEqual(fixture.files, before); assert.deepEqual(fixture.processed, []);
});

test('unloading cancels a delayed background request and a late response cannot write or navigate', async () => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void, started = false;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    started = true; return new Promise(resolve => { release = resolve; });
  } });
  await fixture.plugin.onload(); const before = new Map(fixture.files);
  const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath), true);
  await waitCondition(() => started, 'background source did not start'); fixture.plugin.onunload();
  release(backgroundResponse()); await waitBackground(fixture, id, ['cancelled', 'skipped']);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(fixture.files, before); assert.deepEqual(fixture.processed, []); assert.deepEqual(fixture.leaves, []);
});

test('explicit task cancellation discards a late response and reopens do not restart the cancelled work', async t => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void, requests = 0;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true }, request: async () => {
    requests++; return new Promise(resolve => { release = resolve; });
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); const before = new Map(fixture.files);
  const file = fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath);
  const id = await fixture.plugin.queueConceptBody(file, true);
  await waitCondition(() => requests === 1, 'background source did not start');
  assert.equal(fixture.plugin.backgroundReader.cancel(id), true);
  release(backgroundResponse()); await waitBackground(fixture, id, ['cancelled']);
  const reopened = await fixture.plugin.queueConceptBody(file);
  assert.equal(reopened, id); await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(requests, 1); assert.deepEqual(fixture.files, before); assert.deepEqual(fixture.processed, []);
});

test('cancelling after backup creation still prevents a delayed source commit', async () => {
  let fixture!: ReturnType<typeof loadPlugin>;
  fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true },
    request: async () => backgroundResponse(), onCreate: path => { if (path.endsWith('.bak')) fixture.plugin.onunload(); } });
  await fixture.plugin.onload(); const original = fixture.files.get(backgroundPath)!;
  const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath), true);
  await waitBackground(fixture, id, ['cancelled', 'skipped']);
  assert.equal(fixture.files.get(backgroundPath), original);
  assert.ok(!fixture.processed.includes(backgroundPath));
  assert.ok(!fixture.created.some(path => path.endsWith('/COMPLETE.json')));
});

function storedBackgroundJob(state: string, id = 'restored-background-task', path = backgroundPath, ownerId = backgroundOwner) {
  return { id, path, ownerId, title: '后台测试概念', state, created: 100, updated: 200, attempt: 1,
    data: { manual: true, entityUrl: 'https://example.org/stale-history-payload', article: '不得从任务历史恢复的正文' } };
}

test('reload restores queued and reading jobs as interrupted metadata without executing stored payloads', async t => {
  const original = backgroundPlaceholder();
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: original }, data: { web: true, backgroundPaused: true,
    readingTasks: [storedBackgroundJob('queued'), storedBackgroundJob('reading', 'other-restored-task', 'Knowledge Seed/概念/另一个概念.md', 'concept-other')] },
    request: async () => { assert.fail('restoring task history must not read the network'); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  assert.equal(fixture.plugin.backgroundPaused, true); assert.equal(fixture.plugin.backgroundReader.paused, true);
  const jobs = backgroundJobs(fixture);
  assert.deepEqual(jobs.map(job => job.state), ['interrupted', 'interrupted']);
  assert.ok(jobs.every(job => job.data === undefined));
  await fixture.plugin.setBackgroundPaused(false);
  await new Promise(resolve => setTimeout(resolve, 410));
  assert.ok(backgroundJobs(fixture).every(job => job.state === 'interrupted'));
  assert.equal(fixture.files.get(backgroundPath), original); assert.deepEqual(fixture.processed, []);
  const persisted = fixture.saves.at(-1)!;
  assert.equal(persisted.backgroundPaused, false);
  assert.ok(persisted.readingTasks.every((job: any) => !Object.hasOwn(job, 'data')));
  assert.ok(!JSON.stringify(persisted.readingTasks).includes('stale-history-payload'));
  assert.ok(!JSON.stringify(persisted.readingTasks).includes('不得从任务历史恢复的正文'));
});

test('a persisted pause holds newly opened concepts until resume and terminal task metadata survives reload', async t => {
  let requests = 0;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() },
    data: { web: true, backgroundPaused: true }, request: async () => { requests++; return backgroundResponse(); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  await fixture.emit('file-open', fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  await waitCondition(() => backgroundJobs(fixture).length === 1, 'file-open did not queue a paused job');
  const id = backgroundJobs(fixture)[0].id;
  await new Promise(resolve => setTimeout(resolve, 410));
  assert.equal(requests, 0); assert.equal(backgroundJobs(fixture)[0].state, 'queued');
  assert.equal(fixture.saves.at(-1)?.backgroundPaused, true);
  await fixture.plugin.toggleBackgroundPause();
  assert.equal((await waitBackground(fixture, id)).state, 'ready'); assert.equal(requests, 1);
  await waitCondition(() => fixture.saves.at(-1)?.readingTasks?.some((job: any) => job.id === id && job.state === 'ready'), 'ready job was not persisted');
  const latest = fixture.saves.at(-1)!;
  assert.equal(latest.backgroundPaused, false);
  assert.ok(latest.readingTasks.every((job: any) => !Object.hasOwn(job, 'data')));
  fixture.plugin.onunload();
  const reloaded = fixture.createPlugin(); await reloaded.onload(); t.after(() => reloaded.onunload());
  assert.equal(reloaded.backgroundReader.jobs.find((job: any) => job.id === id).state, 'ready');
  await new Promise(resolve => setTimeout(resolve, 410)); assert.equal(requests, 1);
});

test('pausing an active read persists a queued task and discards its late response before a fresh resume', async t => {
  let release!: (response: ReturnType<typeof backgroundResponse>) => void, requests = 0;
  const original = backgroundPlaceholder();
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: original }, data: { web: true }, request: async () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { release = resolve; });
    return backgroundResponse(200, backgroundHtml().replace('后台补全应完整保留来源段落', '恢复后重新读取的有效段落'));
  } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  await waitCondition(() => requests === 1, 'active read did not start');
  await fixture.plugin.setBackgroundPaused(true);
  assert.equal(backgroundJobs(fixture)[0].state, 'queued');
  assert.equal(fixture.saves.at(-1)?.backgroundPaused, true);
  assert.equal(fixture.saves.at(-1)?.readingTasks.find((job: any) => job.id === id).state, 'queued');
  release(backgroundResponse(200, backgroundHtml().replace('后台补全应完整保留来源段落', '取消请求的过期段落')));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(fixture.files.get(backgroundPath), original); assert.equal(requests, 1);
  await fixture.plugin.setBackgroundPaused(false);
  assert.equal((await waitBackground(fixture, id)).state, 'ready'); assert.equal(requests, 2);
  assert.ok(fixture.files.get(backgroundPath)!.includes('恢复后重新读取的有效段落'));
  assert.ok(!fixture.files.get(backgroundPath)!.includes('取消请求的过期段落'));
});

test('retrying a restored job derives a fresh source from its current owned concept and ignores stale payload', async t => {
  const freshUrl = 'https://example.org/current-owned-source', requests: string[] = [];
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder(freshUrl) }, data: { web: true,
    readingTasks: [storedBackgroundJob('reading')] }, request: async url => { requests.push(url); return backgroundResponse(); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  assert.equal(backgroundJobs(fixture)[0].state, 'interrupted');
  const id = await fixture.plugin.retryBackgroundJob('restored-background-task');
  assert.equal(id, 'restored-background-task');
  assert.equal((await waitBackground(fixture, id)).state, 'ready');
  assert.deepEqual(requests, [freshUrl]);
  assert.equal(fixture.frontmatter(backgroundPath)?.source, freshUrl);
  assert.equal(fixture.frontmatter(backgroundPath)?.knowledge_seed_id, backgroundOwner);
});

test('retrying historical work refuses a changed owner and skips readable or ordinary current notes without network access', async t => {
  for (const scenario of ['owner', 'readable', 'ordinary', 'removed', 'excluded'] as const) {
    const original = scenario === 'owner' ? backgroundPlaceholder(backgroundUrl, 'concept-new-owner')
      : scenario === 'readable' ? backgroundPlaceholder() + '\n这是用户已经写好的实质性正文，不能再自动改写。\n'
      : scenario === 'ordinary' ? '# 后台测试概念\n\n用户普通笔记。\n' : backgroundPlaceholder();
    const fixture = loadPlugin({ extraFiles: scenario === 'removed' ? {} : { [backgroundPath]: original }, data: { web: true,
      readingTasks: [storedBackgroundJob('failed')] }, request: async () => { assert.fail(`${scenario}: historical retry must not issue requests`); } });
    await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
    if (scenario === 'excluded') fixture.plugin.settings.excludeFolders = ['Knowledge Seed/概念'];
    if (['owner', 'ordinary', 'removed'].includes(scenario)) {
      await assert.rejects(fixture.plugin.retryBackgroundJob('restored-background-task'), /归属|移动|删除|节点/);
    } else assert.equal(await fixture.plugin.retryBackgroundJob('restored-background-task'), undefined, scenario);
    assert.equal(fixture.files.get(backgroundPath), scenario === 'removed' ? undefined : original, scenario);
    assert.deepEqual(fixture.processed, [], scenario);
  }
});

test('a historical retry cannot switch owners between its first check and final queue eligibility', async t => {
  let targetReads = 0;
  const replacement = backgroundPlaceholder(backgroundUrl, 'concept-replaced-during-retry');
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true,
    readingTasks: [storedBackgroundJob('interrupted')] },
    onRead: (path, files) => { if (path === backgroundPath && ++targetReads === 2) files.set(path, replacement); },
    request: async () => { assert.fail('historical authorization must not transfer to a replacement owner'); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  await assert.rejects(fixture.plugin.retryBackgroundJob('restored-background-task'), /归属|节点|变化/);
  assert.equal(fixture.files.get(backgroundPath), replacement);
  assert.deepEqual(fixture.processed, []);
  assert.ok(backgroundJobs(fixture).every(job => job.ownerId === backgroundOwner));
});

test('automatic eligibility for a readable node reads only that node instead of scanning the vault', async t => {
  const extraFiles: Record<string, string> = { [backgroundPath]: backgroundPlaceholder() + '\n已有正文与个人说明。\n' };
  for (let i = 0; i < 60; i++) extraFiles[`Knowledge Seed/概念/无关节点${i}.md`] = backgroundPlaceholder(null, `concept-unrelated-${i}`);
  const fixture = loadPlugin({ extraFiles, data: { web: true }, request: async () => { assert.fail('already readable node must not be fetched'); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); fixture.reads.length = 0;
  const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.equal(id, undefined); assert.deepEqual(fixture.reads, [backgroundPath]);
  assert.equal(backgroundJobs(fixture).length, 0); assert.deepEqual(fixture.processed, []);
});

test('fresh paused eligibility remains cheap but duplicate owners are checked before the worker fetches', async t => {
  const copyPath = 'Knowledge Seed/概念/延迟识别的冲突副本.md';
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder(), [copyPath]: backgroundPlaceholder() },
    data: { web: true, backgroundPaused: true }, request: async () => { assert.fail('worker must reject a duplicate owner before network access'); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); fixture.reads.length = 0;
  const id = await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.equal(typeof id, 'string'); assert.deepEqual(fixture.reads, [backgroundPath]);
  assert.equal(backgroundJobs(fixture)[0].state, 'queued'); const before = new Map(fixture.files);
  await fixture.plugin.setBackgroundPaused(false);
  const result = await waitBackground(fixture, id);
  assert.equal(result.state, 'failed'); assert.match(result.reason, /身份|重复|合并/);
  assert.ok(fixture.reads.includes(copyPath)); assert.deepEqual(fixture.files, before); assert.deepEqual(fixture.processed, []);
});

test('settings saves use immutable snapshots and execute in call order even when an earlier write is delayed', async t => {
  let block = false, release!: () => void;
  const fixture = loadPlugin({ onSave: async () => { if (block) { block = false; await new Promise<void>(resolve => { release = resolve; }); } } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); await fixture.plugin.saveSettings();
  const start = fixture.saveStarted.length;
  fixture.plugin.settings.excludeFolders = ['First']; block = true;
  const first = fixture.plugin.saveSettings();
  await waitCondition(() => fixture.saveStarted.length === start + 1, 'first storage write did not start');
  fixture.plugin.settings.excludeFolders.push('Mutated after first call');
  fixture.plugin.settings.excludeFolders = ['Second'];
  const second = fixture.plugin.saveSettings();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fixture.saveStarted.length, start + 1, 'a later save overtook the delayed first write');
  release(); await Promise.all([first, second]);
  assert.deepEqual(fixture.saves.at(-2).excludeFolders, ['First']);
  assert.deepEqual(fixture.saves.at(-1).excludeFolders, ['Second']);
});

test('task progress persistence cannot overwrite newer settings and stores no reading payload', async t => {
  let holdStorage = false, releaseStorage!: () => void, releaseSource!: (response: ReturnType<typeof backgroundResponse>) => void;
  let requests = 0;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true },
    onSave: async () => { if (holdStorage) { holdStorage = false; await new Promise<void>(resolve => { releaseStorage = resolve; }); } },
    request: async () => { requests++; return new Promise(resolve => { releaseSource = resolve; }); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); await fixture.plugin.saveSettings();
  const start = fixture.saveStarted.length; holdStorage = true;
  const id = await fixture.plugin.retryConceptBody(backgroundPath);
  await waitCondition(() => requests === 1 && fixture.saveStarted.length === start + 1, 'task progress did not reach storage');
  fixture.plugin.settings.searchTerms = ['用户的新检索词'];
  const explicit = fixture.plugin.saveSettings(); fixture.plugin.backgroundReader.cancel(id);
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.equal(fixture.saveStarted.length, start + 1, 'autosave bypassed serialization');
  releaseStorage(); await explicit;
  await waitCondition(() => fixture.saves.at(-1)?.readingTasks?.some((job: any) => job.id === id && job.state === 'cancelled'), 'latest task state was not saved');
  assert.deepEqual(fixture.saves.at(-1).searchTerms, ['用户的新检索词']);
  const stored = fixture.saves.at(-1).readingTasks.find((job: any) => job.id === id);
  assert.ok(!Object.hasOwn(stored, 'data')); assert.ok(!JSON.stringify(stored).includes(backgroundBody));
  releaseSource(backgroundResponse()); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fixture.processed, []);
});

test('a failed settings write does not poison subsequent serialized saves', async t => {
  let failNext = false;
  const fixture = loadPlugin({ onSave: async () => { if (failNext) { failNext = false; throw new Error('temporary settings failure'); } } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload()); await fixture.plugin.saveSettings();
  fixture.plugin.settings.searchTerms = ['失败快照']; failNext = true;
  await assert.rejects(fixture.plugin.saveSettings(), /temporary settings failure/);
  fixture.plugin.settings.searchTerms = ['恢复后的设置'];
  await fixture.plugin.saveSettings();
  assert.deepEqual(fixture.saves.at(-1).searchTerms, ['恢复后的设置']);
});

test('selecting an already open Markdown concept tab starts user-priority body reading without a file-open event', async t => {
  const requests: string[] = [];
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder() }, data: { web: true },
    request: async url => { requests.push(url); return backgroundResponse(); } });
  const leaf = fixture.addLeaf('tab', { type: 'markdown', state: { file: backgroundPath } });
  fixture.setActiveFile(backgroundPath);
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  assert.equal(backgroundJobs(fixture).length, 0, 'load must not read the existing selected page');
  const leafState = JSON.stringify(leaf.getViewState());
  await fixture.emit('active-leaf-change', leaf);
  await waitCondition(() => backgroundJobs(fixture).length === 1, 'selecting the existing tab did not queue a concept');
  await waitCondition(() => requests.length === 1, 'selecting the tab did not start its user-priority body request');
  const result = await waitBackground(fixture, backgroundJobs(fixture)[0].id);
  assert.equal(result.state, 'ready'); assert.deepEqual(requests, [backgroundUrl]);
  assert.equal(fixture.frontmatter(backgroundPath)?.knowledge_seed_id, backgroundOwner);
  assert.ok(fixture.files.get(backgroundPath)!.includes(backgroundBody));
  assert.equal(fixture.processed.filter(path => path === backgroundPath).length, 1);
  assert.equal(JSON.stringify(leaf.getViewState()), leafState); assert.equal(fixture.leaves.length, 1);
});

test('tab selection ignores other view types and readable nodes while paired workspace events share one read and write', async t => {
  const readablePath = 'Knowledge Seed/概念/已有正文的页签.md';
  const readable = backgroundPlaceholder('https://example.org/already-readable', 'concept-tab-readable') + '\n已经存在的个人正文与阅读说明。\n';
  let requests = 0, release!: (response: ReturnType<typeof backgroundResponse>) => void;
  const fixture = loadPlugin({ extraFiles: { [backgroundPath]: backgroundPlaceholder(), [readablePath]: readable }, data: { web: true },
    request: async () => { requests++; return new Promise(resolve => { release = resolve; }); } });
  await fixture.plugin.onload(); t.after(() => fixture.plugin.onunload());
  fixture.setActiveFile(backgroundPath);
  for (const type of ['localgraph', 'canvas', 'empty']) await fixture.emit('active-leaf-change', { getViewState: () => ({ type }) });
  assert.equal(backgroundJobs(fixture).length, 0); assert.equal(requests, 0);
  fixture.setActiveFile(readablePath);
  await fixture.emit('active-leaf-change', { getViewState: () => ({ type: 'markdown', state: { file: readablePath } }) });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(backgroundJobs(fixture).length, 0); assert.equal(requests, 0);
  fixture.setActiveFile(backgroundPath);
  const file = fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath);
  const leaf = { getViewState: () => ({ type: 'markdown', state: { file: backgroundPath } }) };
  await Promise.all([fixture.emit('file-open', file), fixture.emit('active-leaf-change', leaf), fixture.emit('active-leaf-change', leaf)]);
  await waitCondition(() => backgroundJobs(fixture).length === 1, 'paired events did not share a job');
  await waitCondition(() => requests === 1, 'shared automatic read did not start');
  assert.equal(fixture.processed.length, 0);
  await Promise.all([fixture.emit('file-open', file), fixture.emit('active-leaf-change', leaf)]);
  assert.equal(backgroundJobs(fixture).length, 1); assert.equal(requests, 1);
  release(backgroundResponse());
  assert.equal((await waitBackground(fixture, backgroundJobs(fixture)[0].id)).state, 'ready');
  await fixture.emit('active-leaf-change', leaf);
  await new Promise(resolve => setTimeout(resolve, 410));
  assert.equal(requests, 1); assert.equal(backgroundJobs(fixture).length, 1);
  assert.equal(fixture.processed.filter(path => path === backgroundPath).length, 1);
  assert.equal(fixture.files.get(readablePath), readable);
});

const liveUrl='https://example.org/live-root';
const liveOverrides={readingMode:'manual',web:true,maxPages:1,depth:2,maxNotes:0,maxConcepts:6,searchLimit:0,linkLimit:12,backgroundReading:false};
const liveHtml=(title='增长中心',links:Array<{url:string;title:string}>=[])=>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${'这是可核验的正文段落，用来发现真实概念并保留原文结构。'.repeat(90)}</p>`
  +links.map(link=>`<p>这段完整正文详细介绍了<a href="${link.url}">${link.title}</a>的相关研究、来源定义、应用背景与实际知识联系。</p>`).join('')+'</article></body></html>';
const currentMap=(fixture:ReturnType<typeof loadPlugin>,id:string):LiveMapRecord=>fixture.plugin.liveMaps.find((map:LiveMapRecord)=>map.id===id);
test('an unsavable established graph cannot overwrite the last valid plugin data with a missing library entry',async t=>{
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>({status:200,text:liveHtml(),headers:{'content-type':'text/html'}})});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitLiveFinished(fixture,id);await fixture.plugin.saveSettings();
  const before=JSON.stringify(fixture.saves.at(-1)),writes=fixture.saveStarted.length,map=currentMap(fixture,id);
  const root=map.graph.nodes.find(node=>node.kind==='seed')!,source=map.graph.nodes.find(node=>node.kind!=='seed')!;
  map.graph.edges=Array.from({length:20001},(_,index)=>({id:`edge-${index}`,from:root.id,to:source.id,relation:'seed_source' as const,
    evidence:[{sourceId:source.id,quote:'真实来源',method:'网页'}]}));
  await assert.rejects(fixture.plugin.saveSettings(),/无法保存.*20000/);
  assert.equal(fixture.saveStarted.length,writes);assert.equal(JSON.stringify(fixture.saves.at(-1)),before);
  const restored=fixture.createPlugin();await restored.onload();t.after(()=>restored.onunload());
  assert.ok(restored.liveMaps.some((entry:LiveMapRecord)=>entry.id===id));
});
async function waitLiveFinished(fixture:ReturnType<typeof loadPlugin>,id:string):Promise<void> {
  await waitCondition(()=>!fixture.plugin.liveTasks.has(id),'live worker did not finish');
  assert.notEqual(currentMap(fixture,id).state,'failed',currentMap(fixture,id).message);
}

test('a failed live map resumes an unsaved dot-title concept without losing identities, prose or pruning',async t=>{
  const collisionPath='Knowledge Seed/概念/hack系列.md',ordinary='# 人工笔记\n\n这个同名文件由用户创建，内容必须保留。\n';
  const first=loadPlugin({extraFiles:{[collisionPath]:ordinary},data:{web:false,backgroundReading:false}});
  await first.plugin.onload();
  const id=await first.plugin.startLive({kind:'note',value:'知识图谱.md'},
    {readingMode:'manual',web:false,maxPages:0,maxConcepts:12,maxNotes:4});
  await waitLiveFinished(first,id);
  const failed=currentMap(first,id),root=failed.graph.nodes.find(node=>node.kind==='seed')!;
  const retainedIds=failed.graph.nodes.map(node=>node.id),retainedPaths={...failed.nodePaths};
  const conceptId='concept-dot-hack',source='https://zh.wikipedia.org/wiki/.hack';
  failed.graph.nodes.push({id:conceptId,kind:'concept',title:'.hack系列',entityUrl:source,
    excerpt:'来源正文提及 .hack系列，保留原始名称与来源。',status:'derived',depth:1});
  failed.graph.edges.push({id:'edge-dot-hack',from:root.id,to:conceptId,relation:'mentions',
    evidence:[{sourceId:root.id,quote:'来源正文提及 .hack系列。',method:'真实来源中的链接',locator:source}]});
  const excluded=retainedIds.find(nodeId=>nodeId!==root.id)!;
  assert.ok(excluded);failed.excludedIds=[excluded];
  failed.state='failed';failed.message='保存未完成：无效的库内笔记路径：Knowledge Seed/概念/.hack系列.md';
  const manual='\n\n## 人工备注\n\n继续探索后必须保留这段人工文字。\n';
  first.files.set(failed.rootPath,first.files.get(failed.rootPath)!+manual);
  await first.plugin.saveSettings();
  const data=JSON.parse(JSON.stringify(first.saves.at(-1))),originals=Object.fromEntries(first.files);
  first.plugin.onunload();
  const restored=loadPlugin({data,extraFiles:originals});
  await restored.plugin.onload();t.after(()=>restored.plugin.onunload());
  assert.equal(currentMap(restored,id).state,'failed');
  await restored.plugin.resumeLiveMap(id);await waitLiveFinished(restored,id);
  const map=currentMap(restored,id),concept=map.graph.nodes.find(node=>node.id===conceptId)!;
  assert.equal(map.state,'complete');assert.equal(map.id,id);assert.equal(map.rootPath,failed.rootPath);
  for(const oldId of retainedIds)assert.ok(map.graph.nodes.some(node=>node.id===oldId));
  for(const [oldId,path]of Object.entries(retainedPaths))assert.equal(map.nodePaths[oldId],path);
  assert.deepEqual([...map.excludedIds],[excluded]);
  assert.equal(concept.title,'.hack系列');assert.equal(concept.entityUrl,source);
  assert.equal(map.nodePaths[conceptId],'Knowledge Seed/概念/hack系列 (2).md');
  assert.ok(restored.files.get(map.nodePaths[conceptId])!.includes('# .hack系列'));
  assert.ok(restored.files.get(map.rootPath)!.includes(manual));
  assert.equal(restored.files.get(collisionPath),ordinary);
  assert.equal(restored.files.has('Knowledge Seed/概念/.hack系列.md'),false);
  assert.ok(restored.files.has(`${map.folder}/COMPLETE.json`));
  const reloaded=restored.createPlugin();await reloaded.onload();t.after(()=>reloaded.onunload());
  assert.equal(reloaded.liveMaps.find((item:LiveMapRecord)=>item.id===id)?.nodePaths[conceptId],map.nodePaths[conceptId]);
});

test('unloading a growing map cannot publish stale plugin data after a replacement instance saves',async()=>{
  let requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(()=>{});}});
  await fixture.plugin.onload();
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'source did not begin');
  const worker=fixture.plugin.liveTasks.get(id);
  const writesBefore=fixture.saveStarted.length;
  fixture.plugin.onunload();
  const replacement=fixture.createPlugin();await replacement.onload();
  replacement.settings.outputFolder='新输出目录';await replacement.saveSettings();
  await worker;await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(fixture.saveStarted.length,writesBefore+1,'only the replacement instance may start a save after unloading');
  assert.equal(fixture.saves.at(-1).outputFolder,'新输出目录');
  assert.equal(replacement.liveMaps[0].state,'interrupted','reload keeps unfinished work recoverable without automatically restarting it');
  replacement.onunload();
});

test('unloading drops a plugin data save that is still waiting behind an existing save',async()=>{
  let release!:()=>void,blocked=false;
  const fixture=loadPlugin({onSave:async()=>{if(!blocked){blocked=true;await new Promise<void>(resolve=>{release=resolve;});}}});
  await fixture.plugin.onload();
  const first=fixture.plugin.saveSettings();await waitCondition(()=>blocked,'first save did not start');
  fixture.plugin.settings.outputFolder='等待中的旧实例设置';
  const queued=fixture.plugin.saveSettings();
  fixture.plugin.onunload();release();await Promise.all([first,queued]);
  assert.equal(fixture.saveStarted.length,1,'a queued old-instance save cannot begin after unload');
  assert.notEqual(fixture.saves.at(-1).outputFolder,'等待中的旧实例设置');
});

test('background live growth respects an attached graph tab repurposed by the user',async t=>{
  for(const change of ['file','search','unpinned'] as const) {
    let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
    const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(resolve=>{release=resolve;});}});
    await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
    const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
    await waitCondition(()=>requests===1,'source did not begin');
    const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!;
    if(change==='file')leaf.state.state.file='来源核验.md';
    else if(change==='search')leaf.state.state.options.search='用户自己的筛选';
    else leaf.setPinned(false);
    const preserved=JSON.stringify(leaf.getViewState()),count=fixture.leaves.length;
    release(backgroundResponse(200,liveHtml('增长中心',[{url:'https://example.org/live-neighbour',title:'重要概念'}])));
    await waitLiveFinished(fixture,id);
    assert.equal(JSON.stringify(leaf.getViewState()),preserved,change);
    assert.equal(fixture.leaves.length,count,'background growth must not open a replacement tab');
    await fixture.plugin.openLiveMap(id);
    assert.equal(JSON.stringify(leaf.getViewState()),preserved,'explicit reopen also preserves the repurposed tab');
    assert.equal(fixture.leaves.length,count+1,'explicit reopen allocates a separate graph tab');
  }
});

test('a live library map recovers renamed owned files by identity without rewriting old checkpoints',async t=>{
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>backgroundResponse(200,liveHtml('可恢复起点',[{url:'https://example.org/moved-concept',title:'移动概念'}]))});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),sameMap=map,oldRoot=map.rootPath;
  const concept=map.graph.nodes.find(node=>node.kind==='concept')!,oldConcept=map.nodePaths[concept.id];
  concept.locator=oldConcept;map.seed={kind:'note',value:oldConcept};
  map.graph.edges[0].evidence[0].locator=oldConcept;
  const oldGraph=fixture.files.get(`${map.folder}/graph.json`),oldNative=fixture.files.get(`${map.folder}/native.json`);
  const newRoot='Knowledge Seed/起点/用户改名起点.md',newConcept='Knowledge Seed/概念/用户改名概念.md';
  const rootBytes=fixture.files.get(oldRoot),conceptBytes=fixture.files.get(oldConcept);
  await fixture.plugin.app.fileManager.renameFile(fixture.plugin.app.vault.getAbstractFileByPath(oldRoot),newRoot);
  await fixture.plugin.app.fileManager.renameFile(fixture.plugin.app.vault.getAbstractFileByPath(oldConcept),newConcept);
  await fixture.plugin.openLiveMap(id);
  assert.equal(currentMap(fixture,id),sameMap,'a running worker retains its map object');
  assert.equal(map.rootPath,newRoot);assert.equal(map.nodePaths[concept.id],newConcept);
  assert.equal(map.graph.nodes.find(node=>node.id===concept.id)?.locator,newConcept);
  assert.equal(map.seed.value,newConcept);assert.equal(map.graph.edges[0].evidence[0].locator,newConcept);
  assert.equal(fixture.files.get(newRoot),rootBytes);assert.equal(fixture.files.get(newConcept),conceptBytes);
  assert.equal(fixture.files.get(`${map.folder}/graph.json`),oldGraph);assert.equal(fixture.files.get(`${map.folder}/native.json`),oldNative);
  assert.ok(fixture.leaves.some(leaf=>leaf.state?.type==='localgraph'&&leaf.state.state.file===newRoot));
});

test('live path recovery refuses ambiguous owners and never guesses a moved root from its title',async t=>{
  for(const scenario of ['ambiguous','no-owner'] as const) {
    const fixture=loadPlugin();await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
    const id=await fixture.plugin.startLive({kind:'note',value:'知识图谱.md'},{readingMode:'manual',web:false,maxPages:0,maxConcepts:5,maxNotes:3});await waitLiveFinished(fixture,id);
    const map=currentMap(fixture,id),old=map.rootPath,root=fixture.files.get(old)!;
    const target='Knowledge Seed/起点/用户移动后的起点.md';
    if(scenario==='ambiguous')fixture.files.set(target,root);
    else {fixture.files.delete(old);fixture.files.set(target,root.replace(/^knowledge_seed_id:.*\n/m,''));}
    const before=JSON.stringify(map),bytes=new Map(fixture.files),views=fixture.viewStates.length;
    await assert.rejects(fixture.plugin.openLiveMap(id),scenario==='ambiguous'?/多个生成笔记/:/起点笔记已移动/);
    assert.equal(JSON.stringify(map),before);assert.deepEqual(fixture.files,bytes);assert.equal(fixture.viewStates.length,views);
  }
});

test('name cleanup remaps live map members, local evidence and note seeds while preserving source URLs',async t=>{
  const oldPath='Knowledge Seed/概念/脑科学-2c6b95a5.md';
  const body='---\nknowledge_seed_id: "concept-2c6b95a5"\ntitle: "脑科学"\nkind: concept\n---\n\n# 脑科学\n\n人工内容。';
  const fixture=loadPlugin({extraFiles:{[oldPath]:body,'.obsidian/app.json':'{"alwaysUpdateLinks":true}'}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'note',value:'知识图谱.md'},{readingMode:'manual',web:false,maxPages:0,maxConcepts:5,maxNotes:3});await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),root=map.graph.nodes.find(node=>node.kind==='seed')!;
  map.graph.nodes.push({id:'concept-2c6b95a5',managedId:'concept-2c6b95a5',kind:'concept',title:'脑科学',locator:oldPath,entityUrl:'https://example.org/brain',excerpt:'人工内容。',status:'derived',depth:1});
  map.nodePaths['concept-2c6b95a5']=oldPath;map.seed={kind:'note',value:oldPath};
  map.graph.edges.push({id:'brain-evidence',from:root.id,to:'concept-2c6b95a5',relation:'wiki_link',evidence:[{sourceId:'concept-2c6b95a5',quote:'人工内容。',method:'已有双链',locator:oldPath}]});
  const changes=await fixture.plugin.nameCleanupPlan();assert.equal(changes.length,1);
  await fixture.plugin.applyNameCleanup(changes);
  const target='Knowledge Seed/概念/脑科学.md';
  assert.equal(currentMap(fixture,id),map);assert.equal(map.nodePaths['concept-2c6b95a5'],target);assert.equal(map.seed.value,target);
  const moved=map.graph.nodes.find(node=>node.id==='concept-2c6b95a5')!;
  assert.equal(moved.locator,target);assert.equal(moved.entityUrl,'https://example.org/brain');
  assert.equal(map.graph.edges.at(-1)?.evidence[0].locator,target);assert.equal(fixture.files.get(target),body);
});

test('reviewed duplicate merging remaps live map paths without losing masks, identities or immutable checkpoints',async t=>{
  const fixture=loadPlugin({nativeLinkRanges:true});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const f=setupDuplicateRun(fixture),graph=structuredClone(f.graph);
  graph.nodes.find(node=>node.id===f.concept.id)!.locator=f.conceptPath;
  graph.edges[0].evidence[0].locator=f.conceptPath;
  const map:LiveMapRecord={id:'live-merge-paths',title:'预测编码',rootPath:f.bundle.rootPath,createdAt:graph.createdAt,updatedAt:graph.createdAt,
    state:'complete',graph,nodePaths:{...f.bundle.nodePaths},excludedIds:[f.concept.id],options:{...fixture.plugin.settings,generatedFolder:'Knowledge Seed'},
    seed:{kind:'note',value:f.conceptPath},folder:f.bundle.folder};
  fixture.plugin.liveMaps=[map];fixture.plugin.currentLiveId=map.id;
  fixture.plugin.lastRun={...fixture.plugin.lastRun,rootPath:map.rootPath};
  await fixture.plugin.openLiveMap(map.id);
  const identities=graph.nodes.map(node=>node.id),mask=[...map.excludedIds],sourceUrl=f.webpage.locator;
  await fixture.plugin.applyDuplicateMerge(await fixture.plugin.duplicateMergePlan());
  assert.equal(fixture.plugin.liveMaps[0],map);assert.equal(map.nodePaths[f.concept.id],f.webPath);assert.equal(map.seed.value,f.webPath);
  assert.equal(map.graph.nodes.find(node=>node.id===f.concept.id)?.locator,f.webPath);
  assert.equal(map.graph.nodes.find(node=>node.id===f.webpage.id)?.locator,sourceUrl);
  assert.equal(map.graph.edges[0].evidence[0].locator,f.webPath);assert.deepEqual(map.graph.nodes.map(node=>node.id),identities);assert.deepEqual(map.excludedIds,mask);
  const graphLeaf=fixture.leaves.find(leaf=>leaf.state?.type==='localgraph')!;
  assert.equal(graphLeaf.state.state.options.search,nativeSearch(visibleLiveGraph(map).nodes.map(node=>map.nodePaths[node.id])),'maintenance keeps the live scope instead of replacing it with the legacy union');
  await fixture.plugin.openLiveMap(map.id);
  assert.equal(fixture.files.get(`${f.bundle.folder}/graph.json`),f.immutableGraph);assert.equal(fixture.files.get(`${f.bundle.folder}/native.json`),f.immutableNative);
  await fixture.plugin.saveLiveSnapshot(map,new AbortController().signal);
  assert.equal(fixture.files.has(f.conceptPath),false,'the next live checkpoint cannot revive the archived concept');
  assert.deepEqual(map.excludedIds,mask,'saving a remapped map preserves its pruning mask');
});

test('a fresh topic seed cannot feed back through a same-label web mention while ordinary notes remain available',async t=>{
  const ordinaryPath='研究资料.md',ordinary='# 研究资料\n\n皇后乐队的个人研究笔记，保留用户自己的文字。\n';
  const auditPath='Knowledge Seed/Runs/old/Overview.md',audit='# 皇后乐队\n\n旧探索审计内容不应作为知识来源。\n';
  const song='Love of My Life (皇后乐队歌曲)',queenUrl='https://zh.wikipedia.org/wiki/Queen_(%E4%B9%90%E9%98%9F)';
  let observedFreshSeed=false;
  const fixture=loadPlugin({metadataLag:true,extraFiles:{[ordinaryPath]:ordinary,[auditPath]:audit},
    data:{web:true,backgroundReading:false},request:async url=>{
      const seedPath='Knowledge Seed/起点/皇后乐队.md';
      assert.ok(fixture.files.has(seedPath),'the initial seed is already saved before discovery requests');
      observedFreshSeed=true;
      if(url.includes('/w/api.php?'))return backgroundResponse(200,JSON.stringify({query:{search:[{title:song,snippet:'皇后乐队的歌曲与相关资料。'}]}}));
      assert.ok(url.includes('Love_of_My_Life_'));
      return backgroundResponse(200,liveHtml(song,[{url:queenUrl,title:'皇后乐队'}]));
    }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'topic',value:'皇后乐队'},
    {...liveOverrides,maxNotes:4,maxConcepts:20,searchLimit:3});
  await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),root=map.graph.nodes.find(node=>node.kind==='seed')!;
  assert.equal(map.state,'complete');assert.equal(map.rootPath,'Knowledge Seed/起点/皇后乐队.md');assert.ok(observedFreshSeed);
  assert.ok(!map.graph.nodes.some(node=>node.kind!=='seed'&&node.locator===map.rootPath),'the navigation seed is never a second local knowledge node');
  assert.equal(Object.values(map.nodePaths).filter(path=>path===map.rootPath).length,1);
  assert.ok(map.graph.nodes.some(node=>node.kind==='note'&&node.locator===ordinaryPath),'ordinary source notes still participate');
  const queen=map.graph.nodes.find(node=>node.entityUrl===queenUrl)!;
  assert.ok(queen);assert.notEqual(queen.id,root.id);assert.notEqual(map.nodePaths[queen.id],map.rootPath);
  const refs=fixture.plugin.adapter().listNotes();
  assert.ok(refs.some((ref:any)=>ref.path===ordinaryPath));
  assert.ok(!refs.some((ref:any)=>ref.path===map.rootPath||ref.path===auditPath),'owned seeds and run audit files stay outside discovery');
  assert.equal(fixture.files.get(ordinaryPath),ordinary);assert.equal(fixture.files.get(auditPath),audit);assert.equal(fixture.trashed.length,0);
  assert.ok(fixture.files.has(`${map.folder}/COMPLETE.json`));
});

test('restoring and expanding a failed map folds its unindexed root file view without losing manual prose or evidence',async t=>{
  const branchUrl='https://example.org/recovered-branch';
  const request=async(url:string)=>{
    assert.equal(url,liveUrl);return backgroundResponse(200,liveHtml('恢复起点',[{url:branchUrl,title:'已有分支'}]));
  };
  const first=loadPlugin({data:{web:true,backgroundReading:false},request});
  await first.plugin.onload();
  const id=await first.plugin.startLive({kind:'url',value:liveUrl},{...liveOverrides,maxNotes:4,maxConcepts:20});
  await waitLiveFinished(first,id);await first.plugin.saveSettings();first.plugin.onunload();
  const data=JSON.parse(JSON.stringify(first.saves.at(-1))),failed:LiveMapRecord=data.liveMaps.find((map:LiveMapRecord)=>map.id===id);
  const root=failed.graph.nodes.find(node=>node.kind==='seed')!,source=failed.graph.nodes.find(node=>node.kind==='web')!;
  const branch=failed.graph.nodes.find(node=>node.entityUrl===branchUrl)!;
  assert.ok(source);assert.ok(branch);
  const badId=nodeId('note',failed.rootPath);
  failed.state='failed';failed.message='保存未完成：生成节点路径冲突';
  failed.graph.nodes.push({id:badId,kind:'note',title:root.title,locator:failed.rootPath,depth:2,status:'retrieved',
    excerpt:'元数据缓存滞后时发现的起点文件视图',bodyAvailable:true});
  failed.nodePaths[badId]=failed.rootPath;
  failed.graph.edges.push(
    {id:'legacy-root-mention',from:source.id,to:badId,relation:'mentions',evidence:[{sourceId:source.id,quote:'旧来源明确提及起点名称。',method:'原文实际链接'}]},
    {id:'legacy-root-evidence',from:badId,to:branch.id,relation:'wiki_link',evidence:[{sourceId:badId,quote:'起点内原有分支关系。',method:'既有笔记双链'}]},
  );
  const manual='\n\n## 人工记录\n\n此处是用户写下的完整备注，探索恢复后必须原样保留。\n';
  const originals=Object.fromEntries(first.files);originals[failed.rootPath]+=manual;
  const ordinaryPath='用户原笔记.md',ordinary='# 原笔记\n\n独立的用户内容。\n';originals[ordinaryPath]=ordinary;
  let requests=0;
  const restored=loadPlugin({metadataLag:true,data,extraFiles:originals,request:async url=>{requests++;return request(url);}});
  await restored.plugin.onload();t.after(()=>restored.plugin.onunload());
  assert.equal(requests,0,'loading a failed map alone does not issue requests');
  assert.equal(currentMap(restored,id).state,'failed');
  await restored.plugin.expandLiveMap(id,failed.rootPath);await waitLiveFinished(restored,id);
  const map=currentMap(restored,id);
  assert.equal(map.state,'complete');assert.equal(map.rootPath,failed.rootPath);assert.ok(requests>0);
  assert.equal(map.graph.nodes.find(node=>node.kind==='seed')?.id,root.id);
  assert.ok(!map.graph.nodes.some(node=>node.id===badId));assert.equal(map.nodePaths[badId],undefined);
  assert.equal(Object.values(map.nodePaths).filter(path=>path===map.rootPath).length,1);
  assert.ok(map.graph.nodes.every(node=>!(node.mergedIds??[]).includes(badId)),'a path-derived file view does not become a permanent entity alias');
  const ids=new Set(map.graph.nodes.map(node=>node.id));
  for(const edge of map.graph.edges){
    assert.ok(ids.has(edge.from));assert.ok(ids.has(edge.to));assert.notEqual(edge.from,edge.to);
    for(const evidence of edge.evidence)assert.ok(ids.has(evidence.sourceId));
  }
  assert.ok(map.graph.edges.some(edge=>edge.from===source.id&&edge.to===root.id&&edge.evidence.some(evidence=>evidence.quote==='旧来源明确提及起点名称。')));
  assert.ok(map.graph.edges.some(edge=>edge.from===root.id&&edge.to===branch.id&&edge.evidence.some(evidence=>evidence.sourceId===root.id&&evidence.quote==='起点内原有分支关系。')));
  assert.ok(restored.files.get(map.rootPath)?.includes(manual));assert.equal(restored.files.get(ordinaryPath),ordinary);assert.equal(restored.trashed.length,0);
  assert.ok(restored.files.has(`${map.folder}/COMPLETE.json`));
  const requestsBefore=requests;
  await restored.plugin.expandLiveMap(id,map.rootPath);await waitLiveFinished(restored,id);
  assert.ok(requests>requestsBefore);assert.equal(map.rootPath,failed.rootPath);
  assert.ok(!map.graph.nodes.some(node=>node.id===badId));assert.equal(map.nodePaths[badId],undefined);
  assert.ok(restored.files.get(map.rootPath)?.includes(manual),'another exploration cannot resurrect the dropped view or alter manual prose');
});

test('live start opens a real seed graph before a delayed source and later updates the same leaf without activation or resetting options',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async url=>{
    assert.equal(url,liveUrl);requests++;return new Promise(resolve=>{release=resolve;});
  }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'live source request did not begin after opening graph');
  const map=currentMap(fixture,id),rootPath=map.rootPath;
  assert.ok(rootPath.endsWith('.md'));assert.ok(fixture.files.has(rootPath));assert.equal(map.state,'running');
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!;
  assert.ok(leaf);assert.ok(leaf.state.state.options.search.includes('起点'));
  assert.ok(fixture.leaves.some(item=>item.state?.type==='knowledge-seed-live-map'));
  const firstActivation=fixture.viewStates.find(item=>item.leaf===leaf)!;assert.equal(firstActivation.state.active,true);
  leaf.state.state.options={...leaf.state.state.options,showTags:true,showAttachments:true,repelStrength:7,centerStrength:0.3};
  leaf.state.state.customViewport={zoom:2,x:12};
  const leafCount=fixture.leaves.length,updatesBefore=fixture.viewStates.length;
  release(backgroundResponse(200,liveHtml('增长中心',[{url:'https://example.org/live-neighbour',title:'重要概念'}])));
  await waitLiveFinished(fixture,id);
  assert.equal(map.state,'complete');assert.equal(map.rootPath,rootPath);assert.equal(fixture.leaves.length,leafCount);
  assert.ok(map.graph.nodes.length>=3,JSON.stringify({nodes:map.graph.nodes.map(node=>({id:node.id,title:node.title,kind:node.kind,reading:node.reading})),edges:map.graph.edges,warnings:map.graph.warnings}));assert.equal(new Set(Object.values(map.nodePaths)).size,map.graph.nodes.length);
  assert.ok(leaf.state.state.options.search.includes('重要概念'));
  assert.equal(leaf.state.state.options.showTags,true);assert.equal(leaf.state.state.options.showAttachments,true);
  assert.equal(leaf.state.state.options.repelStrength,7);assert.deepEqual(leaf.state.state.customViewport,{zoom:2,x:12});
  assert.ok(fixture.viewStates.slice(updatesBefore).filter(item=>item.leaf===leaf).every(item=>item.state.active===false));
  assert.equal(fixture.trashed.length,0);
});

test('live graph binds the actual core-normalized state and immediately reveals the seed before discovery requests',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const normalize=(state:any)=>{
    state.state.options.search=`(${state.state.options.search})`;
    state.state.options.coreDefault=1;
    return state;
  };
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},normalizeNativeGraphState:normalize,request:async()=>{
    requests++;return new Promise(resolve=>{release=resolve;});
  }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'discovery did not start');
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!;
  assert.ok(fixture.loadedLeaves.includes(leaf),'a deferred native graph is loaded immediately');
  assert.ok(fixture.revealedLeaves.includes(leaf),'the seed graph is immediately brought into view');
  const before=fixture.viewStates.length,count=fixture.leaves.length;
  leaf.state.state.customViewport={zoom:3,x:7};
  release(backgroundResponse(200,liveHtml('自动显示中心',[{url:'https://example.org/instant-concept',title:'即时概念'}])));
  await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),expected=nativeSearch(visibleLiveGraph(map).nodes.map(node=>map.nodePaths[node.id]));
  assert.equal(leaf.state.state.options.search,`(${expected})`,'later checkpoints update the same bound native leaf without an extra open click');
  assert.equal(fixture.leaves.length,count);
  assert.deepEqual(leaf.state.state.customViewport,{zoom:3,x:7});
  assert.ok(fixture.viewStates.slice(before).filter(item=>item.leaf===leaf).every(item=>item.state.active===false));
});

test('core ignores a view-state pinned field, so live start pins the real leaf before note changes and automatic growth',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const fixture=loadPlugin({ignoreNativeStatePinned:true,data:{web:true,backgroundReading:false},request:async()=>{
    requests++;return new Promise(resolve=>{release=resolve;});
  }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'discovery did not start');
  const map=currentMap(fixture,id),root=map.rootPath,leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!;
  assert.equal(leaf.pinned,true,'the public leaf.setPinned operation fixes core note following');
  const before=fixture.viewStates.length,count=fixture.leaves.length;
  await fixture.emit('file-open',fixture.plugin.app.vault.getAbstractFileByPath('来源核验.md'));
  assert.equal(leaf.state.state.file,root,'opening another note never retargets the map center');
  release(backgroundResponse(200,liveHtml('真正固定的中心',[{url:'https://example.org/truly-pinned',title:'固定后新增概念'}])));
  await waitLiveFinished(fixture,id);
  assert.equal(leaf.state.state.file,root);
  assert.equal(leaf.state.state.options.search,nativeSearch(visibleLiveGraph(map).nodes.map(node=>map.nodePaths[node.id])));
  assert.ok(leaf.state.state.options.search.includes('固定后新增概念'),'newly found concepts reach the same native graph automatically');
  assert.equal(fixture.leaves.length,count);
  assert.ok(fixture.viewStates.slice(before).filter(item=>item.leaf===leaf).every(item=>item.state.active===false));
});

test('late metadata resolution refreshes only attached owned graph tabs and stops after unload',async t=>{
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>backgroundResponse(200,
    liveHtml('索引稍晚中心',[{url:'https://example.org/indexed-later',title:'索引稍晚概念'}]))});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!;
  const before=fixture.viewStates.length,count=fixture.leaves.length;
  leaf.state.state.customViewport={zoom:2,x:9};
  await fixture.emitMetadata('resolved');
  await waitCondition(()=>fixture.viewStates.length>before,'native graph was never refreshed after metadata links resolved');
  const updates=fixture.viewStates.slice(before);
  assert.ok(updates.every(item=>item.leaf===leaf&&item.state.active===false));
  assert.equal(leaf.state.state.options.search,nativeSearch(visibleLiveGraph(map).nodes.map(node=>map.nodePaths[node.id])));
  assert.deepEqual(leaf.state.state.customViewport,{zoom:2,x:9});
  assert.equal(fixture.leaves.length,count);
  leaf.state.state.options.search='用户自己的索引筛选';
  const repurposed=JSON.stringify(leaf.getViewState()),after=fixture.viewStates.length;
  await fixture.emitMetadata('resolved');await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(JSON.stringify(leaf.getViewState()),repurposed);assert.equal(fixture.viewStates.length,after);
  leaf.attached=false;
  await fixture.emitMetadata('resolved');await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(fixture.leaves.length,count,'a closed graph is not reopened on index events');
  await fixture.plugin.openLiveMap(id);
  const reopenedCount=fixture.viewStates.length;await fixture.emitMetadata('resolved');fixture.plugin.onunload();
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(fixture.viewStates.length,reopenedCount,'an unloaded plugin cancels pending graph refreshes');
});

test('stop followed immediately by continue replaces the aborted worker and preserves the same map and pruning mask',async t=>{
  const releases:Array<(response:ReturnType<typeof backgroundResponse>)=>void>=[];let requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(resolve=>{releases.push(resolve);});}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'first request did not start');
  const map=currentMap(fixture,id),root=map.rootPath,rootId=map.graph.nodes.find(node=>node.kind==='seed')!.id;
  map.excludedIds.push('concept-kept-cut');
  const stopped=fixture.plugin.stopLiveMap(id),continued=fixture.plugin.resumeLiveMap(id);
  await Promise.all([stopped,continued]);
  await waitCondition(()=>requests===2,'continuing reused an aborted controller instead of starting a new pass');
  assert.equal(currentMap(fixture,id),map);assert.equal(map.rootPath,root);
  assert.equal(map.graph.nodes.find(node=>node.kind==='seed')?.id,rootId);assert.equal(map.state,'running');
  releases[0](backgroundResponse(200,liveHtml('迟到的旧正文')));
  releases[1](backgroundResponse(200,liveHtml('继续探索后的正文',[{url:'https://example.org/resumed-only',title:'恢复后的概念'}])));
  await waitLiveFinished(fixture,id);
  assert.equal(map.state,'complete');assert.ok(map.excludedIds.includes('concept-kept-cut'));
  assert.ok([...fixture.files.values()].some(body=>body.includes('恢复后的概念')));
  assert.ok(![...fixture.files.values()].some(body=>body.includes('迟到的旧正文')));
  assert.equal(fixture.trashed.length,0);
});

test('saving a strategy at the live node cap succeeds without restarting or removing the existing graph',async t=>{
  let requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(()=>{});}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'discovery did not start');
  const map=currentMap(fixture,id),root=map.rootPath,ids=map.graph.nodes.map(node=>node.id);
  map.options.maxConcepts=visibleLiveGraph(map).nodes.filter(node=>node.kind!=='seed').length;
  assert.ok(map.options.maxConcepts>0);
  map.excludedIds.push('concept-previously-cut');
  await fixture.plugin.applyLiveStrategy(id,{...map.options,explorationStrategy:'breadth'});
  assert.equal(map.options.explorationStrategy,'breadth');assert.equal(map.rootPath,root);
  assert.deepEqual(map.graph.nodes.map(node=>node.id),ids);assert.ok(map.excludedIds.includes('concept-previously-cut'));
  assert.equal(requests,1,'saving at the cap does not start an impossible replacement pass');
  assert.ok(['complete','paused','cancelled','interrupted'].includes(map.state));
  assert.match(map.message??'',/上限/);
  assert.equal(fixture.trashed.length,0);
});

test('a user stop during a strategy save remains stopped instead of being overridden by automatic continuation',async t=>{
  let requests=0,holdSave=false,blocked=false,release!:()=>void;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(()=>{});},
    onSave:async data=>{
      if(holdSave&&!blocked&&data.liveMaps?.[0]?.state==='cancelled'){
        blocked=true;await new Promise<void>(resolve=>{release=resolve;});
      }
    }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'discovery did not start');
  const map=currentMap(fixture,id),root=map.rootPath;holdSave=true;
  const applying=fixture.plugin.applyLiveStrategy(id,{...map.options,explorationStrategy:'focused'});
  await waitCondition(()=>blocked,'the cancelled worker checkpoint was not held');
  const stopping=fixture.plugin.stopLiveMap(id);release();await Promise.all([applying,stopping]);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(map.options.explorationStrategy,'focused');assert.equal(map.rootPath,root);
  assert.equal(map.state,'cancelled');assert.equal(requests,1,'an explicit later stop prevents a replacement request');
  assert.equal(fixture.plugin.liveTasks.has(id),false);
  assert.equal(fixture.trashed.length,0);
});

test('a user pause during a strategy save remains paused after the old worker exits',async t=>{
  let requests=0,holdSave=false,blocked=false,release!:()=>void;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(()=>{});},
    onSave:async data=>{
      if(holdSave&&!blocked&&data.liveMaps?.[0]?.state==='cancelled'){
        blocked=true;await new Promise<void>(resolve=>{release=resolve;});
      }
    }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'discovery did not start');
  const map=currentMap(fixture,id),root=map.rootPath;holdSave=true;
  const applying=fixture.plugin.applyLiveStrategy(id,{...map.options,explorationStrategy:'depth'});
  await waitCondition(()=>blocked,'the old worker checkpoint was not held');
  await fixture.plugin.pauseLiveMap(id);release();await applying;
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(map.options.explorationStrategy,'depth');assert.equal(map.rootPath,root);
  assert.equal(map.state,'paused');assert.equal(requests,1,'an explicit later pause prevents automatic continuation');
  assert.equal(fixture.plugin.liveTasks.has(id),false);assert.equal(fixture.trashed.length,0);
});

test('a later user stop while resume reads owned paths prevents any replacement request or checkpoint',async t=>{
  let requests=0,stopOnRead=false,stopped=false,stopping:Promise<void>|undefined,id='';
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return backgroundResponse(200,liveHtml());},
    onRead:path=>{
      if(stopOnRead&&path===currentMap(fixture,id).rootPath){
        stopOnRead=false;stopped=true;
        // stopLiveMap records the user intent before its first await. The
        // reader callback must not wait on the save queue it is interrupting.
        stopping=fixture.plugin.stopLiveMap(id);
      }
    }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),root=map.rootPath;assert.equal(requests,1);
  await fixture.plugin.stopLiveMap(id);const before=new Map(fixture.files);
  stopOnRead=true;await fixture.plugin.resumeLiveMap(id);await stopping;
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(stopped,'the later stop occurs during owned-path recovery');
  assert.equal(map.rootPath,root);assert.equal(map.state,'cancelled');assert.equal(requests,1);
  assert.deepEqual(fixture.files,before,'a cancelled resume never publishes another checkpoint');
  assert.equal(fixture.plugin.liveTasks.has(id),false);assert.equal(fixture.trashed.length,0);
});

test('closing a growing graph never reopens it, and its library entry later reopens the saved scope with no requests',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(resolve=>{release=resolve;});}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitCondition(()=>requests===1,'source did not begin');
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!,count=fixture.leaves.length;
  leaf.attached=false;
  release(backgroundResponse(200,liveHtml('增长中心',[{url:'https://example.org/live-neighbour',title:'重要概念'}])));
  await waitLiveFinished(fixture,id);assert.equal(fixture.leaves.length,count);
  const files=new Map(fixture.files),saved=currentMap(fixture,id);
  await fixture.plugin.openLiveMap(id);
  assert.equal(requests,1);assert.deepEqual(fixture.files,files);
  const opened=fixture.leaves.filter(item=>item.attached&&item.state?.type==='localgraph');assert.equal(opened.length,1);
  assert.equal(opened[0].state.state.options.search,nativeSearch(visibleLiveGraph(saved).nodes.map(node=>saved.nodePaths[node.id])));
  assert.equal(fixture.plugin.currentLiveId,id);
});

test('a completed live map with pending bodies and an unfinished saved map never resume requests on plugin load',async t=>{
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>backgroundResponse(200,liveHtml('增长中心',[{url:'https://example.org/live-neighbour',title:'重要概念'}]))});
  await fixture.plugin.onload();const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);
  await waitLiveFinished(fixture,id);await fixture.plugin.saveSettings();fixture.plugin.onunload();
  const saved=JSON.parse(JSON.stringify(fixture.saves.at(-1)));
  assert.equal(saved.liveMaps[0].state,'complete');assert.ok(saved.liveMaps[0].graph.nodes.some((node:any)=>node.kind==='concept'));
  for(const state of ['complete','running'] as const) {
    let requests=0;
    const restored=loadPlugin({data:{...saved,backgroundReading:true,readingTasks:[],liveMaps:[{...saved.liveMaps[0],state}]},
      extraFiles:Object.fromEntries(fixture.files),request:async()=>{requests++;return backgroundResponse();}});
    await restored.plugin.onload();t.after(()=>restored.plugin.onunload());await new Promise(resolve=>setTimeout(resolve,430));
    assert.equal(requests,0,state);assert.equal(backgroundJobs(restored).length,0,state);
    assert.equal(restored.plugin.liveMaps[0].state,state==='running'?'interrupted':'complete');
    assert.equal(restored.leaves.length,0,'restoring a map does not steal the active page');
  }
});

test('live pause holds delayed results until resume, and stop permanently discards a later source response',async t=>{
  for(const operation of ['pause','stop'] as const) {
    let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
    const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(resolve=>{release=resolve;});}});
    await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
    const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitCondition(()=>requests===1,'request did not start');
    if(operation==='pause')await fixture.plugin.pauseLiveMap(id);else await fixture.plugin.stopLiveMap(id);
    const before=new Map(fixture.files),viewCount=fixture.viewStates.length;
    release(backgroundResponse(200,liveHtml()));await new Promise(resolve=>setTimeout(resolve,110));
    assert.deepEqual(fixture.files,before,operation);assert.equal(fixture.viewStates.length,viewCount,operation);
    if(operation==='pause') {
      assert.equal(currentMap(fixture,id).state,'paused');await fixture.plugin.resumeLiveMap(id);await waitLiveFinished(fixture,id);
      assert.equal(currentMap(fixture,id).state,'complete');assert.ok([...fixture.files.values()].some(body=>body.includes('这是可核验的正文段落')));
    }else {await waitLiveFinished(fixture,id);assert.equal(currentMap(fixture,id).state,'cancelled');}
  }
});

test('live pruning changes only the current map and a later discovery cannot restore its cut identity',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async()=>{requests++;return new Promise(resolve=>{release=resolve;});}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitCondition(()=>requests===1,'source did not start');
  const map=currentMap(fixture,id),target=map.graph.nodes.find(node=>node.kind!=='seed')!,path=map.nodePaths[target.id];
  assert.ok(path);const note=fixture.files.get(path),before=new Map(fixture.files);
  await fixture.plugin.pruneMap(id,path,false);assert.deepEqual(fixture.files,before);assert.equal(fixture.trashed.length,0);
  assert.ok(map.excludedIds.includes(target.id));assert.equal(visibleLiveGraph(map).nodes.some(node=>node.id===target.id),false);
  release(backgroundResponse(200,liveHtml('被剪节点的新正文',[{url:'https://example.org/new-cut-child',title:'不应出现的后代'}])));
  await waitLiveFinished(fixture,id);
  assert.equal(fixture.files.get(path),note);assert.equal(visibleLiveGraph(map).nodes.some(node=>node.id===target.id),false);
  assert.ok(![...fixture.files.values()].some(body=>body.includes('被剪节点的新正文')));
});

test('body reading survives a live checkpoint and accepts a managed-links-only append without losing new links or source paragraphs',async t=>{
  let release!:(response:ReturnType<typeof backgroundResponse>)=>void,requests=0;
  const fixture=loadPlugin({extraFiles:{[backgroundPath]:backgroundPlaceholder()},data:{web:true,backgroundReading:false},
    request:async()=>{requests++;return new Promise(resolve=>{release=resolve;});}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const job=await fixture.plugin.retryConceptBody(backgroundPath);await waitCondition(()=>requests===1,'body request did not start');
  const file=fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath),line='- → 已有双链 [[来源核验]]\n  - 来源：已经读取的实际关系证据';
  await fixture.plugin.app.vault.process(file,(content:string)=>mergeManagedLinks(content,backgroundOwner,[line]));
  const afterLinks=fixture.files.get(backgroundPath)!;
  const checkpoint:KnowledgeGraph={version:1,seed:'独立概念增长',createdAt:new Date().toISOString(),nodes:[{id:'seed-concurrent-growth',kind:'seed',title:'独立概念增长',depth:0,status:'derived',excerpt:''}],edges:[],warnings:[],stats:{pagesAttempted:0,notesScanned:0,requests:0}};
  const controller=new AbortController();fixture.plugin.liveWriting=true;
  try{await fixture.plugin.persist(checkpoint,{signal:controller.signal,saved:async()=>{await fixture.plugin.saveSettings();}});}finally{fixture.plugin.liveWriting=false;}
  assert.equal(backgroundJobs(fixture).find(item=>item.id===job).state,'reading','live disk checkpoint must not abort the independent body request');
  release(backgroundResponse());assert.equal((await waitBackground(fixture,job)).state,'ready');
  const written=fixture.files.get(backgroundPath)!;assert.ok(written.includes(backgroundBody));assert.ok(written.includes(line));
  assert.ok(written.includes('custom_manual: keep'));assert.equal(written.match(/\[\[来源核验\]\]/g)?.length,1);
  const audit=backgroundJobs(fixture).find(item=>item.id===job).auditFolder;
  assert.equal(fixture.files.get(`${audit}/backup/update-1.bak`),afterLinks,'body backup includes the latest legitimate concept links');
});

test('live expansion replaces an active growth worker, attaches to the chosen node and preserves the original root and total cap',async t=>{
  const rootResolvers:Array<(response:ReturnType<typeof backgroundResponse>)=>void>=[];let rootRequests=0;
  const branchUrl='https://example.org/branch-entry';
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async url=>{
    if(url===liveUrl){rootRequests++;if(rootRequests===1)return backgroundResponse(200,liveHtml('增长中心',[{url:branchUrl,title:'指定分支'}]));
      return new Promise(resolve=>{rootResolvers.push(resolve);});}
    if(url===branchUrl)return backgroundResponse(200,liveHtml('指定分支',[{url:'https://example.org/new-one',title:'新分支一'},{url:'https://example.org/new-two',title:'新分支二'},{url:'https://example.org/new-three',title:'新分支三'}]));
    return backgroundResponse(200,liveHtml('其他概念'));
  }});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},{...liveOverrides,maxConcepts:3});await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),rootPath=map.rootPath,rootId=map.graph.nodes.find(node=>node.kind==='seed')!.id;
  const branch=map.graph.nodes.find(node=>node.entityUrl===branchUrl)!;assert.ok(branch);
  await fixture.plugin.expandLiveMap(id,rootPath);await waitCondition(()=>rootRequests===2,'replacement root exploration did not start');
  assert.equal(map.state,'running');
  await fixture.plugin.expandLiveMap(id,map.nodePaths[branch.id],'统计学');await waitLiveFinished(fixture,id);
  assert.equal(map.rootPath,rootPath);assert.equal(map.graph.nodes.find(node=>node.kind==='seed')?.id,rootId);
  assert.ok(visibleLiveGraph(map).nodes.filter(node=>node.kind!=='seed').length<=3,'branch expansion cannot grow past the original map cap');
  assert.ok(map.options.searchTerms.includes('统计学'));
  const after=new Map(fixture.files);for(const resolve of rootResolvers)resolve(backgroundResponse(200,liveHtml('停止的旧增长结果')));
  await new Promise(resolve=>setTimeout(resolve,45));assert.deepEqual(fixture.files,after,'superseded growth responses never write late results');
});

test('live initialization rejects promptly when opening the core graph fails, retaining the saved seed checkpoint',async t=>{
  const fixture=loadPlugin({openFails:true,data:{web:true,backgroundReading:false},request:async()=>{assert.fail('no request before graph opens');}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  await assert.rejects(Promise.race([fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides),new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup hung')),1500))]),/UI unavailable/);
  assert.equal(fixture.plugin.liveMaps[0].state,'failed');assert.ok(fixture.files.has(fixture.plugin.liveMaps[0].rootPath));
});

test('stopping or cutting one live map cannot cancel a body still needed by another enabled map',async t=>{
  const fixture=loadPlugin({data:{web:true,backgroundReading:true},request:async()=>backgroundResponse()});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());fixture.plugin.backgroundReader.pause();
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitLiveFinished(fixture,id);
  const first=currentMap(fixture,id),node=first.graph.nodes.find(item=>item.kind==='concept')!;
  // The requested source is already web; add one actual owned empty node to both maps.
  const owned={id:backgroundOwner,managedId:backgroundOwner,title:'后台概念',kind:'concept' as const,status:'derived' as const,depth:1,excerpt:'',bodyAvailable:false,entityUrl:backgroundUrl};
  first.graph.nodes.push(owned);first.nodePaths[owned.id]=backgroundPath;fixture.files.set(backgroundPath,backgroundPlaceholder());
  await fixture.plugin.refreshManagedNotes();
  const second:LiveMapRecord={...first,id:'live-second-shared',nodePaths:{...first.nodePaths},excludedIds:[],graph:{...first.graph,nodes:first.graph.nodes.map(item=>({...item})),edges:[...first.graph.edges]},state:'complete'};
  fixture.plugin.liveMaps.push(second);fixture.plugin.liveEnabled.add(second.id);
  const job=await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath),false,backgroundOwner,first.id);
  assert.ok(job);await fixture.plugin.pruneMap(first.id,backgroundPath,false);
  assert.equal(backgroundJobs(fixture).find(item=>item.id===job).state,'queued');
  await fixture.plugin.stopLiveMap(first.id);assert.equal(backgroundJobs(fixture).find(item=>item.id===job).state,'queued');
  fixture.plugin.backgroundReader.resume();assert.equal((await waitBackground(fixture,job)).state,'ready');
  assert.ok(fixture.files.get(backgroundPath)?.includes(backgroundBody));
});

test('live map keeps its captured folder when global output changes, and body hydration uses that same original node',async t=>{
  const child='https://example.org/folder-child';
  const fixture=loadPlugin({data:{web:true,backgroundReading:false},request:async url=>backgroundResponse(200,url===liveUrl?liveHtml('原目录图谱',[{url:child,title:'目录内概念'}]):liveHtml('目录内概念'))});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'url',value:liveUrl},liveOverrides);await waitLiveFinished(fixture,id);
  const map=currentMap(fixture,id),root=map.rootPath,concept=map.graph.nodes.find(item=>item.entityUrl===child)!;
  const path=map.nodePaths[concept.id];assert.ok(path);fixture.plugin.settings.outputFolder='Other Output';
  await fixture.plugin.expandLiveMap(id,path);await waitLiveFinished(fixture,id);
  assert.equal(map.rootPath,root);assert.ok(Object.values(map.nodePaths).every(path=>path.startsWith('Knowledge Seed/')));
  assert.equal([...fixture.files.keys()].some(path=>path.startsWith('Other Output/')),false);
  assert.ok(fixture.files.get(path)?.includes('这是可核验的正文段落'));
});

test('a local-only live map does not silently enqueue public body lookups when global web reading is enabled',async t=>{
  let requests=0;
  const fixture=loadPlugin({data:{web:true,backgroundReading:true},extraFiles:{'本地起点.md':'# 本地知识\n\n解释知识与未创建概念的联系。[[没有正文的概念]]'},request:async()=>{requests++;throw Error('local map must not request');}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.startLive({kind:'note',value:'本地起点.md'},{readingMode:'manual',web:false,maxPages:0,depth:2,maxConcepts:5,maxNotes:3});
  await waitLiveFinished(fixture,id);await new Promise(resolve=>setTimeout(resolve,430));
  assert.equal(requests,0);assert.equal(backgroundJobs(fixture).length,0);
});

test('a new note-seed graph allocates a clearly named entry before discovery and preserves original notes, identities and legacy entry paths on continued exploration',async t=>{
  for(const scenario of['new','legacy'] as const) {
    const origin='用户笔记/学习科学.md',rootId=nodeId('seed',`note:${origin}`),noteId=nodeId('note',origin);
    const original='# 学习科学\n\n用户的完整正文与个人解释必须保留。[[来源核验]]\n',oldPath='Knowledge Seed/起点/旧学习入口.md';
    const legacy=`---\nknowledge_seed_id: ${JSON.stringify(rootId)}\ntitle: "学习科学"\nkind: seed\n---\n\n# 学习科学\n\n旧入口中的人工备注必须原样保留。\n\n<!-- knowledge-seed:links:${rootId} -->\n<!-- /knowledge-seed:links:${rootId} -->\n`;
    let initial:{path:string;ids:string[];title:string}|undefined;
    const fixture=loadPlugin({data:{web:false,backgroundReading:false},extraFiles:{[origin]:original,...(scenario==='legacy'?{[oldPath]:legacy}:{})},
      onCreate:path=>{if(path.startsWith('Knowledge Seed/起点/')&&path.endsWith('.md')&&!initial) {
        const graph=fixture.plugin.liveMaps[0].graph as KnowledgeGraph;
        initial={path,ids:[...graph.nodes.map(node=>node.id)],title:graph.nodes[0].title};
      }},request:async()=>{assert.fail('local note graph must not use the network');}});
    await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
    const id=await fixture.plugin.startLive({kind:'note',value:origin},{readingMode:'manual',web:false,maxPages:0,depth:2,maxConcepts:8,maxNotes:4});
    await waitLiveFinished(fixture,id);const map=currentMap(fixture,id);
    const expected=scenario==='new'?'Knowledge Seed/起点/学习科学(图谱入口).md':oldPath;
    assert.equal(map.rootPath,expected,scenario);assert.equal(map.nodePaths[rootId],expected,scenario);assert.equal(map.nodePaths[noteId],origin,scenario);
    if(scenario==='new') {
      assert.ok(initial);assert.equal(initial.path,expected);assert.deepEqual(initial.ids,[rootId]);assert.equal(initial.title,'学习科学');
      assert.ok(fixture.files.get(expected)?.includes('图谱入口'));assert.ok(fixture.files.get(expected)?.includes(`[[${origin.slice(0,-3)}|学习科学]]`));
    }else {
      assert.equal(initial,undefined,'an existing owned entry must not be renamed or recreated');
      assert.ok(fixture.files.get(expected)?.includes('旧入口中的人工备注必须原样保留。'));
      assert.equal(fixture.files.has('Knowledge Seed/起点/学习科学(图谱入口).md'),false);
    }
    assert.equal(map.graph.nodes.find(node=>node.id===rootId)?.title,'学习科学',scenario);assert.equal(map.seed.value,origin,scenario);
    assert.equal(fixture.files.get(origin),original,scenario);
    const choices=fixture.plugin.liveControls().paths(id);
    assert.equal(choices.find((node:any)=>node.path===expected)?.title,'学习科学（图谱入口）',scenario);
    assert.equal(choices.find((node:any)=>node.path===origin)?.title,'学习科学',scenario);
    const ids=map.graph.nodes.map(node=>node.id),paths={...map.nodePaths},manual='\n\n新增的人工入口备注必须保留。\n';
    fixture.files.set(expected,fixture.files.get(expected)!+manual);
    await fixture.plugin.resumeLiveMap(id);await waitLiveFinished(fixture,id);
    assert.deepEqual(map.graph.nodes.map(node=>node.id),ids,scenario);assert.deepEqual({...map.nodePaths},paths,scenario);
    assert.equal(map.rootPath,expected,scenario);assert.ok(fixture.files.get(expected)?.includes(manual),scenario);
    assert.equal(fixture.files.get(origin),original,scenario);assert.equal(map.graph.nodes.find(node=>node.id===rootId)?.title,'学习科学',scenario);
  }
});

async function startLocalTabMap(fixture:ReturnType<typeof loadPlugin>,title:string):Promise<LiveMapRecord> {
  const id=await fixture.plugin.startLive({kind:'topic',value:title},{readingMode:'manual',web:false,maxPages:0,depth:0,maxConcepts:0,maxNotes:0});
  await waitLiveFinished(fixture,id);return currentMap(fixture,id);
}
async function capturedNodeMenu(fixture:ReturnType<typeof loadPlugin>,path:string) {
  const items:Array<{title:string;click:()=>unknown}>=[];
  const menu={addItem:(create:(item:any)=>void)=>{
    const item={title:'',click:()=>undefined as unknown,
      setTitle(value:string){this.title=value;return this;},setIcon(){return this;},
      onClick(value:()=>unknown){this.click=value;return this;}};
    create(item);items.push(item);
  }};
  await fixture.emit('file-menu',menu,fixture.plugin.app.vault.getAbstractFileByPath(path));return items;
}

test('switching existing native graph tabs selects the matching sidebar map without reopening or writing notes',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const first=await startLocalTabMap(fixture,'页签第一图'),second=await startLocalTabMap(fixture,'页签第二图');
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph'&&item.state.state.file===first.rootPath)!;
  const before=new Map(fixture.files),count=fixture.leaves.length,updates=fixture.viewStates.length;
  let notifications=0;fixture.plugin.liveControls().subscribe(()=>notifications++);
  assert.equal(fixture.plugin.currentLiveId,second.id);
  await fixture.emit('active-leaf-change',leaf);
  assert.equal(fixture.plugin.liveControls().current().id,first.id);assert.equal(notifications,1);
  assert.deepEqual(fixture.files,before);assert.equal(fixture.leaves.length,count);assert.equal(fixture.viewStates.length,updates);
  await fixture.plugin.openLiveMap(first.id);assert.equal(fixture.leaves.length,count,'explicit reopen reuses the bound graph');
});

test('tab association respects the actual normalized core binding and never adopts a repurposed or unpinned graph',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false},normalizeNativeGraphState:state=>{
    state.state.options.search=`(${state.state.options.search})`;return state;
  }});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const first=await startLocalTabMap(fixture,'归一化第一图'),second=await startLocalTabMap(fixture,'归一化第二图');
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph'&&item.state.state.file===first.rootPath)!;
  await fixture.emit('active-leaf-change',leaf);assert.equal(fixture.plugin.currentLiveId,first.id);
  for(const change of ['search','file','pin']) {
    const prior=JSON.parse(JSON.stringify(leaf.state)),priorPin=leaf.pinned;
    fixture.plugin.currentLiveId=second.id;
    if(change==='search')leaf.state.state.options.search='用户自选范围';
    if(change==='file')leaf.state.state.file='来源核验.md';
    if(change==='pin'){leaf.pinned=false;leaf.state.pinned=false;}
    const manual=JSON.stringify(leaf.getViewState()),updates=fixture.viewStates.length;
    await fixture.emit('active-leaf-change',leaf);
    assert.equal(fixture.plugin.currentLiveId,second.id,change);assert.equal(JSON.stringify(leaf.getViewState()),manual,change);
    assert.equal(fixture.viewStates.length,updates,change);
    leaf.state=prior;leaf.pinned=priorPin;
  }
});

test('reload safely rebinds a unique fixed saved graph and reopens it without creating a duplicate tab',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();
  const first=await startLocalTabMap(fixture,'重启第一图'),second=await startLocalTabMap(fixture,'重启第二图');
  await fixture.plugin.saveSettings();fixture.plugin.onunload();
  const leaf=fixture.leaves.find(item=>item.state?.type==='localgraph'&&item.state.state.file===first.rootPath)!;
  (fixture.plugin.app.workspace as any).activeLeaf=leaf;
  const restored=fixture.createPlugin(),before=new Map(fixture.files),count=fixture.leaves.length;
  await restored.onload();t.after(()=>restored.onunload());
  assert.equal(restored.currentLiveId,first.id,'the visible saved graph determines the sidebar after reload');
  assert.notEqual(restored.currentLiveId,second.id);
  await restored.openLiveMap(first.id);assert.equal(fixture.leaves.length,count);
  assert.deepEqual(fixture.files,before);
});

test('unbound graph scopes shared by multiple map records or duplicate fixed tabs are never guessed',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const first=await startLocalTabMap(fixture,'重复范围图');
  const twin:LiveMapRecord={...first,id:'live-ambiguous-twin',graph:JSON.parse(JSON.stringify(first.graph)),nodePaths:{...first.nodePaths},excludedIds:[]};
  fixture.plugin.liveMaps.push(twin);fixture.plugin.currentLiveId=twin.id;
  fixture.plugin.liveLeaves.clear();fixture.plugin.liveLeafStates.clear();
  const existing=fixture.leaves.find(item=>item.state?.type==='localgraph')!,manual=JSON.stringify(existing.getViewState()),count=fixture.leaves.length;
  await fixture.emit('active-leaf-change',existing);assert.equal(fixture.plugin.currentLiveId,twin.id);
  await fixture.plugin.openLiveMap(first.id);assert.equal(fixture.leaves.length,count+1);
  assert.equal(JSON.stringify(existing.getViewState()),manual,'an ambiguous existing tab stays untouched');
  // A unique record with two matching unowned leaves is also ambiguous.
  fixture.plugin.liveMaps=[first];fixture.plugin.liveLeaves.clear();fixture.plugin.liveLeafStates.clear();
  const duplicateCount=fixture.leaves.length;await fixture.plugin.openLiveMap(first.id);
  assert.equal(fixture.leaves.length,duplicateCount+1);
});

test('shared-node menus prefer the currently selected visible map and report asynchronous command errors',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const first=await startLocalTabMap(fixture,'共享第一图'),second=await startLocalTabMap(fixture,'共享第二图');
  const path='来源核验.md',id=nodeId('note',path),shared:GraphNode={id,kind:'note',title:'共享节点',locator:path,depth:1,status:'discovered',excerpt:'已有笔记'};
  for(const map of[first,second]){map.graph.nodes.push({...shared});map.nodePaths[id]=path;}
  fixture.plugin.currentLiveId=first.id;
  const calls:string[]=[];fixture.plugin.pruneMap=async(mapId:string)=>{calls.push(mapId);};
  const items=await capturedNodeMenu(fixture,path),prune=items.find(item=>item.title.includes('从此图剪除'))!;
  assert.ok(prune);prune.click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[first.id]);assert.equal(items.filter(item=>item.title.includes('打开所属图谱')).length,1);
  fixture.plugin.expandLiveMap=async()=>{throw new Error('当前图谱已达到节点上限；先剪除不需要的节点。');};
  items.find(item=>item.title.includes('沿此节点继续探索'))!.click();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(fixture.notices.some(message=>message.includes('达到节点上限')));
  first.excludedIds.push(id);second.excludedIds.push(id);
  assert.equal((await capturedNodeMenu(fixture,path)).filter(item=>item.title.startsWith('Knowledge Seed：')).length,0,'a cut node has no stale map actions');
});

test('shared-node menus explicitly identify each graph when there is no current owning scope',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const first=await startLocalTabMap(fixture,'菜单第一图'),second=await startLocalTabMap(fixture,'菜单第二图');
  const path='来源核验.md',id=nodeId('note',path);
  for(const map of[first,second]){map.graph.nodes.push({id,kind:'note',title:'共享节点',locator:path,depth:1,status:'discovered',excerpt:'已有笔记'});map.nodePaths[id]=path;}
  fixture.plugin.currentLiveId=undefined;
  const items=await capturedNodeMenu(fixture,path),opens=items.filter(item=>item.title.includes('打开所属图谱'));
  assert.equal(opens.length,2);assert.ok(opens.some(item=>item.title.includes(first.title)));assert.ok(opens.some(item=>item.title.includes(second.title)));
  assert.notEqual(opens[0].title,opens[1].title);
});

test('opening a selected real node reuses its markdown tab and rejects cut or missing files without changing the graph',async t=>{
  const fixture=loadPlugin({data:{web:false,backgroundReading:false}});await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const map=await startLocalTabMap(fixture,'打开正文图'),path='来源核验.md',id=nodeId('note',path);
  map.graph.nodes.push({id,kind:'note',title:'来源核验',locator:path,depth:1,status:'discovered',excerpt:'已有笔记'});map.nodePaths[id]=path;
  const graphLeaf=fixture.leaves.find(item=>item.state?.type==='localgraph')!,state=JSON.stringify(graphLeaf.getViewState()),files=new Map(fixture.files);
  const controls=fixture.plugin.liveControls();await controls.openNote(map.id,path);
  const count=fixture.leaves.length;await controls.openNote(map.id,path);
  assert.equal(fixture.leaves.length,count);assert.equal(fixture.revealedLeaves.at(-1)?.state.state.file,path);
  assert.equal(JSON.stringify(graphLeaf.getViewState()),state);assert.deepEqual(fixture.files,files);
  map.excludedIds.push(id);await assert.rejects(controls.openNote(map.id,path),/不在当前图谱/);
  map.excludedIds=[];fixture.files.delete(path);await assert.rejects(controls.openNote(map.id,path),/移动或删除/);
});

async function createBackgroundBacklog(fixture:ReturnType<typeof loadPlugin>,count=30) {
  const map=await startLocalTabMap(fixture,'后台正文队列验收');
  map.options={...map.options,web:true,maxConcepts:count,generatedFolder:'Knowledge Seed'};
  const root=map.graph.nodes.find(node=>node.kind==='seed')!;
  const entries=Array.from({length:count},(_,index)=>({path:`Knowledge Seed/概念/排队验收${index}.md`,
    owner:`concept-backlog-${index}`,url:`https://example.org/background-backlog/${index}`}));
  for(const entry of entries) {
    fixture.files.set(entry.path,backgroundPlaceholder(entry.url,entry.owner));
    map.graph.nodes.push({id:entry.owner,managedId:entry.owner,kind:'concept',title:'后台测试概念',entityUrl:entry.url,
      locator:entry.path,bodyAvailable:false,depth:1,status:'derived',excerpt:'来源正文中的术语或链接名称，定义与语义关系待核实。',reading:{state:'pending'}});
    map.nodePaths[entry.owner]=entry.path;
    map.graph.edges.push({id:`edge-backlog-${entry.owner}`,from:root.id,to:entry.owner,relation:'mentions',
      evidence:[{sourceId:root.id,quote:'真实来源提及该概念，等待独立正文读取。',method:'来源正文明确提及',locator:entry.url}]});
  }
  await fixture.plugin.refreshManagedNotes();fixture.plugin.liveEnabled.add(map.id);
  return {map,entries};
}

test('opening a concept behind 24 automatic tasks admits it first and clears every map attempt for displaced automatic work',async t=>{
  const requests:string[]=[];let release!:(response:ReturnType<typeof backgroundResponse>)=>void;
  const fixture=loadPlugin({data:{web:true,backgroundReading:true,backgroundPaused:true},request:async url=>{
    requests.push(url);return requests.length===1?new Promise(resolve=>{release=resolve;}):backgroundResponse();
  }});
  await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.(backgroundResponse());});
  const {map,entries}=await createBackgroundBacklog(fixture),selected=entries[24];
  fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>backgroundJobs(fixture).length===24&&!fixture.plugin.liveBodyFeeding,'automatic queue did not fill its hard capacity');
  const queuedBefore=backgroundJobs(fixture),originals=new Map(fixture.files);
  const second:LiveMapRecord={...map,id:'live-backlog-shared',state:'paused',nodePaths:{...map.nodePaths},excludedIds:[],
    graph:{...map.graph,nodes:map.graph.nodes.map(node=>({...node})),edges:[...map.graph.edges]}};
  fixture.plugin.liveMaps.push(second);
  for(const job of queuedBefore)fixture.plugin.liveBodyAttempted.add(`${second.id}:${job.path}:${job.ownerId}`);
  await fixture.emit('file-open',fixture.plugin.app.vault.getAbstractFileByPath(selected.path));
  await waitCondition(()=>backgroundJobs(fixture).some(job=>job.path===selected.path),'the opened concept was rejected behind automatic backlog');
  await waitCondition(()=>!fixture.plugin.liveBodyFeeding,'refill did not settle after user admission');
  const after=backgroundJobs(fixture),displaced=queuedBefore.filter(job=>!after.some(current=>current.id===job.id));
  assert.equal(after.length,24);assert.equal(displaced.length,1);assert.deepEqual(requests,[]);
  for(const current of[map,second])assert.equal(fixture.plugin.liveBodyAttempted.has(`${current.id}:${displaced[0].path}:${displaced[0].ownerId}`),false,
    'displaced work must remain eligible when a later slot becomes available');
  assert.deepEqual(fixture.files,originals,'admission alone does not change any note bytes');
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
  await waitCondition(()=>requests.length===1,'opened concept did not begin reading');
  assert.equal(requests[0],selected.url,'user-opened content reads ahead of the older automatic queue');
  release(backgroundResponse());
  await waitCondition(()=>backgroundJobs(fixture).some(job=>job.path===displaced[0].path&&job.id!==displaced[0].id),
    'displaced automatic work was not re-enqueued after the opened concept freed a slot');
  assert.ok(fixture.files.get(selected.path)?.includes(backgroundBody));
  for(const path of['知识图谱.md','来源核验.md'])assert.equal(fixture.files.get(path),originals.get(path));
});

test('manual retry against a full user queue reports its real capacity error and preserves terminal history and note bytes',async t=>{
  const waiting=Array.from({length:24},(_,index)=>({path:`Knowledge Seed/概念/用户等待${index}.md`,owner:`concept-user-waiting-${index}`}));
  const extraFiles={...Object.fromEntries(waiting.map((entry,index)=>[entry.path,backgroundPlaceholder(`https://example.org/user-waiting/${index}`,entry.owner)])),
    [backgroundPath]:backgroundPlaceholder()};
  let requests=0;
  const fixture=loadPlugin({extraFiles,data:{web:true,backgroundPaused:true,readingTasks:[storedBackgroundJob('no_match')]},
    request:async()=>{requests++;return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  for(const entry of waiting)assert.ok(await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(entry.path),false,entry.owner,undefined,true));
  const before=JSON.stringify(backgroundJobs(fixture)),originals=new Map(fixture.files);
  await assert.rejects(fixture.plugin.retryBackgroundJob('restored-background-task'),/后台正文队列已满/);
  assert.equal(JSON.stringify(backgroundJobs(fixture)),before);
  fixture.setActiveFile(backgroundPath);
  assert.equal(fixture.plugin.commands.find((command:any)=>command.id==='read-current-concept').checkCallback(false),true);
  await waitCondition(()=>fixture.notices.some(message=>message.includes('后台正文队列已满')),'manual reading command swallowed its capacity error');
  assert.ok(!fixture.notices.some(message=>message.includes('当前笔记已有正文')),'queue overflow must not claim this empty concept is already readable');
  assert.equal(JSON.stringify(backgroundJobs(fixture)),before);assert.deepEqual(fixture.files,originals);assert.equal(requests,0);
});

test('continuing paused body reading during a busy live save clears the pause and waits for the existing gate to reopen',async t=>{
  const original=backgroundPlaceholder(),requests:string[]=[];
  const fixture=loadPlugin({extraFiles:{[backgroundPath]:original},data:{web:true,backgroundPaused:true},
    request:async url=>{requests.push(url);return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const id=await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.ok(id);fixture.plugin.busy=true;
  await fixture.plugin.setBackgroundPaused(false);
  assert.equal(fixture.plugin.backgroundPaused,false);assert.equal(fixture.plugin.backgroundReader.paused,false);
  await new Promise(resolve=>setTimeout(resolve,410));
  assert.deepEqual(requests,[]);assert.equal(backgroundJobs(fixture).find(job=>job.id===id)?.state,'queued');
  assert.equal(fixture.files.get(backgroundPath),original);
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
  assert.equal((await waitBackground(fixture,id)).state,'ready');assert.deepEqual(requests,[backgroundUrl]);
  assert.ok(fixture.files.get(backgroundPath)?.includes(backgroundBody));
  assert.ok(fixture.files.get(backgroundPath)?.includes('custom_manual: keep'));
});

test('cancel-all pauses a live backlog beyond 24 tasks without refill or new requests, and explicit continue only admits remaining uncancelled concepts',async t=>{
  const requests:string[]=[];
  const fixture=loadPlugin({data:{web:true,backgroundReading:true,backgroundPaused:true},request:async url=>{requests.push(url);return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const {map,entries}=await createBackgroundBacklog(fixture),originals=new Map(fixture.files),nodeIds=map.graph.nodes.map(node=>node.id);
  fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>backgroundJobs(fixture).length===24&&!fixture.plugin.liveBodyFeeding,'automatic backlog did not reach its pending capacity');
  const cancelled=backgroundJobs(fixture).map(job=>({id:job.id,path:job.path}));
  await fixture.plugin.cancelBackgroundTasks();
  assert.equal(fixture.plugin.backgroundPaused,true);assert.equal(fixture.plugin.backgroundReader.paused,true);
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();await fixture.plugin.feedLiveBodies();
  await new Promise(resolve=>setTimeout(resolve,410));
  assert.equal(backgroundJobs(fixture).length,24);assert.ok(backgroundJobs(fixture).every(job=>job.state==='cancelled'));
  assert.deepEqual(requests,[]);assert.deepEqual(fixture.files,originals);
  assert.equal(fixture.saves.at(-1).backgroundPaused,true);
  fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>backgroundJobs(fixture).filter(job=>job.state==='queued').length===entries.length-24&&!fixture.plugin.liveBodyFeeding,
    'explicit continue did not refill the remaining discovered concepts');
  for(const job of cancelled)assert.equal(backgroundJobs(fixture).find(current=>current.id===job.id)?.state,'cancelled',
    'explicitly cancelled tasks require their own retry rather than silently reopening');
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
  await waitCondition(()=>backgroundJobs(fixture).filter(job=>job.state==='ready').length===entries.length-24,'remaining concept bodies did not complete');
  assert.equal(requests.length,entries.length-24);
  for(const job of cancelled)assert.equal(fixture.files.get(job.path),originals.get(job.path));
  assert.deepEqual(map.graph.nodes.map(node=>node.id),nodeIds,'body work cannot create or remove graph members');
  for(const path of['知识图谱.md','来源核验.md',map.rootPath])assert.equal(fixture.files.get(path),originals.get(path));
  const count=requests.length;
  await fixture.emit('file-open',fixture.plugin.app.vault.getAbstractFileByPath(cancelled[0].path));
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(requests.length,count,'reopening a cancelled body stays quiet');
});

test('cancelling while automatic feed awaits a note read blocks that late enqueue and leaves the entire discovered graph untouched',async t=>{
  let requests=0,reading=false,release!:()=>void;
  const fixture=loadPlugin({data:{web:true,backgroundReading:true,backgroundPaused:true},request:async()=>{requests++;return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.();});
  const {map,entries}=await createBackgroundBacklog(fixture),originals=new Map(fixture.files),before=JSON.stringify(map.graph);
  const read=fixture.plugin.app.vault.read.bind(fixture.plugin.app.vault);
  fixture.plugin.app.vault.read=async(file:any)=>{
    if(file.path===entries[0].path&&!reading){reading=true;await new Promise<void>(resolve=>{release=resolve;});}
    return read(file);
  };
  fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>reading,'automatic feed did not enter the slow eligibility read');
  await fixture.plugin.cancelBackgroundTasks();release();
  await waitCondition(()=>!fixture.plugin.liveBodyFeeding,'in-flight automatic feed did not settle after cancellation');
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
  await new Promise(resolve=>setTimeout(resolve,410));
  assert.equal(backgroundJobs(fixture).length,0,'a late eligibility read cannot enqueue after cancel-and-pause');
  assert.equal(requests,0);assert.deepEqual(fixture.files,originals);assert.equal(JSON.stringify(map.graph),before);
});

test('revealing an already active Markdown concept directly promotes its queued body without duplicate opens or workspace events',async t=>{
  const waiting=Array.from({length:23},(_,index)=>({path:`Knowledge Seed/概念/复用页签等待${index}.md`,owner:`concept-tab-waiting-${index}`}));
  const manualPath='Knowledge Seed/概念/已有人工正文.md',manual=backgroundPlaceholder(null,'concept-existing-manual')+'\n用户已经写好的定义、阅读理解与个人事实必须保持完整。\n';
  const extraFiles={...Object.fromEntries(waiting.map((entry,index)=>[entry.path,backgroundPlaceholder(`https://example.org/tab-waiting/${index}`,entry.owner)])),
    [backgroundPath]:backgroundPlaceholder(),[manualPath]:manual};
  const requests:string[]=[];let release!:(response:ReturnType<typeof backgroundResponse>)=>void;
  const fixture=loadPlugin({extraFiles,data:{web:true,backgroundReading:true,backgroundPaused:true},request:async url=>{
    requests.push(url);return requests.length===1?new Promise(resolve=>{release=resolve;}):backgroundResponse();
  }});
  await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.(backgroundResponse());});
  for(const entry of waiting)assert.ok(await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(entry.path)));
  const selectedId=await fixture.plugin.queueConceptBody(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.ok(selectedId);assert.equal(backgroundJobs(fixture).length,24);
  await new Promise(resolve=>setTimeout(resolve,410));
  const leaf=fixture.addLeaf('tab',{type:'markdown',state:{file:backgroundPath}}),state=JSON.stringify(leaf.getViewState()),originals=new Map(fixture.files);
  fixture.setActiveFile(backgroundPath);fixture.plugin.app.workspace.activeLeaf=leaf;
  leaf.openFile=async()=>{assert.fail('the current Markdown tab must be revealed rather than reopened');};
  await fixture.plugin.openNoteFile(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  await fixture.plugin.openNoteFile(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  assert.equal(fixture.leaves.length,1);assert.equal(fixture.revealedLeaves.at(-1),leaf);assert.equal(JSON.stringify(leaf.getViewState()),state);
  assert.deepEqual(fixture.files,originals);assert.equal(backgroundJobs(fixture).length,24);
  assert.equal(backgroundJobs(fixture).find(job=>job.path===backgroundPath)?.id,selectedId,'paired reveals deduplicate the same promoted task');
  assert.equal(backgroundJobs(fixture).find(job=>job.id===selectedId)?.attempt,0);assert.deepEqual(requests,[]);
  await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>requests.length===1,'revealed concept body did not begin without a workspace event');
  assert.equal(requests[0],backgroundUrl,'the active tab reads first even though the automatic tasks are already overdue');
  await fixture.plugin.openNoteFile(fixture.plugin.app.vault.getAbstractFileByPath(manualPath));
  assert.equal(backgroundJobs(fixture).length,24,'revealing a readable manual concept must not enqueue replacement content');
  assert.equal(fixture.files.get(manualPath),manual);assert.deepEqual(fixture.files,originals);
  release(backgroundResponse());assert.equal((await waitBackground(fixture,selectedId)).state,'ready');
  assert.ok(fixture.files.get(backgroundPath)?.includes(backgroundBody));assert.ok(fixture.files.get(backgroundPath)?.includes('custom_manual: keep'));
  assert.equal(fixture.files.get(manualPath),manual);
  for(const path of['知识图谱.md','来源核验.md'])assert.equal(fixture.files.get(path),originals.get(path));
});

test('cancel-all invalidates a user-opened concept still awaiting eligibility even when reading resumes before that read returns',async t=>{
  let blocked=false,release!:()=>void;
  const requests:string[]=[],original=backgroundPlaceholder();
  const fixture=loadPlugin({extraFiles:{[backgroundPath]:original},data:{web:true,backgroundReading:true,backgroundPaused:true},
    request:async url=>{requests.push(url);return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.();});
  const read=fixture.plugin.app.vault.read.bind(fixture.plugin.app.vault);
  fixture.plugin.app.vault.read=async(file:any)=>{
    if(file.path===backgroundPath&&!blocked){blocked=true;await new Promise<void>(resolve=>{release=resolve;});}
    return read(file);
  };
  const before=new Map(fixture.files),opened=fixture.plugin.openNoteFile(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  await waitCondition(()=>blocked,'user-opened concept did not enter its slow eligibility read');
  await fixture.plugin.cancelBackgroundTasks();await fixture.plugin.setBackgroundPaused(false);release();await opened;
  await new Promise(resolve=>setTimeout(resolve,410));
  assert.equal(backgroundJobs(fixture).length,0,'a resumed worker must not admit a user request that predates cancel-all');
  assert.deepEqual(requests,[]);assert.deepEqual(fixture.files,before);
  assert.equal(fixture.leaves.length,1,'the visible note remains available despite cancellation of its body lookup');
  await fixture.plugin.openNoteFile(fixture.plugin.app.vault.getAbstractFileByPath(backgroundPath));
  await waitCondition(()=>backgroundJobs(fixture).length===1,'a fresh explicit open after cancellation must remain eligible');
  assert.equal((await waitBackground(fixture,backgroundJobs(fixture)[0].id)).state,'ready');
  assert.deepEqual(requests,[backgroundUrl]);assert.ok(fixture.files.get(backgroundPath)?.includes(backgroundBody));
  for(const path of['知识图谱.md','来源核验.md'])assert.equal(fixture.files.get(path),before.get(path));
});

test('cancel-all prevents historical or direct manual retries from resurrecting after either slow ownership check',async t=>{
  for(const scenario of['historical-check','queue-check','direct-manual'] as const) {
    let reads=0,blocked=false,release!:()=>void;
    const requests:string[]=[],original=backgroundPlaceholder();
    const fixture=loadPlugin({extraFiles:{[backgroundPath]:original},data:{web:true,backgroundPaused:true,
      readingTasks:[storedBackgroundJob('no_match')]},request:async url=>{requests.push(url);return backgroundResponse();}});
    await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.();});
    const read=fixture.plugin.app.vault.read.bind(fixture.plugin.app.vault);
    fixture.plugin.app.vault.read=async(file:any)=>{
      if(file.path===backgroundPath&&++reads===(scenario==='queue-check'?2:1)&&!blocked) {
        blocked=true;await new Promise<void>(resolve=>{release=resolve;});
      }
      return read(file);
    };
    const before=new Map(fixture.files),history=JSON.stringify(backgroundJobs(fixture));
    const retry=scenario==='direct-manual'?fixture.plugin.retryConceptBody(backgroundPath,backgroundOwner)
      :fixture.plugin.retryBackgroundJob('restored-background-task');
    await waitCondition(()=>blocked,`${scenario}: retry did not reach its slow ownership check`);
    await fixture.plugin.cancelBackgroundTasks();await fixture.plugin.setBackgroundPaused(false);release();
    assert.equal(await retry,undefined,scenario);await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(JSON.stringify(backgroundJobs(fixture)),history,`${scenario}: cancelled retry must retain terminal history`);
    assert.deepEqual(requests,[],scenario);assert.deepEqual(fixture.files,before,scenario);
    assert.equal(fixture.processed.length,0,scenario);
    const fresh=await fixture.plugin.retryBackgroundJob('restored-background-task');
    assert.equal((await waitBackground(fixture,fresh)).state,'ready',scenario);
    assert.deepEqual(requests,[backgroundUrl],scenario);
    assert.equal(backgroundJobs(fixture).length,1,scenario);
  }
});

test('a reassigned concept reports one feed refusal while healthy following bodies complete without touching the replaced note',async t=>{
  const requests:string[]=[];
  const fixture=loadPlugin({data:{web:true,backgroundReading:true,backgroundPaused:true},
    request:async url=>{requests.push(url);return backgroundResponse();}});
  await fixture.plugin.onload();t.after(()=>fixture.plugin.onunload());
  const {map,entries}=await createBackgroundBacklog(fixture,2),[bad,healthy]=entries;
  const replacement=backgroundPlaceholder('https://example.org/reassigned-owner-body','concept-new-reassigned-owner');
  fixture.files.set(bad.path,replacement);
  const before=new Map(fixture.files),nodeIds=map.graph.nodes.map(node=>node.id),edgesBefore=JSON.stringify(map.graph.edges);
  fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
  await waitCondition(()=>!fixture.plugin.liveBodyFeeding&&backgroundJobs(fixture).some(job=>job.path===healthy.path),
    'one ownership refusal blocked the healthy following concept');
  const refusals=()=>fixture.notices.filter(message=>message.includes('正文补充未排队')&&message.includes('归属已变化'));
  assert.equal(refusals().length,1);assert.equal(backgroundJobs(fixture).some(job=>job.path===bad.path),false);
  await fixture.plugin.feedLiveBodies();assert.equal(refusals().length,1,'the same cached identity failure must not spam repeated notices');
  assert.deepEqual(fixture.files,before);assert.deepEqual(requests,[]);
  const healthyId=backgroundJobs(fixture).find(job=>job.path===healthy.path)!.id;
  fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
  assert.equal((await waitBackground(fixture,healthyId)).state,'ready');
  await waitCondition(()=>!fixture.plugin.liveBodyFeeding,'body completion did not finish its refill');
  await fixture.plugin.feedLiveBodies();await new Promise(resolve=>setTimeout(resolve,410));
  assert.deepEqual(requests,[healthy.url],'refreshed metadata cannot authorize the old graph node to fetch a replacement identity');
  assert.equal(fixture.files.get(bad.path),replacement,'the reassigned note must retain every byte after healthy workers refresh the ownership cache');
  assert.ok(fixture.files.get(healthy.path)?.includes(backgroundBody));
  assert.deepEqual(map.graph.nodes.map(node=>node.id),nodeIds,'body refusal and completion cannot alter graph membership');
  assert.equal(JSON.stringify(map.graph.edges),edgesBefore,'body refusal and completion cannot alter graph relations');
  assert.equal(map.graph.nodes.find(node=>node.id===bad.owner)?.bodyAvailable,false);
  for(const path of['知识图谱.md','来源核验.md',map.rootPath])assert.equal(fixture.files.get(path),before.get(path));
  // A reviewed merge explicitly retaining the old identity is still the same
  // graph entity and may safely use the surviving note's current owner.
  fixture.files.set(bad.path,replacement.replace('custom_manual:',`knowledge_seed_merged_ids: ${JSON.stringify([bad.owner])}\ncustom_manual:`));
  await fixture.plugin.refreshManagedNotes();await fixture.plugin.feedLiveBodies();
  const mergedId=backgroundJobs(fixture).find(job=>job.path===bad.path)!.id;
  assert.equal((await waitBackground(fixture,mergedId)).state,'ready','a legitimate merged identity must retain automatic body completion');
  assert.deepEqual(requests,[healthy.url,'https://example.org/reassigned-owner-body']);
  assert.ok(fixture.files.get(bad.path)?.includes(backgroundBody));
  assert.ok(fixture.frontmatter(bad.path)?.knowledge_seed_merged_ids.includes(bad.owner));
  assert.ok(fixture.plugin.liveBodyAttempted.has(`${map.id}:${bad.path}:${bad.owner}`),'the attempt key follows the graph identity across a reviewed merge');
  assert.equal(refusals().length,1,'changing the cached note owner must not duplicate the old graph identity refusal');
});

test('revoking a merged alias during eligibility or after queueing refuses automatic hydration while an explicit current-owner retry remains available',async t=>{
  for(const scenario of['eligibility-read','queued','worker-read'] as const) {
    let reads=0,blocked=false,release!:()=>void;
    const requests:string[]=[],survivor='concept-reviewed-survivor',sourceUrl=`https://example.org/revoked-alias/${scenario}`;
    const fixture=loadPlugin({data:{web:true,backgroundReading:true,backgroundPaused:true},
      request:async url=>{requests.push(url);return backgroundResponse();}});
    await fixture.plugin.onload();t.after(()=>{fixture.plugin.onunload();release?.();});
    const {map,entries}=await createBackgroundBacklog(fixture,1),entry=entries[0];
    const revoked=backgroundPlaceholder(sourceUrl,survivor);
    const merged=revoked.replace('custom_manual:',`knowledge_seed_merged_ids: ${JSON.stringify([entry.owner])}\ncustom_manual:`);
    fixture.files.set(entry.path,merged);await fixture.plugin.refreshManagedNotes();
    const before=new Map(fixture.files),processedBefore=[...fixture.processed],read=fixture.plugin.app.vault.read.bind(fixture.plugin.app.vault);
    fixture.plugin.app.vault.read=async(file:any)=>{
      if(file.path===entry.path) {
        reads++;
        if(!blocked&&((scenario==='eligibility-read'&&reads===1)||(scenario==='worker-read'&&reads===3))) {
          blocked=true;await new Promise<void>(resolve=>{release=resolve;});
        }
      }
      return read(file);
    };
    fixture.plugin.busy=true;await fixture.plugin.setBackgroundPaused(false);
    if(scenario==='eligibility-read') {
      await waitCondition(()=>blocked,`${scenario}: automatic eligibility did not enter the delayed read`);
      fixture.files.set(entry.path,revoked);release();
      await waitCondition(()=>!fixture.plugin.liveBodyFeeding,`${scenario}: rejected eligibility did not settle`);
      assert.equal(backgroundJobs(fixture).length,0,scenario);
      assert.ok(fixture.notices.some(message=>message.includes('正文补充未排队')&&message.includes('归属已变化')),scenario);
      fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
    }else {
      await waitCondition(()=>!fixture.plugin.liveBodyFeeding&&backgroundJobs(fixture).some(job=>job.path===entry.path),
        `${scenario}: the retained merged identity was not queued`);
      const id=backgroundJobs(fixture).find(job=>job.path===entry.path)!.id;
      if(scenario==='queued')fixture.files.set(entry.path,revoked);
      fixture.plugin.busy=false;fixture.plugin.backgroundReader.refreshGate();
      if(scenario==='worker-read') {
        await waitCondition(()=>blocked,`${scenario}: worker did not enter its final delayed local read`);
        fixture.files.set(entry.path,revoked);release();
      }
      const job=await waitBackground(fixture,id);
      assert.equal(job.state,'skipped',scenario);assert.match(job.reason,/归属|合并身份/,scenario);
    }
    await waitCondition(()=>!fixture.plugin.liveBodyFeeding,`${scenario}: refill did not settle`);
    assert.deepEqual(requests,[],`${scenario}: revoked graph identity must be checked before source requests`);
    assert.equal(fixture.files.get(entry.path),revoked,scenario);assert.deepEqual(fixture.processed,processedBefore,scenario);
    for(const path of['知识图谱.md','来源核验.md',map.rootPath])assert.equal(fixture.files.get(path),before.get(path),scenario);
    const manual=await fixture.plugin.retryConceptBody(entry.path,survivor);
    assert.equal((await waitBackground(fixture,manual)).state,'ready',`${scenario}: explicit reading of the current owner must remain usable`);
    assert.deepEqual(requests,[sourceUrl],scenario);assert.ok(fixture.files.get(entry.path)?.includes(backgroundBody),scenario);
    assert.equal(fixture.frontmatter(entry.path)?.knowledge_seed_id,survivor,scenario);
    assert.ok(!fixture.frontmatter(entry.path)?.knowledge_seed_merged_ids?.includes(entry.owner),`${scenario}: removed aliases must not be restored`);
    for(const path of['知识图谱.md','来源核验.md',map.rootPath])assert.equal(fixture.files.get(path),before.get(path),scenario);
  }
});
