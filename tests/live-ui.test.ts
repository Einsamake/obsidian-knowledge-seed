import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { parseHTML } from 'linkedom';
import type { LiveMapControls, LiveMapInfo } from '../src/live-ui';

// Bundle the actual UI source against the public Obsidian API shim. Graph layout
// and native live refresh are separate runtime checks, not asserted by this DOM.
const source = buildSync({ entryPoints: [fileURLToPath(new URL('../src/live-ui.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian'] }).outputFiles[0].text;

function fixture() {
  const { document, window } = parseHTML('<html><body></body></html>');
  const notices: string[] = [];
  const listeners = new Set<() => void>();
  const savedListeners: (() => void)[] = [];
  const calls: Array<{ action: string; id: string; path?: string; branch?: boolean; direction?: string }> = [];
  let maps: LiveMapInfo[] = [
    { id: 'one', title: 'QR 分解', rootPath: '起点/QR 分解.md', state: 'running', nodes: 3, edges: 2, bodyReady: 1, limit: 30 },
    { id: 'two', title: '数值分析', rootPath: '起点/数值分析.md', state: 'paused', nodes: 2, edges: 1, bodyReady: 0, limit: 20 },
  ];
  let currentId: string | undefined = 'one';
  let paths = [ { path: maps[0].rootPath, title: maps[0].title },
    { path: '概念/正交矩阵.md', title: '正交矩阵' }, { path: '概念/矩阵.md', title: '矩阵' } ];
  let opening: ((id: string) => Promise<void>) | undefined;
  let expanding: (() => Promise<void>) | undefined;
  const emit = () => { for (const listener of listeners) listener(); };
  const controls: LiveMapControls = {
    list: () => maps,
    current: () => maps.find(map => map.id === currentId),
    subscribe: listener => { listeners.add(listener); savedListeners.push(listener); return () => { listeners.delete(listener); }; },
    paths: id => id === 'one' ? paths : [{ path: maps[1].rootPath, title: maps[1].title }],
    open: async id => { calls.push({ action: 'open', id }); if (opening) await opening(id); currentId = id; emit(); },
    pause: async id => { calls.push({ action: 'pause', id }); maps.find(map => map.id === id)!.state = 'paused'; emit(); },
    resume: async id => { calls.push({ action: 'resume', id }); maps.find(map => map.id === id)!.state = 'running'; emit(); },
    stop: async id => { calls.push({ action: 'stop', id }); maps.find(map => map.id === id)!.state = 'cancelled'; emit(); },
    prune: async (id, path, branch) => { calls.push({ action: 'prune', id, path, branch }); },
    expand: async (id, path, direction) => { calls.push({ action: 'expand', id, path, direction }); if (expanding) await expanding(); },
  };
  function element(tag: string): HTMLElement {
    const node = document.createElement(tag) as unknown as HTMLElement;
    const decorated = node as any;
    decorated.empty = () => node.replaceChildren();
    decorated.setText = (text: string) => { node.textContent = text; };
    decorated.addClass = (name: string) => node.classList.add(name);
    decorated.createEl = (childTag: string, options: any = {}) => {
      const child = element(childTag);
      if (options.text !== undefined) child.textContent = options.text;
      if (options.cls) child.className = options.cls;
      if (options.type) child.setAttribute('type', options.type);
      for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, String(value));
      node.appendChild(child); return child;
    };
    decorated.createDiv = (options: any) => decorated.createEl('div', options);
    if (tag === 'select') Object.defineProperty(node, 'value', {
      get: () => [...node.querySelectorAll('option')].find(option => option.selected)?.value ?? '',
      set: (value: string) => {
        const options = [...node.querySelectorAll('option')];
        options.forEach(option => { option.selected = false; });
        const chosen = options.find(option => option.value === value); if (chosen) chosen.selected = true;
      },
    });
    return node;
  }
  const app = {};
  class ItemView {
    contentEl = element('div'); app = app;
    constructor(public leaf: unknown) { document.body.appendChild(this.contentEl as any); }
  }
  class Modal {
    contentEl = element('div'); modalEl = element('section'); closed = true; title = '';
    constructor(public app: unknown) { this.modalEl.appendChild(this.contentEl); }
    setTitle(value: string) { this.title = value; }
    open() { this.closed = false; document.body.appendChild(this.modalEl as any); (this as any).onOpen(); }
    close() { this.closed = true; (this as any).onClose(); this.modalEl.remove(); }
  }
  const module = { exports: {} as any };
  vm.runInNewContext(source, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, 'obsidian'); return { ItemView, Modal, Notice: class { constructor(message: string) { notices.push(message); } } };
  } });
  const view = new module.exports.LiveMapView({}, controls);
  void view.onClose(); // The fixture starts with an inactive sidebar; tests explicitly open it.
  const library = new module.exports.GraphLibraryModal(app, controls);
  const button = (container: HTMLElement, label: string) => {
    const found = [...container.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(found, `missing button ${label}`); return found as unknown as HTMLButtonElement;
  };
  const field = <T extends HTMLElement>(container: HTMLElement, label: string) => {
    const found = container.querySelector(`[aria-label="${label}"]`); assert.ok(found, label); return found as unknown as T;
  };
  const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
  const click = async (element: HTMLElement) => { element.dispatchEvent(new window.Event('click') as unknown as Event); await settle(); };
  const choose = (value: string) => {
    const select = field<HTMLSelectElement>(view.contentEl, '选择图中节点'); select.value = value;
    select.dispatchEvent(new window.Event('change') as unknown as Event);
  };
  return { view, library, maps, paths, calls, controls, listeners, savedListeners, notices, emit, button, field, click, choose, settle,
    update: (value: Partial<LiveMapInfo>) => { Object.assign(maps[0], value); emit(); },
    setCurrent: (id: string | undefined) => { currentId = id; emit(); },
    setPaths: (value: typeof paths, notify = true) => { paths = value; if (notify) emit(); },
    setOpening: (value: typeof opening) => { opening = value; },
    setExpanding: (value: typeof expanding) => { expanding = value; },
    input: (container: HTMLElement, label: string, value: string) => {
      const input = field<HTMLInputElement>(container, label); input.value = value;
      input.dispatchEvent(new window.Event('input') as unknown as Event); return input;
    },
  };
}

test('live sidebar shows a native map scope, independently counts concepts and ready bodies', async () => {
  const ui = fixture(); await ui.view.onOpen();
  assert.equal(ui.view.getViewType(), 'knowledge-seed-live-map');
  assert.match(ui.view.contentEl.textContent, /3 \/ 30 个节点.*2 条关系.*1 个节点有正文/);
  assert.equal(ui.view.contentEl.querySelector('canvas'), null);
  assert.equal(ui.button(ui.view.contentEl, '移出此节点').disabled, true, 'root retained');
  ui.update({ nodes: 8, bodyReady: 2 });
  assert.match(ui.view.contentEl.textContent, /8 \/ 30 个节点.*2 个节点有正文/);
  await ui.click(ui.button(ui.view.contentEl, '打开关系图'));
  assert.deepEqual(ui.calls, [{ action: 'open', id: 'one' }]);
});

test('node search opens the matching real note and preserves its selection during graph growth', async () => {
  const ui=fixture();
  ui.controls.openNote=async(id,path)=>{ui.calls.push({action:'note',id,path});};
  await ui.view.onOpen();
  ui.input(ui.view.contentEl,'查找图谱节点','正交');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,'概念/正交矩阵.md');
  assert.match(ui.view.contentEl.textContent,/1 \/ 3 个匹配节点/);
  ui.paths.push({path:'概念/正交投影.md',title:'正交投影'});ui.update({nodes:4});
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,'概念/正交矩阵.md');
  assert.equal(ui.field<HTMLInputElement>(ui.view.contentEl,'查找图谱节点').value,'正交');
  await ui.click(ui.button(ui.view.contentEl,'打开笔记'));
  assert.deepEqual(ui.calls,[{action:'note',id:'one',path:'概念/正交矩阵.md'}]);
  assert.equal(ui.paths.length,4,'search only filters the picker, never changes map membership');
});

test('an empty node search disables node actions and switching maps clears stale search and direction', async () => {
  const ui=fixture();ui.controls.openNote=async()=>{};ui.controls.focus=async()=>{};
  await ui.view.onOpen();ui.choose('概念/矩阵.md');
  ui.input(ui.view.contentEl,'从此处探索的方向','矩阵分解');
  ui.input(ui.view.contentEl,'查找图谱节点','不存在的节点');
  for(const label of ['打开笔记','沿此节点探索','以此节点查看','移出此节点','移出此分支'])assert.equal(ui.button(ui.view.contentEl,label).disabled,true,label);
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,'');
  assert.match(ui.view.contentEl.textContent,/0 \/ 3 个匹配节点/);
  ui.setCurrent('two');
  assert.equal(ui.field<HTMLInputElement>(ui.view.contentEl,'查找图谱节点').value,'');
  assert.equal(ui.field<HTMLInputElement>(ui.view.contentEl,'从此处探索的方向').value,'');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,'起点/数值分析.md');
});

test('removing the last matching node prevents a stale picker from opening or pruning an unrelated node', async () => {
  const ui=fixture();ui.controls.openNote=async(id,path)=>{ui.calls.push({action:'note',id,path});};
  await ui.view.onOpen();ui.input(ui.view.contentEl,'查找图谱节点','正交');
  ui.paths.splice(1,1);ui.emit();
  assert.equal(ui.button(ui.view.contentEl,'打开笔记').disabled,true);
  assert.equal(ui.button(ui.view.contentEl,'移出此节点').disabled,true);
  await ui.click(ui.button(ui.view.contentEl,'打开笔记'));
  assert.deepEqual(ui.calls,[]);
  ui.input(ui.view.contentEl,'查找图谱节点','');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,ui.maps[0].rootPath);
  assert.equal(ui.button(ui.view.contentEl,'移出此节点').disabled,true,'root is retained after clearing the filter');
});

test('pause, resume and stop invoke the current map controller without reopening a discovery modal', async () => {
  const ui = fixture(); await ui.view.onOpen();
  await ui.click(ui.button(ui.view.contentEl, '暂停探索'));
  assert.match(ui.view.contentEl.textContent, /探索已暂停/);
  await ui.click(ui.button(ui.view.contentEl, '继续探索'));
  await ui.click(ui.button(ui.view.contentEl, '停止探索'));
  assert.deepEqual(ui.calls.map(call => call.action), ['pause', 'resume', 'stop']);
  assert.equal(ui.button(ui.view.contentEl, '停止探索').disabled, true);
  assert.match(ui.view.contentEl.textContent, /探索已停止/);
});

test('a stopped or completed map can continue from the same controller with its selected node and direction intact', async () => {
  for (const state of ['cancelled', 'complete'] as const) {
    const ui = fixture(); await ui.view.onOpen(); ui.choose('概念/正交矩阵.md');
    const direction = ui.input(ui.view.contentEl, '从此处探索的方向', '数值稳定性');
    ui.update({ state });
    const resume = ui.button(ui.view.contentEl, '继续探索');
    assert.equal(resume.disabled, false, state);
    await ui.click(resume);
    assert.deepEqual(ui.calls, [{ action: 'resume', id: 'one' }]);
    assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl, '选择图中节点').value, '概念/正交矩阵.md');
    assert.equal(direction.value, '数值稳定性');
    assert.equal(ui.button(ui.view.contentEl, '暂停探索').disabled, false);
  }
});

test('continuing a stopped map blocks duplicate clicks and explains a reached cap without disabling pruning', async () => {
  const ui = fixture(); await ui.view.onOpen(); ui.choose('概念/矩阵.md');
  ui.update({ state: 'cancelled', nodes: 30, limit: 30 });
  let release!: () => void;
  ui.controls.resume = async id => {
    ui.calls.push({ action: 'resume', id });
    await new Promise<void>(resolve => { release = resolve; });
    throw new Error('当前图谱已达到节点上限；先剪除不需要的节点或分支，再继续探索。');
  };
  const resume = ui.button(ui.view.contentEl, '继续探索');
  await ui.click(resume); await ui.click(resume);
  assert.equal(ui.calls.length, 1);
  release(); await ui.settle();
  assert.match(ui.view.contentEl.textContent, /已达到节点上限/);
  assert.equal(ui.button(ui.view.contentEl, '继续探索').disabled, false);
  assert.equal(ui.button(ui.view.contentEl, '移出此节点').disabled, false);
});

test('the optional strategy control opens the current saved map once and reports errors without changing its scope', async () => {
  const ui = fixture(); let release!: () => void;
  ui.controls.configure = async id => {
    ui.calls.push({ action: 'configure', id });
    await new Promise<void>(resolve => { release = resolve; });
    throw new Error('请先暂停当前探索，再调整策略。');
  };
  await ui.view.onOpen(); ui.choose('概念/矩阵.md');
  const configure = ui.button(ui.view.contentEl, '调整探索策略');
  await ui.click(configure); await ui.click(configure);
  assert.deepEqual(ui.calls, [{ action: 'configure', id: 'one' }]);
  release(); await ui.settle();
  assert.match(ui.view.contentEl.textContent, /先暂停当前探索/);
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl, '选择图中节点').value, '概念/矩阵.md');
  assert.deepEqual(ui.paths.map(node => node.path), ['起点/QR 分解.md', '概念/正交矩阵.md', '概念/矩阵.md']);
});

test('progress updates preserve selected real node and direction, while switching maps clears them', async () => {
  const ui = fixture(); await ui.view.onOpen(); ui.choose('概念/正交矩阵.md');
  const input = ui.input(ui.view.contentEl, '从此处探索的方向', '  数值稳定性  ');
  ui.update({ nodes: 12, bodyReady: 4 });
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl, '选择图中节点').value, '概念/正交矩阵.md');
  assert.equal(input.value, '  数值稳定性  ');
  await ui.click(ui.button(ui.view.contentEl, '沿此节点探索'));
  assert.deepEqual(ui.calls[0], { action: 'expand', id: 'one', path: '概念/正交矩阵.md', direction: '数值稳定性' });
  ui.setCurrent('two'); assert.equal(input.value, '');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl, '选择图中节点').value, '起点/数值分析.md');
});

test('node and branch pruning target actual paths and retain the root', async () => {
  const ui = fixture(); await ui.view.onOpen(); ui.choose('概念/矩阵.md');
  await ui.click(ui.button(ui.view.contentEl, '移出此节点'));
  await ui.click(ui.button(ui.view.contentEl, '移出此分支'));
  assert.deepEqual(ui.calls, [
    { action: 'prune', id: 'one', path: '概念/矩阵.md', branch: false },
    { action: 'prune', id: 'one', path: '概念/矩阵.md', branch: true },
  ]);
  ui.setPaths([ui.paths[0]]);
  assert.equal(ui.button(ui.view.contentEl, '移出此节点').disabled, true);
});

test('a node removed before its UI updates cannot cause an operation on a fallback node', async () => {
  const ui = fixture(); await ui.view.onOpen(); ui.choose('概念/矩阵.md');
  const prune = ui.button(ui.view.contentEl, '移出此节点');
  ui.setPaths([ui.paths[0]], false);
  await ui.click(prune);
  assert.equal(ui.calls.length, 0);
  assert.match(ui.notices[0], /节点已不在图谱/);
  assert.match(ui.view.contentEl.textContent, /节点已不在图谱/);
});

test('closed sidebar unsubscribes; late requests do not repaint or alter a reopened view', async () => {
  const ui = fixture(); await ui.view.onOpen();
  let release!: () => void;
  ui.setExpanding(() => new Promise<void>(resolve => { release = resolve; }));
  ui.choose('概念/矩阵.md');
  await ui.click(ui.button(ui.view.contentEl, '沿此节点探索'));
  assert.equal(ui.listeners.size, 1);
  await ui.view.onClose(); assert.equal(ui.listeners.size, 0);
  ui.savedListeners[0](); assert.equal(ui.view.contentEl.children.length, 0);
  await ui.view.onOpen(); assert.equal(ui.listeners.size, 1);
  assert.equal(ui.button(ui.view.contentEl, '沿此节点探索').disabled, false);
  release(); await ui.settle();
  assert.equal(ui.listeners.size, 1); assert.notEqual(ui.view.contentEl.children.length, 0);
  await ui.view.onClose();
});

test('graph library filters saved maps, opens the exact saved scope and cleans subscriptions', async () => {
  const ui = fixture(); ui.library.open();
  assert.equal(ui.listeners.size, 1);
  ui.input(ui.library.contentEl, '搜索已有知识图谱', 'qr');
  assert.equal(ui.library.contentEl.querySelectorAll('[data-map-id]').length, 1);
  assert.match(ui.library.contentEl.textContent, /1 \/ 2 个知识图谱/);
  ui.update({ nodes: 15 });
  assert.equal(ui.field<HTMLInputElement>(ui.library.contentEl, '搜索已有知识图谱').value, 'qr');
  await ui.click(ui.button(ui.library.contentEl, '打开关系图'));
  assert.deepEqual(ui.calls, [{ action: 'open', id: 'one' }]);
  assert.equal(ui.library.closed, true); assert.equal(ui.listeners.size, 0);
  ui.savedListeners[0](); assert.equal(ui.library.contentEl.children.length, 0);
});

test('graph library rejects duplicate opens and does not close a fresh modal after an old request resolves', async () => {
  const ui = fixture(); let release!: () => void;
  ui.setOpening(() => new Promise<void>(resolve => { release = resolve; }));
  ui.library.open(); const first = ui.button(ui.library.contentEl, '打开关系图');
  await ui.click(first); await ui.click(first);
  assert.equal(ui.calls.length, 1);
  ui.library.close(); ui.library.open();
  release(); await ui.settle();
  assert.equal(ui.library.closed, false); assert.equal(ui.listeners.size, 1);
  ui.library.close();
});

test('controller errors leave the map available, with a readable notice and enabled retry', async () => {
  const ui = fixture(); await ui.view.onOpen();
  ui.setOpening(async () => { throw new Error('原图起点已移动，请重新选择图谱。'); });
  await ui.click(ui.button(ui.view.contentEl, '打开关系图'));
  assert.equal(ui.notices.length, 1);
  assert.match(ui.view.contentEl.textContent, /原图起点已移动/);
  assert.equal(ui.button(ui.view.contentEl, '打开关系图').disabled, false);
});

test('roaming sidebar separates navigation from discovery and dispatches only explicit view actions',async()=>{
  const ui=fixture(),actions:unknown[]=[];
  let info={enabled:true,fog:true,radius:1,limit:40,overviewJumps:5,center:'root',back:[] as string[],forward:[] as string[],visited:['root'],revealed:['root','next'],
    centerTitle:'QR 分解',total:100,shown:2,nearby:2,route:[{id:'root',title:'QR 分解'}],frontier:[{id:'next',title:'矩阵',hidden:4,next:[{id:'outside',title:'特征值'}]}]};
  ui.controls.roaming=()=>info;
  ui.controls.roam=async(id,action)=>{actions.push([id,action]);if(action.type==='enter')info={...info,center:action.node,back:['root']};ui.emit();};
  ui.controls.enter=async(id,path)=>{actions.push([id,path]);};
  await ui.view.onOpen();
  assert.match(ui.view.contentEl.textContent,/视野 2 \/ 全图 100/);assert.match(ui.view.contentEl.textContent,/已到访不代表已掌握/);
  assert.equal(ui.button(ui.view.contentEl,'后退').disabled,true);
  await ui.click(ui.button(ui.view.contentEl,'矩阵 → 4 个视野外节点'));
  assert.deepEqual(JSON.parse(JSON.stringify(actions)),[['one',{type:'enter',node:'next'}]]);assert.equal(ui.button(ui.view.contentEl,'后退').disabled,false);
  await ui.click(ui.button(ui.view.contentEl,'前往 特征值'));assert.deepEqual(JSON.parse(JSON.stringify(actions.at(-1))),['one',{type:'enter',node:'outside'}]);
  ui.choose('概念/矩阵.md');await ui.click(ui.button(ui.view.contentEl,'进入此处（局部漫游）'));
  assert.deepEqual(actions.at(-1),['one','概念/矩阵.md']);assert.deepEqual(ui.calls,[],'navigation does not start discovery');
  const count=actions.length;await ui.view.onClose();ui.emit();assert.equal(ui.view.contentEl.textContent,'');assert.equal(actions.length,count);
});

test('roaming controls remain usable when discovery is stopped and report asynchronous navigation errors',async()=>{
  const ui=fixture();
  ui.controls.roaming=()=>({enabled:true,fog:false,radius:2,limit:40,overviewJumps:5,center:'root',back:['prev'],forward:[],visited:['root'],revealed:['root'],centerTitle:'起点',total:3,shown:3,nearby:3,route:[{id:'root',title:'起点'}],frontier:[]});
  ui.controls.roam=async()=>{throw new Error('节点笔记已移动');};
  await ui.view.onOpen();ui.update({state:'cancelled'});
  assert.equal(ui.button(ui.view.contentEl,'后退').disabled,false);assert.equal(ui.button(ui.view.contentEl,'展开一圈').disabled,true);
  await ui.click(ui.button(ui.view.contentEl,'后退'));assert.ok(ui.notices.some(text=>text.includes('节点笔记已移动')));assert.equal(ui.button(ui.view.contentEl,'后退').disabled,false);
});

test('moving the roaming center selects that node, while background snapshots preserve an in-progress search',async()=>{
  const ui=fixture();let center='root',centerPath=ui.maps[0].rootPath;
  ui.controls.roaming=()=>({enabled:true,fog:true,radius:1,limit:40,overviewJumps:5,center,centerPath,back:[],forward:[],visited:[center],revealed:[center],centerTitle:'当前位置',total:3,shown:2,nearby:2,route:[],frontier:[]});
  ui.controls.roam=async()=>{};await ui.view.onOpen();
  ui.input(ui.view.contentEl,'查找图谱节点','矩阵');ui.choose('概念/正交矩阵.md');ui.update({nodes:4});
  assert.equal(ui.field<HTMLInputElement>(ui.view.contentEl,'查找图谱节点').value,'矩阵');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,'概念/正交矩阵.md');
  center='matrix';centerPath='概念/矩阵.md';ui.emit();
  assert.equal(ui.field<HTMLInputElement>(ui.view.contentEl,'查找图谱节点').value,'');
  assert.equal(ui.field<HTMLSelectElement>(ui.view.contentEl,'选择图中节点').value,centerPath);
});
