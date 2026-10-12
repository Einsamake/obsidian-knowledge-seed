import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import type { KnowledgeGraph } from '../src/graph';
import type { BackgroundJob, BackgroundState } from '../src/background';

// These interactions exercise the shipped bundle, not copies of its modal logic.
// LinkeDOM does not implement browser constraint validation or Obsidian widgets:
// the public API shim below supplies them. Native rendering remains a separate check.
function uiFixture() {
  const { document, window } = parseHTML('<html><body></body></html>');
  const pending: Promise<unknown>[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const notices: string[] = [];
  const mathCalls:string[]=[];
  const modals: Modal[] = [];
  const statusBars: HTMLElement[] = [];
  const openedFiles: string[] = [];
  const files = new Map<string, TFile>();
  const validationErrors = new WeakMap<object, string>();
  const reported = new WeakSet<object>();
  let activeElement:HTMLElement|null=null;
  Object.defineProperty(document,'activeElement',{get:()=>activeElement});
  function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return decorate(document.createElement(tag) as unknown as HTMLElementTagNameMap[K]);
  }
  function decorate<T extends HTMLElement>(node: T): T {
    const current = node as any;
    current.createEl = (tag: keyof HTMLElementTagNameMap, options: any = {}) => {
      const child = element(tag);
      if (options.text !== undefined) child.textContent = options.text;
      if (options.cls) child.className = options.cls;
      if (options.type) child.setAttribute('type', options.type);
      if (options.href) child.setAttribute('href', options.href);
      for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, String(value));
      node.appendChild(child); return child;
    };
    current.createDiv = (options: any = {}) => current.createEl('div', options);
    current.createSpan = (options: any = {}) => current.createEl('span', options);
    current.empty = () => node.replaceChildren();
    current.addClass = (name: string) => node.classList.add(name);
    current.setText = (text: string) => { node.textContent = text; };
    current.setCustomValidity = (message: string) => validationErrors.set(node, message);
    current.reportValidity = () => { reported.add(node); return !validationErrors.get(node); };
    current.focus = () => {activeElement=node;};
    current.setSelectionRange = (start:number,end:number) => {current.selectionStart=start;current.selectionEnd=end;};
    const query = node.querySelector.bind(node), queryAll = node.querySelectorAll.bind(node);
    current.querySelectorAll = (selector: string) => selector.includes(':invalid')
      ? [...queryAll(selector.replace(/:invalid\b/g, ''))].filter(input => !(input as unknown as HTMLInputElement).disabled && Boolean(validationErrors.get(input)))
      : queryAll(selector);
    current.querySelector = (selector: string) => selector.includes(':invalid')
      ? current.querySelectorAll(selector)[0] ?? null
      : query(selector);
    return node;
  }
  function listen(node: HTMLElement, name: string, action: () => unknown) {
    node.addEventListener(name, () => {
      const result = action();
      if (result && typeof (result as Promise<unknown>).then === 'function') pending.push(Promise.resolve(result));
    });
  }
  class Scope {
    handlers: Array<() => unknown> = [];
    register(_modifiers: unknown, _key: string, callback: () => unknown) { this.handlers.push(callback); return callback; }
    unregister(callback: () => unknown) { this.handlers = this.handlers.filter(handler => handler !== callback); }
  }
  class Modal {
    contentEl = element('div'); modalEl = element('section'); scope = new Scope(); title = ''; closed = false;
    constructor(public app: any) { this.modalEl.appendChild(this.contentEl); }
    setTitle(title: string) { this.title = title; }
    open() { this.closed = false; document.body.appendChild(this.modalEl as any); modals.push(this); (this as any).onOpen?.(); }
    close() { this.closed = true; (this as any).onClose?.(); this.modalEl.remove(); }
  }
  class FuzzySuggestModal extends Modal { setPlaceholder(_value: string) {} }
  const settingTabs:any[]=[];
  class PluginSettingTab {containerEl=element('div'); constructor(public app: any, public plugin: any) {} }
  class Plugin {
    commands: any[] = [];
    constructor(public app: any) {}
    async loadData() { return { web: false, liveGraph: false }; }
    async saveData(_value: unknown) {}
    addCommand(command: unknown) { this.commands.push(command); }
    addRibbonIcon() {}
    addStatusBarItem() { const item = element('div'); item.className = 'status-bar-item'; document.body.appendChild(item as any); statusBars.push(item); return item; }
    addSettingTab(tab:unknown) {settingTabs.push(tab);}
    registerEvent() {}
    registerView() {}
    registerDomEvent(node: HTMLElement, event: string, callback: (event: Event) => unknown) {
      node.addEventListener(event, (value: Event) => {
        const result = callback(value);
        if (result && typeof (result as Promise<unknown>).then === 'function') pending.push(Promise.resolve(result));
      });
    }
  }
  class TextComponent {
    inputEl: HTMLInputElement | HTMLTextAreaElement;
    constructor(parent: HTMLElement, textarea = false) { this.inputEl = element(textarea ? 'textarea' : 'input'); parent.appendChild(this.inputEl); }
    setValue(value: string) { this.inputEl.value = value; return this; }
    setPlaceholder(value: string) { this.inputEl.setAttribute('placeholder', value); return this; }
    onChange(callback: (value: string) => unknown) { listen(this.inputEl, 'input', () => callback(this.inputEl.value)); return this; }
  }
  class DropdownComponent {
    selectEl = element('select');
    constructor(parent: HTMLElement) { parent.appendChild(this.selectEl); }
    addOption(value: string, label: string) {
      const option = element('option'); option.value = value; option.textContent = label;
      const first = !this.selectEl.children.length; this.selectEl.appendChild(option);
      if (first) option.selected = true; return this;
    }
    addOptions(options: Record<string, string>) { for (const [value, label] of Object.entries(options)) this.addOption(value, label); return this; }
    setValue(value: string) {
      setSelected(this.selectEl,value);
      return this;
    }
    onChange(callback: (value: string) => unknown) { listen(this.selectEl, 'change', () => callback(this.selectEl.value)); return this; }
  }
  class ButtonComponent {
    buttonEl = element('button');
    constructor(parent: HTMLElement) { parent.appendChild(this.buttonEl); }
    setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
    setDisabled(value: boolean) { this.buttonEl.disabled = value; return this; }
    setCta() { return this; }
    setTooltip(value: string) { this.buttonEl.title = value; return this; }
    onClick(callback: () => unknown) { listen(this.buttonEl, 'click', () => this.buttonEl.disabled ? undefined : callback()); return this; }
  }
  class ToggleComponent {
    toggleEl = element('input');
    constructor(parent: HTMLElement) { this.toggleEl.type = 'checkbox'; parent.appendChild(this.toggleEl); }
    setValue(value: boolean) { this.toggleEl.checked = value; return this; }
    onChange(callback: (value: boolean) => unknown) { listen(this.toggleEl, 'change', () => callback(this.toggleEl.checked)); return this; }
  }
  class Setting {
    settingEl: HTMLElement; controlEl: HTMLElement;
    constructor(parent: HTMLElement) {
      this.settingEl = element('div'); this.settingEl.className = 'setting-item';
      this.controlEl = element('div'); this.settingEl.appendChild(this.controlEl); parent.appendChild(this.settingEl);
    }
    setName(name: string) { this.settingEl.setAttribute('data-setting', name); return this; }
    setDesc(_text: string) { return this; }
    addText(callback: (input: TextComponent) => unknown) { callback(new TextComponent(this.controlEl)); return this; }
    addTextArea(callback: (input: TextComponent) => unknown) { callback(new TextComponent(this.controlEl, true)); return this; }
    addDropdown(callback: (input: DropdownComponent) => unknown) { callback(new DropdownComponent(this.controlEl)); return this; }
    addButton(callback: (input: ButtonComponent) => unknown) { callback(new ButtonComponent(this.controlEl)); return this; }
    addToggle(callback: (input: ToggleComponent) => unknown) { callback(new ToggleComponent(this.controlEl)); return this; }
  }
  class TFile { extension = 'md'; basename = '脑科学'; constructor(public path: string) {} }
  class ItemView {
    contentEl = element('div'); containerEl = element('div'); app: any;
    constructor(public leaf: any) { this.app = leaf?.app; this.containerEl.appendChild(this.contentEl); }
    addAction(_icon: string, title: string, callback: () => unknown) {
      const action = element('button'); action.title = title; listen(action, 'click', callback); return action;
    }
  }
  type MarkdownLeaf={getViewState:()=>{type:string;state:{file?:string}};openFile:(file:TFile)=>Promise<void>;loadIfDeferred:()=>Promise<void>};
  const markdownLeaves:MarkdownLeaf[]=[];
  const revealedLeaves:typeof markdownLeaves=[],loadedLeaves:typeof markdownLeaves=[];
  let openFailure:Error|undefined;
  const addMarkdownLeaf=(path?:string)=>{
    let currentPath=path;
    const leaf:MarkdownLeaf={getViewState:()=>({type:currentPath?'markdown':'empty',state:{file:currentPath}}),
      openFile:async(file:TFile)=>{if(openFailure)throw openFailure;openedFiles.push(file.path);currentPath=file.path;},
      loadIfDeferred:async()=>{loadedLeaves.push(leaf);}};
    markdownLeaves.push(leaf);return leaf;
  };
  const app = { workspace: { getActiveFile: () => null, on: () => ({}),
    getLeavesOfType:(type:string)=>markdownLeaves.filter(leaf=>leaf.getViewState().type===type),
    getLeaf: () => addMarkdownLeaf(),
    revealLeaf:async(leaf:typeof markdownLeaves[number])=>{revealedLeaves.push(leaf);} },
    vault: { getAbstractFileByPath: (path: string) => files.get(path) ?? null, getMarkdownFiles: () => [] } };
  const api = { Plugin, ItemView, Modal, FuzzySuggestModal, PluginSettingTab, Setting, TFile, App: class {},
    renderMath:(source:string)=>{mathCalls.push(source);return element('span').createEl('span',{text:source,cls:'native-math'}) as HTMLElement;},
    finishRenderMath:async()=>{},
    normalizePath: (path: string) => path,
    requestUrl: async () => { throw new Error('UI tests must not request the network'); },
    Notice: class { constructor(message: string) { notices.push(message); } } };
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), {
    module, exports: module.exports, require: (id: string) => { assert.equal(id, 'obsidian'); return api; },
    // API mocks and the renderer share one Error constructor in Obsidian. Do
    // not create an artificial cross-realm instanceof failure in this harness.
    console, Error, URL, URLSearchParams, TextEncoder, AbortController, DOMException,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => ++timerId, clearInterval: () => {},
  }, { filename: 'main.js' });
  const plugin = new module.exports.default(app);
  async function settle() { while (pending.length) await Promise.all(pending.splice(0)); }
  async function click(button: HTMLButtonElement) { button.dispatchEvent(new window.Event('click') as unknown as Event); await settle(); }
  async function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    node.value = value; node.dispatchEvent(new window.Event('input') as unknown as Event); await settle();
  }
  async function choose(select: HTMLSelectElement, value: string) {
    setSelected(select,value);
    select.dispatchEvent(new window.Event('change') as unknown as Event); await settle();
  }
  async function check(input: HTMLInputElement, checked: boolean) {
    input.checked = checked; input.dispatchEvent(new window.Event('change') as unknown as Event); await settle();
  }
  const button = (modal: Modal, label: string) => {
    const found = [...modal.contentEl.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(found, `missing button: ${label}`); return found as unknown as HTMLButtonElement;
  };
  const field = (modal: Modal, label: string) => {
    const found = modal.contentEl.querySelector(`[aria-label="${label}"]`);
    assert.ok(found, `missing input: ${label}`); return found as unknown as HTMLInputElement;
  };
  async function openSeed() {
    await plugin.onload(); plugin.commands.find((command: any) => command.id === 'generate-knowledge-map').callback();
    const modal = modals.at(-1)!; await input(field(modal, '知识起点'), '脑科学'); return modal;
  }
  async function openPreview(graph = fixtureGraph()) {
    const seed = await openSeed(); plugin.discover = async () => graph;
    graph.request??={seed:{kind:'topic',value:graph.seed},options:{...plugin.settings,web:true}};
    await click(button(seed, '开始发现'));
    const preview = modals.at(-1)!; assert.equal(preview.title, '预览知识地图'); return preview;
  }
  return { plugin, modals, notices, mathCalls, openSeed, openPreview, button, field, click, input, choose, check, settle, reported, settingTabs,
    statusBars, openedFiles, revealedLeaves, loadedLeaves, markdownLeaves, addMarkdownLeaf,
    setOpenFailure:(message?:string)=>{openFailure=message?new Error(message):undefined;},
    addFile: (path: string) => { const file = new TFile(path); files.set(path, file); return file; },
    removeFile:(path:string)=>files.delete(path),
    dispatchClick:(button:HTMLButtonElement)=>button.dispatchEvent(new window.Event('click') as unknown as Event),
    dispatchInput:(input:HTMLInputElement,value:string)=>{input.value=value;input.dispatchEvent(new window.Event('input') as unknown as Event);},
    toggleDetails:(details:HTMLDetailsElement,open=true)=>{details.open=open;details.dispatchEvent(new window.Event('toggle') as unknown as Event);},
    flushTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    timerCount: () => timers.size };
}

// LinkeDOM clears all options when setting any option.selected=false, so clear
// them first and apply the chosen option last to match native select behavior.
function setSelected(select: HTMLSelectElement,value: string) {
  const options=[...select.querySelectorAll('option')] as unknown as HTMLOptionElement[];
  options.forEach(option=>{option.selected=false;});
  const chosen=options.find(option=>option.value===value); assert.ok(chosen,`missing dropdown value: ${value}`); chosen.selected=true;
}

function fixtureGraph(): KnowledgeGraph {
  return { version: 1, seed: '脑科学', createdAt: '2026-10-05T00:00:00Z', warnings: [],
    stats: { pagesAttempted: 1, notesScanned: 1, requests: 1 },
    nodes: [
      {id:'seed',kind:'seed',title:'脑科学',excerpt:'',status:'discovered',depth:0},
      {id:'web',kind:'web',title:'神经科学网页',excerpt:'正文说明神经元',locator:'https://example.org/neuro',status:'retrieved',depth:1,
        article:{blocks:[{type:'paragraph',text:'正文说明神经元。'}],textChars:8,totalTextChars:8,truncated:false}},
      {id:'note',kind:'note',title:'睡眠笔记',excerpt:'已有笔记',locator:'睡眠.md',status:'retrieved',depth:1},
      {id:'concept',kind:'concept',title:'神经元',excerpt:'正文提及',status:'derived',depth:2},
    ],
    edges: [
      {id:'seed-web',from:'seed',to:'web',relation:'seed_source',evidence:[{sourceId:'web',quote:'网页',method:'用户指定'}]},
      {id:'seed-note',from:'seed',to:'note',relation:'keyword_match',evidence:[{sourceId:'note',quote:'笔记',method:'词项匹配'}]},
      {id:'web-concept',from:'web',to:'concept',relation:'mentions',evidence:[{sourceId:'web',quote:'神经元',method:'正文链接'}]},
    ] };
}

test('preset redraw keeps one shortcut and shortcut invokes the current start button', async () => {
  const ui=uiFixture(); const seed=await ui.openSeed();
  assert.equal(seed.scope.handlers.length,1);
  const depthBefore=ui.field(seed,'探索深度');
  await ui.input(depthBefore,'999');
  const preset=seed.contentEl.querySelector('[data-setting="探索预设"] select') as unknown as HTMLSelectElement;
  await ui.choose(preset,'deep');
  assert.equal(seed.scope.handlers.length,1);
  assert.notEqual(ui.field(seed,'探索深度'),depthBefore);
  assert.equal(ui.field(seed,'探索深度').value,'3');
  let calls=0;
  ui.plugin.discover=async (_seed: unknown,_progress: unknown,options: any)=>{calls++;assert.equal(options.depth,3);return fixtureGraph();};
  seed.scope.handlers[0](); await ui.settle();
  assert.equal(calls,1,'shortcut did not invoke the removed invalid form');
  assert.equal(ui.modals.at(-1)?.title,'预览知识地图');
});

test('live discovery enters the native graph flow without awaiting the legacy reading preview', async () => {
  const ui=uiFixture(); const seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  const controller=new AbortController();ui.plugin.activeController=controller;
  let started=0,legacy=0;
  ui.plugin.startLive=async(nextSeed:any,options:any)=>{
    started++;assert.equal(nextSeed.kind,'topic');assert.equal(nextSeed.value,'脑科学');
    assert.equal(options.readingMode,'adaptive');return 'live-test';
  };
  ui.plugin.discover=async()=>{legacy++;return fixtureGraph();};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(started,1);assert.equal(legacy,0);
  assert.equal(seed.closed,true,'input modal must release the native graph');
  assert.equal(controller.signal.aborted,false,'closing the form must not cancel background exploration');
  assert.equal(ui.modals.length,1,'no blocking reading/preview modal');
});

test('live seed form validates and forwards custom strategy choices without changing persistent defaults', async () => {
  const ui=uiFixture(),seed=await ui.openSeed();
  const saved=JSON.stringify(ui.plugin.settings);
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  const strategy=ui.field(seed,'探索策略') as unknown as HTMLSelectElement;
  assert.equal(strategy.closest('details'),null,'strategy must be available in the main setup area');
  await ui.choose(strategy,'custom');
  await ui.input(ui.field(seed,'外层展开递减'),'0');
  await ui.input(ui.field(seed,'方向额外深度'),'3');
  await ui.input(ui.field(seed,'未匹配方向的深度'),'1');
  const rules=ui.field(seed,'各方向优先级与深度');
  await ui.input(rules,'神经科学 | 11 | 4');
  let captured:any;
  ui.plugin.startLive=async(_seed:unknown,options:unknown)=>{captured=options;return 'custom-live';};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(captured,undefined);assert.ok(ui.reported.has(rules));
  await ui.input(rules,'神经科学 | 3 | 4\n实际应用 | 2');
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(seed.closed,true);
  const launched=captured as any;assert.ok(launched);
  assert.equal(launched.explorationStrategy,'custom');assert.equal(launched.breadthDecay,0);
  assert.equal(launched.directionDepthBoost,3);assert.equal(launched.offDirectionDepth,1);
  assert.deepEqual(JSON.parse(JSON.stringify(launched.directionRules)),[{term:'神经科学',weight:3,depth:4},{term:'实际应用',weight:2}]);
  assert.equal(JSON.stringify(ui.plugin.settings),saved,'a single run must not alter persistent settings');
});

test('a legacy saved exploration retains radial strategy even when new exploration defaults are focused', async () => {
  const ui=uiFixture(),fresh=await ui.openSeed();
  assert.equal(ui.plugin.settings.explorationStrategy,'focused');
  assert.equal((ui.field(fresh,'探索策略') as unknown as HTMLSelectElement).value,'focused');
  const oldOptions={...ui.plugin.settings};delete oldOptions.explorationStrategy;
  delete oldOptions.breadthDecay;delete oldOptions.directionDepthBoost;delete oldOptions.offDirectionDepth;delete oldOptions.directionRules;
  ui.plugin.openSeed(undefined,{seed:{kind:'topic',value:'旧探索'},options:oldOptions});
  const restored=ui.modals.at(-1)!;
  assert.equal((ui.field(restored,'探索策略') as unknown as HTMLSelectElement).value,'radial');
  assert.equal(ui.plugin.settings.explorationStrategy,'focused');
  assert.equal(Object.hasOwn(oldOptions,'explorationStrategy'),false,'restoring must not rewrite the saved request');
  await ui.check(restored.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  let captured:any;ui.plugin.startLive=async(_seed:unknown,options:unknown)=>{captured=options;return 'legacy-map';};
  await ui.click(ui.button(restored,'开始发现'));
  assert.equal(captured.explorationStrategy,'radial');
});

test('switching back to legacy preview hides strategy drafts and preserves existing advanced limits', async () => {
  const ui=uiFixture(),seed=await ui.openSeed();
  const liveToggle=seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement;
  await ui.check(liveToggle,true);
  const strategy=ui.field(seed,'探索策略') as unknown as HTMLSelectElement;
  await ui.choose(strategy,'custom');
  await ui.input(ui.field(seed,'外层展开递减'),'99');
  await ui.input(ui.field(seed,'探索深度'),'3');
  await ui.input(ui.field(seed,'每页扩展链接数'),'9');
  await ui.check(liveToggle,false);
  const section=strategy.closest('[aria-label="探索策略设置"]')!;
  assert.equal((section.parentElement as HTMLElement).hidden,true);
  assert.equal(ui.field(seed,'探索深度').value,'3');assert.equal(ui.field(seed,'每页扩展链接数').value,'9');
  let captured:any,liveCalls=0;
  ui.plugin.discover=async(_seed:unknown,_progress:unknown,options:unknown)=>{captured=options;return fixtureGraph();};
  ui.plugin.startLive=async()=>{liveCalls++;return 'unexpected';};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(liveCalls,0);assert.ok(captured,'hidden strategy draft must not block the legacy flow');
  assert.equal(captured.depth,3);assert.equal(captured.linkLimit,9);
  assert.equal(ui.modals.at(-1)?.title,'预览知识地图');
});

test('saved graph strategy uses an isolated draft and validates before a single pending save', async () => {
  const ui=uiFixture();await ui.openSeed();
  const original={...ui.plugin.settings,explorationStrategy:'focused',breadthDecay:1,
    directionRules:[{term:'神经科学',weight:2,depth:4}]};
  const map={id:'strategy-map',title:'脑科学',rootPath:'起点/脑科学.md',state:'cancelled',graph:fixtureGraph(),
    nodePaths:{seed:'起点/脑科学.md'},excludedIds:[],seed:{kind:'topic',value:'脑科学'},options:original};
  ui.plugin.liveMaps=[map];
  const controls=ui.plugin.liveControls();assert.equal(typeof controls.configure,'function');
  await controls.configure(map.id);
  const cancelled=ui.modals.at(-1)!;
  assert.notEqual((cancelled as any).draft,original);
  assert.notEqual((cancelled as any).draft.directionRules,original.directionRules);
  assert.notEqual((cancelled as any).draft.directionRules[0],original.directionRules[0]);
  await ui.input(ui.field(cancelled,'各方向优先级与深度'),'统计学 | 4 | 3');
  await ui.click(ui.button(cancelled,'取消'));
  assert.equal(cancelled.closed,true);assert.strictEqual(map.options,original);
  assert.deepEqual(original.directionRules,[{term:'神经科学',weight:2,depth:4}]);
  await controls.configure(map.id);
  const editing=ui.modals.at(-1)!;
  await ui.choose(ui.field(editing,'探索策略') as unknown as HTMLSelectElement,'custom');
  const decay=ui.field(editing,'外层展开递减');await ui.input(decay,'-1');
  const calls:Array<{id:string;proposal:any}>=[];let release!:()=>void;
  ui.plugin.applyLiveStrategy=async(id:string,proposal:any)=>{calls.push({id,proposal});await new Promise<void>(resolve=>{release=resolve;});};
  await ui.click(ui.button(editing,'保存策略'));
  assert.equal(calls.length,0);assert.ok(ui.reported.has(decay));assert.match(editing.contentEl.textContent??'',/请先修正/);
  await ui.input(decay,'0');await ui.input(ui.field(editing,'各方向优先级与深度'),'统计学 | 4 | 3');
  const save=ui.button(editing,'保存策略');ui.dispatchClick(save);await Promise.resolve();ui.dispatchClick(save);
  assert.equal(calls.length,1);assert.equal(save.disabled,true);assert.equal(ui.button(editing,'取消').disabled,true);
  assert.equal(editing.closed,false);assert.strictEqual(map.options,original,'the draft stays private until the controller accepts it');
  assert.equal(calls[0].id,map.id);assert.equal(calls[0].proposal.explorationStrategy,'custom');assert.equal(calls[0].proposal.breadthDecay,0);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].proposal.directionRules)),[{term:'统计学',weight:4,depth:3}]);
  release();await ui.settle();assert.equal(editing.closed,true);
});

test('live initialization failure reports a readable error and permits another setup', async () => {
  const ui=uiFixture();const seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  let started=0;ui.plugin.startLive=async()=>{started++;throw new Error('无法建立起点，请检查输出目录。');};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(seed.closed,true);assert.equal(started,1);
  assert.ok(ui.notices.some(message=>message.includes('无法建立起点，请检查输出目录。')));
  ui.plugin.openSeed();const next=ui.modals.at(-1)!;
  assert.notEqual(next,seed);assert.equal(next.closed,false);
  assert.equal(ui.button(next,'开始发现').disabled,false);
});

test('an automatically recognized URL returns to a topic when the user replaces it with plain text',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  const kind=seed.contentEl.querySelector('[data-setting="起点类型"] select') as unknown as HTMLSelectElement;
  const input=ui.field(seed,'知识起点');
  await ui.input(input,'https://example.org/neuroscience');assert.equal(kind.value,'url');
  await ui.input(input,'神经科学');assert.equal(kind.value,'topic');
  let captured:any;ui.plugin.startLive=async(value:any)=>{captured=value;return 'edited-topic';};
  await ui.click(ui.button(seed,'开始发现'));
  assert.deepEqual(JSON.parse(JSON.stringify(captured)),{kind:'topic',value:'神经科学'});
  assert.equal(seed.closed,true);
});

test('an explicitly selected webpage type is retained and invalid text remains a visible validation error',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  await ui.check(seed.contentEl.querySelector('[data-setting="检索公开网页"] input') as unknown as HTMLInputElement,true);
  const kind=seed.contentEl.querySelector('[data-setting="起点类型"] select') as unknown as HTMLSelectElement;
  await ui.choose(kind,'url');await ui.input(ui.field(seed,'知识起点'),'https://example.org/neuroscience');
  await ui.input(ui.field(seed,'知识起点'),'神经科学');assert.equal(kind.value,'url');
  let calls=0;ui.plugin.startLive=async()=>{calls++;return 'unexpected';};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(calls,0);assert.equal(seed.closed,false);
  assert.match(seed.contentEl.textContent??'',/完整.*网页地址/);
});

test('failed live initialization restores the seed and complete private options draft for retry',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed(),persistent=JSON.stringify(ui.plugin.settings);
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  await ui.input(ui.field(seed,'知识起点'),'图论与算法');
  await ui.choose(seed.contentEl.querySelector('[data-setting="读取方式"] select') as unknown as HTMLSelectElement,'manual');
  await ui.input(ui.field(seed,'探索深度'),'3');
  await ui.input(ui.field(seed,'补充检索词'),'最短路径\n网络科学');
  await ui.choose(ui.field(seed,'探索策略') as unknown as HTMLSelectElement,'custom');
  await ui.input(ui.field(seed,'外层展开递减'),'0');
  await ui.input(ui.field(seed,'各方向优先级与深度'),'最短路径 | 4 | 3');
  let attempts=0,captured:any;
  ui.plugin.startLive=async(nextSeed:any,options:any)=>{
    attempts++;if(attempts===1)throw new Error('测试保存失败，请重试。');captured={seed:nextSeed,options};return 'retried-map';
  };
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(seed.closed,true);assert.ok(ui.notices.some(message=>message.includes('测试保存失败')));
  const restored=ui.modals.at(-1)!;
  assert.notEqual(restored,seed);assert.equal(restored.closed,false);
  assert.match(restored.contentEl.textContent??'',/参数已保留/);
  assert.equal(ui.field(restored,'知识起点').value,'图论与算法');
  assert.equal(ui.field(restored,'探索深度').value,'3');
  assert.equal(ui.field(restored,'补充检索词').value,'最短路径\n网络科学');
  assert.equal((ui.field(restored,'探索策略') as unknown as HTMLSelectElement).value,'custom');
  assert.equal(ui.field(restored,'外层展开递减').value,'0');
  assert.equal(ui.field(restored,'各方向优先级与深度').value,'最短路径 | 4 | 3');
  await ui.click(ui.button(restored,'开始发现'));
  assert.equal(attempts,2);assert.equal(restored.closed,true);
  assert.equal(captured.seed.value,'图论与算法');assert.equal(captured.options.readingMode,'manual');
  assert.equal(captured.options.depth,3);assert.equal(captured.options.explorationStrategy,'custom');
  assert.equal(captured.options.breadthDecay,0);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.options.directionRules)),[{term:'最短路径',weight:4,depth:3}]);
  assert.equal(JSON.stringify(ui.plugin.settings),persistent,'failed setup and retry must not change global defaults');
});

test('failed live setup retains the selected preset together with its actual limits',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  await ui.choose(seed.contentEl.querySelector('[data-setting="读取方式"] select') as unknown as HTMLSelectElement,'manual');
  await ui.choose(seed.contentEl.querySelector('[data-setting="探索预设"] select') as unknown as HTMLSelectElement,'deep');
  ui.plugin.startLive=async()=>{throw new Error('无法建立本次起点。');};
  await ui.click(ui.button(seed,'开始发现'));
  const restored=ui.modals.at(-1)!;
  assert.equal(restored.closed,false);
  assert.equal((restored.contentEl.querySelector('[data-setting="探索预设"] select') as unknown as HTMLSelectElement).value,'deep');
  assert.equal((restored.contentEl.querySelector('[data-setting="读取方式"] select') as unknown as HTMLSelectElement).value,'manual');
  assert.equal(ui.field(restored,'探索深度').value,'3');
  assert.equal(ui.field(restored,'网页读取上限').value,'12');
});

test('a late failed start cannot restore an old form over a newer seed setup',async()=>{
  const ui=uiFixture(),older=await ui.openSeed();
  await ui.check(older.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  let reject!:(error:Error)=>void;
  ui.plugin.startLive=async()=>new Promise<string>((_resolve,fail)=>{reject=fail;});
  ui.dispatchClick(ui.button(older,'开始发现'));await Promise.resolve();
  assert.ok(reject);assert.equal(older.closed,true);
  ui.plugin.openSeed({kind:'topic',value:'新的探索起点'});
  const newer=ui.modals.at(-1)!;
  ui.dispatchInput(ui.field(newer,'知识起点'),'用户正在编辑的新方向');
  const count=ui.modals.length;
  reject(new Error('旧起点的延迟保存错误。'));await ui.settle();
  assert.equal(ui.modals.length,count);assert.equal(ui.modals.at(-1),newer);
  assert.equal(newer.closed,false);assert.equal(ui.field(newer,'知识起点').value,'用户正在编辑的新方向');
  assert.ok(!ui.notices.some(message=>message.includes('旧起点的延迟保存错误')));
});

test('a failed start arriving after plugin unload cannot recreate its setup modal',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  let reject!:(error:Error)=>void;
  ui.plugin.startLive=async()=>new Promise<string>((_resolve,fail)=>{reject=fail;});
  ui.dispatchClick(ui.button(seed,'开始发现'));await Promise.resolve();assert.ok(reject);
  ui.plugin.onunload();reject(new Error('已卸载插件的延迟错误。'));await ui.settle();
  assert.equal(ui.modals.length,1);assert.equal(seed.closed,true);assert.equal(seed.contentEl.children.length,0);
  assert.ok(!ui.notices.some(message=>message.includes('已卸载插件的延迟错误')));
});

test('an aborted live start stays closed without restoring a draft or displaying a save failure',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();
  await ui.check(seed.contentEl.querySelector('[data-setting="开始后直接显示关系图"] input') as unknown as HTMLInputElement,true);
  ui.plugin.startLive=async()=>{const error=new Error('用户已取消建立起点。');error.name='AbortError';throw error;};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(seed.closed,true);assert.equal(ui.modals.length,1);assert.equal(seed.contentEl.children.length,0);
  assert.ok(!ui.notices.some(message=>message.includes('用户已取消建立起点')));
});

test('invalid visible numeric and keyword fields block discovery rather than using prior valid values', async () => {
  const ui=uiFixture(); const seed=await ui.openSeed(); let calls=0;
  ui.plugin.discover=async()=>{calls++;return fixtureGraph();};
  const depth=ui.field(seed,'探索深度');
  await ui.input(depth,'999'); await ui.click(ui.button(seed,'开始发现'));
  assert.equal(calls,0); assert.equal(depth.getAttribute('aria-invalid'),'true'); assert.ok(ui.reported.has(depth));
  assert.ok(seed.contentEl.textContent?.includes('请先修正标出的参数'));
  await ui.input(depth,'3');
  const words=ui.field(seed,'补充检索词');
  await ui.input(words,Array.from({length:21},(_,i)=>`术语${i}`).join('\n'));
  await ui.click(ui.button(seed,'开始发现')); assert.equal(calls,0); assert.ok(ui.reported.has(words));
  await ui.input(words,'神经科学'); await ui.click(ui.button(seed,'开始发现')); assert.equal(calls,1);
});

test('filtered batch deselection preserves hidden checks and seed while saving actual evidence closure', async () => {
  const ui=uiFixture(); const preview=await ui.openPreview();
  await ui.check(ui.field(preview,'保留 神经元'),true);
  const type=preview.contentEl.querySelector('.knowledge-seed-toolbar select') as unknown as HTMLSelectElement;
  await ui.choose(type,'web');
  assert.equal(preview.contentEl.querySelectorAll('.knowledge-seed-preview-node').length,1);
  await ui.click(ui.button(preview,'取消筛选结果'));
  assert.equal((preview as any).selected.has('web'),false);
  assert.equal((preview as any).selected.has('note'),true);
  assert.equal((preview as any).selected.has('concept'),true);
  assert.equal((preview as any).selected.has('seed'),true);
  await ui.choose(type,'all');
  assert.equal(ui.field(preview,'保留 神经元').checked,true);
  assert.equal(ui.field(preview,'保留 脑科学').disabled,true);
  assert.ok(preview.contentEl.textContent?.includes('1 个已勾选概念因来源未保留'));
  let saved: KnowledgeGraph|undefined;
  ui.plugin.persist=async(graph:KnowledgeGraph)=>{saved=graph;};
  await ui.click(ui.button(preview,'保存并打开原生关系图'));
  assert.deepEqual(saved?.nodes.map(node=>node.id),['seed','note']);
  assert.equal(saved?.edges.length,1);
});

test('preview retains mentioned concepts by default and readable-only reset remains an explicit choice', async () => {
  const ui=uiFixture(); const preview=await ui.openPreview();
  assert.equal(ui.field(preview,'保留 脑科学').checked,true);
  assert.equal(ui.field(preview,'保留 脑科学').disabled,true);
  assert.equal(ui.field(preview,'保留 神经科学网页').checked,true);
  assert.equal(ui.field(preview,'保留 睡眠笔记').checked,true);
  assert.equal(ui.field(preview,'保留 神经元').checked,true);
  assert.ok(preview.contentEl.textContent?.includes('1 个概念待补正文'));
  assert.ok(preview.contentEl.textContent?.includes('发现名称不代表没有相关内容'));
  await ui.check(ui.field(preview,'保留 神经元'),true);
  await ui.check(ui.field(preview,'保留 睡眠笔记'),false);
  assert.equal((preview as any).selected.has('concept'),true);
  assert.equal((preview as any).selected.has('note'),false);
  const type=preview.contentEl.querySelector('.knowledge-seed-toolbar select') as unknown as HTMLSelectElement;
  await ui.choose(type,'concept');
  await ui.click(ui.button(preview,'只选有正文的来源'));
  assert.equal(ui.field(preview,'保留 神经元').checked,false);
  await ui.choose(type,'all');
  assert.equal(ui.field(preview,'保留 睡眠笔记').checked,true);
  assert.equal(ui.field(preview,'保留 神经科学网页').checked,true);
  let saved: KnowledgeGraph|undefined;
  ui.plugin.persist=async(graph:KnowledgeGraph)=>{saved=graph;};
  await ui.click(ui.button(preview,'保存并打开原生关系图'));
  assert.deepEqual(saved?.nodes.map(node=>node.id),['seed','web','note']);
  assert.equal(saved?.edges.length,2);
});

test('preview UI distinguishes reusable body from empty placeholders and reports actual body length and complete short originals', async () => {
  const graph=fixtureGraph(); const text='正文测试。'.repeat(420), heading='标题不计入正文'.repeat(100);
  graph.nodes[1].article={blocks:[{type:'heading',level:2,text:heading},{type:'paragraph',text}],
    textChars:text.length+heading.length+2,totalTextChars:text.length+heading.length+2,truncated:false};
  const short='短网页原文必须全部保留。';
  graph.nodes.push({id:'short-web',kind:'web',title:'短原文',locator:'https://example.org/short',excerpt:short,status:'retrieved',depth:1,
    article:{blocks:[{type:'paragraph',text:short}],textChars:short.length,totalTextChars:short.length,truncated:false}});
  graph.nodes.push({id:'existing-body',kind:'concept',title:'已有正文',locator:'Knowledge Seed/网页/已有正文.md',excerpt:'复用原文',bodyAvailable:true,status:'derived',depth:2});
  graph.nodes.push({id:'empty-owned',kind:'concept',title:'旧空占位',locator:'Knowledge Seed/概念/旧空占位.md',excerpt:'只有证据',bodyAvailable:false,status:'derived',depth:2});
  const ui=uiFixture();
  graph.request={seed:{kind:'topic',value:graph.seed},options:{...ui.plugin.settings,readingMode:'manual',maxBodyChars:2000}};
  const preview=await ui.openPreview(graph);
  assert.equal(ui.field(preview,'保留 已有正文').checked,true);
  assert.equal(ui.field(preview,'保留 旧空占位').checked,true);
  assert.ok(preview.contentEl.textContent?.includes('复用已有笔记正文，保留原文件内容。'));
  assert.ok(preview.contentEl.textContent?.includes(`详细正文 ${text.length.toLocaleString()} 字符`));
  assert.ok(preview.contentEl.textContent?.includes('为保留完整段落，正文超过 2,000 字符目标'));
  assert.ok(preview.contentEl.textContent?.includes('原文不足 2000 字，已完整保留。'));
});

test('saving is disabled when no successfully read source remains', async () => {
  const ui=uiFixture(); const preview=await ui.openPreview();
  await ui.click(ui.button(preview,'取消筛选结果'));
  assert.equal((preview as any).selected.size,1);
  const save=ui.button(preview,'保存并打开原生关系图');
  assert.equal(save.disabled,true); assert.ok(preview.contentEl.textContent?.includes('至少保留一个已成功读取的来源'));
  let calls=0; ui.plugin.persist=async()=>{calls++;};
  await ui.click(save); assert.equal(calls,0);
  await ui.click(ui.button(preview,'选择筛选结果'));
  assert.equal(save.disabled,false);
});

test('closing a preview clears pending search renders', async () => {
  const ui=uiFixture(); const preview=await ui.openPreview();
  const otherTimers=ui.timerCount();
  const search=preview.contentEl.querySelector('[placeholder="搜索名称、摘要、来源…"]') as unknown as HTMLInputElement;
  await ui.input(search,'睡眠'); assert.equal(ui.timerCount(),otherTimers+1);
  preview.close(); assert.equal(ui.timerCount(),otherTimers,'closing the preview clears its own search timer and keeps unrelated background history saves');
  ui.flushTimers(); assert.equal(preview.contentEl.children.length,0);
});

test('adaptive UI migrates old defaults and keeps numeric limits inside closed advanced controls',async()=>{
  const ui=uiFixture();const seed=await ui.openSeed();
  assert.equal(ui.plugin.settings.readingMode,'adaptive');
  const pace=seed.contentEl.querySelector('[data-setting="阅读节奏"] select') as unknown as HTMLSelectElement;
  assert.equal(pace.value,'balanced');assert.equal(pace.closest('details'),null);
  assert.equal(ui.field(seed,'补充检索词').closest('details'),null);
  const advanced=ui.field(seed,'网页读取上限').closest('details') as unknown as HTMLDetailsElement;
  assert.ok(advanced);assert.notEqual(advanced.open,true);
  assert.ok(!seed.contentEl.querySelector('.knowledge-seed-summary')?.textContent?.includes('最多读取'));
  await ui.choose(pace,'fast');assert.equal((seed as any).runOptions.readingPace,'fast');
  ui.settingTabs[0].display();
  const settings=ui.settingTabs[0].containerEl as HTMLElement;
  assert.equal(settings.querySelector('[data-setting="阅读节奏"]')?.closest('details'),null);
  assert.ok(settings.querySelector('[aria-label="每网页正文字符数"]')?.closest('details'));
  const legacy=uiFixture();legacy.plugin.loadData=async()=>({readingMode:'manual',web:false,liveGraph:false});
  await legacy.openSeed();assert.equal(legacy.plugin.settings.readingMode,'manual');
});

test('progressive discovery shows real body snapshots then gracefully keeps current results',async()=>{
  const ui=uiFixture();const seed=await ui.openSeed();let release!:()=>void;let hooks:any;
  const graph=fixtureGraph();graph.nodes[1].reading={state:'ready'};graph.nodes[3].reading={state:'pending',reason:'尚未读取已知来源'};
  ui.plugin.discover=async(_seed:unknown,_progress:unknown,options:any,nextHooks:any)=>{
    assert.equal(options.readingMode,'adaptive');hooks=nextHooks;ui.plugin.activeController=new AbortController();
    hooks.onSnapshot(graph);await new Promise<void>(resolve=>{release=resolve;});
    assert.equal(hooks.shouldFinish(),true);return graph;
  };
  ui.dispatchClick(ui.button(seed,'开始发现'));await Promise.resolve();
  assert.ok(seed.contentEl.textContent?.includes('神经科学网页'));assert.ok(seed.contentEl.textContent?.includes('正文可读'));
  assert.equal(ui.button(seed,'查看当前结果').disabled,false);
  ui.dispatchClick(ui.button(seed,'查看当前结果'));assert.equal(ui.plugin.activeController.signal.aborted,false);
  release();await ui.settle();
  assert.equal(ui.modals.at(-1)?.title,'预览知识地图');assert.equal(seed.closed,true);
});

test('Escape close during discovery aborts and ignores later snapshots and results',async()=>{
  const ui=uiFixture();const seed=await ui.openSeed();let release!:()=>void;let hooks:any;
  ui.plugin.discover=async(_seed:unknown,_progress:unknown,_options:any,nextHooks:any)=>{
    hooks=nextHooks;ui.plugin.activeController=new AbortController();await new Promise<void>(resolve=>{release=resolve;});return fixtureGraph();
  };
  ui.dispatchClick(ui.button(seed,'开始发现'));await Promise.resolve();
  seed.close();assert.equal(ui.plugin.activeController.signal.aborted,true);
  hooks.onSnapshot(fixtureGraph());release();await ui.settle();
  assert.equal(ui.modals.length,1);assert.equal(seed.contentEl.children.length,0);
});

test('body completion preserves deselection across aliases and filtering while disabling saving',async()=>{
  const ui=uiFixture();const preview=await ui.openPreview();
  await ui.check(ui.field(preview,'保留 神经元'),false);
  const type=preview.contentEl.querySelector('.knowledge-seed-toolbar select') as unknown as HTMLSelectElement;
  await ui.choose(type,'concept');let release!:()=>void;let hooks:any;
  const next=fixtureGraph();next.nodes=next.nodes.filter(node=>node.id!=='concept');
  next.nodes.push({id:'neuron-web',mergedIds:['concept'],kind:'web',title:'神经元',excerpt:'读取到了神经元正文',locator:'https://example.org/neuron',depth:2,status:'retrieved',reading:{state:'ready'}});
  next.nodes.push({id:'new-concept',kind:'concept',title:'轴突',excerpt:'正文提及轴突',depth:3,status:'derived',reading:{state:'pending'}});
  next.edges=next.edges.filter(edge=>edge.to!=='concept');next.edges.push({id:'neuron-axon',from:'neuron-web',to:'new-concept',relation:'mentions',evidence:[{sourceId:'neuron-web',quote:'轴突',method:'正文提及'}]});
  ui.plugin.complete=async(_graph:unknown,_progress:unknown,nextHooks:any)=>{
    hooks=nextHooks;ui.plugin.activeController=new AbortController();hooks.onSnapshot(next);await new Promise<void>(resolve=>{release=resolve;});return next;
  };
  ui.dispatchClick(ui.button(preview,'继续探索全部候选'));await Promise.resolve();
  assert.equal(ui.button(preview,'保存并打开原生关系图').disabled,true);
  assert.equal((preview as any).selected.has('neuron-web'),false);
  assert.equal((preview as any).selected.has('new-concept'),true);
  assert.equal((preview.contentEl.querySelector('.knowledge-seed-toolbar select') as unknown as HTMLSelectElement).value,'concept');
  assert.ok(preview.contentEl.textContent?.includes('轴突'));
  ui.dispatchClick(ui.button(preview,'停止补充，保留已读'));assert.equal(hooks.shouldFinish(),true);
  assert.equal(ui.plugin.activeController.signal.aborted,false);release();await ui.settle();
  assert.equal(ui.button(preview,'保存并打开原生关系图').disabled,false);
  assert.equal((preview as any).selected.has('neuron-web'),false);
});

test('closing a body completion aborts and cannot render or persist a late result',async()=>{
  const ui=uiFixture();const preview=await ui.openPreview();let release!:()=>void;let hooks:any;let writes=0;
  ui.plugin.persist=async()=>{writes++;};
  ui.plugin.complete=async(_graph:unknown,_progress:unknown,nextHooks:any)=>{
    hooks=nextHooks;ui.plugin.activeController=new AbortController();await new Promise<void>(resolve=>{release=resolve;});return fixtureGraph();
  };
  const individual=[...preview.contentEl.querySelectorAll('button')].find(button=>button.textContent==='补充正文') as unknown as HTMLButtonElement;
  ui.dispatchClick(individual);await Promise.resolve();assert.deepEqual([...hooks.targetIds],['concept']);
  preview.close();assert.equal(ui.plugin.activeController.signal.aborted,true);
  hooks.onSnapshot(fixtureGraph());release();await ui.settle();
  assert.equal(preview.contentEl.children.length,0);assert.equal(writes,0);
});

test('preview reads full structured source before save as inert text rather than remote HTML',async()=>{
  const ui=uiFixture();const graph=fixtureGraph();
  const text='详细段落'.repeat(600);graph.nodes[1].article={blocks:[{type:'heading',level:2,text:'正文标题'},{type:'paragraph',text},{type:'paragraph',text:'<script>window.attack()</script>'},{type:'table',rows:[['概念','解释'],['神经元','细胞']]}],textChars:text.length,totalTextChars:text.length,truncated:false};
  const preview=await ui.openPreview(graph);
  const details=[...preview.contentEl.querySelectorAll('details')].find(details=>details.querySelector('summary')?.textContent==='阅读全文') as unknown as HTMLDetailsElement;
  assert.ok(details);ui.toggleDetails(details);
  const body=details.querySelector('.knowledge-seed-article-body')!;
  assert.ok(body.textContent?.includes(text));assert.ok(body.textContent?.includes('<script>window.attack()</script>'));
  assert.equal(body.querySelector('script'),null);assert.equal(body.querySelectorAll('td').length,4);
});

test('a body already being read stays open when progressive completion updates arrive',async()=>{
  const ui=uiFixture();const graph=fixtureGraph(),text='正在阅读的原文段落。'.repeat(300);
  graph.nodes[1].article={blocks:[{type:'paragraph',text}],textChars:text.length,totalTextChars:text.length,truncated:false};
  graph.request={seed:{kind:'topic',value:graph.seed},options:{...ui.plugin.settings,readingMode:'adaptive'}};
  const preview=await ui.openPreview(graph);
  const details=preview.contentEl.querySelector('.knowledge-seed-article-preview') as unknown as HTMLDetailsElement;
  ui.toggleDetails(details);details.querySelector('.knowledge-seed-article-body')!.scrollTop=120;
  assert.ok(!preview.contentEl.textContent?.includes('详细正文'));
  let release!:()=>void;let hooks:any;
  ui.plugin.complete=async(_graph:unknown,_progress:unknown,nextHooks:any)=>{hooks=nextHooks;await new Promise<void>(resolve=>{release=resolve;});return graph;};
  ui.dispatchClick(ui.button(preview,'补全已选概念'));await Promise.resolve();hooks.onSnapshot(graph);
  const restored=preview.contentEl.querySelector('.knowledge-seed-article-preview') as unknown as HTMLDetailsElement;
  assert.equal(restored.open,true);assert.ok(restored.textContent?.includes(text));
  assert.equal(restored.querySelector('.knowledge-seed-article-body')!.scrollTop,120);
  release();await ui.settle();
});

test('local-only previews explain why network body completion is unavailable',async()=>{
  const ui=uiFixture(),graph=fixtureGraph();
  graph.request={seed:{kind:'topic',value:graph.seed},options:{...ui.plugin.settings,web:false}};
  const preview=await ui.openPreview(graph);let calls=0;ui.plugin.complete=async()=>{calls++;return graph;};
  assert.equal(ui.button(preview,'补全已选概念').disabled,true);
  assert.equal(ui.button(preview,'继续探索全部候选').disabled,true);
  assert.equal(ui.button(preview,'补充正文').disabled,true);
  assert.ok(preview.contentEl.textContent?.includes('请开启公开网页后重新探索'));
  await ui.click(ui.button(preview,'补充正文'));assert.equal(calls,0);
});

test('preview content filters reveal missing bodies without changing retained selections',async()=>{
  const ui=uiFixture(),graph=fixtureGraph();delete graph.nodes[1].article;
  graph.nodes[3].reading={state:'failed',reason:'来源暂时无法读取'};
  const preview=await ui.openPreview(graph);
  assert.ok(preview.contentEl.textContent?.includes('仅有摘录，待补正文'));
  assert.ok(preview.contentEl.textContent?.includes('1 项正文可读'));
  const filter=ui.field(preview,'按内容状态筛选') as unknown as HTMLSelectElement;
  await ui.choose(filter,'issues');
  assert.deepEqual([...preview.contentEl.querySelectorAll('[data-node-id]')].map(node=>node.getAttribute('data-node-id')),['concept']);
  assert.equal((preview as any).selected.size,4);
  await ui.click(ui.button(preview,'清除筛选'));
  assert.equal(preview.contentEl.querySelectorAll('[data-node-id]').length,4);
  assert.equal((preview as any).selected.size,4);
  assert.ok(preview.contentEl.textContent?.includes('复用 1 篇已有笔记'));
});

test('selected concept completion respects deselections even when other candidates are hidden',async()=>{
  const ui=uiFixture(),graph=fixtureGraph();
  graph.nodes.push({id:'axon',kind:'concept',title:'轴突',excerpt:'正文提及轴突',status:'derived',depth:2,reading:{state:'pending'}});
  graph.edges.push({id:'web-axon',from:'web',to:'axon',relation:'mentions',evidence:[{sourceId:'web',quote:'轴突',method:'正文链接'}]});
  const preview=await ui.openPreview(graph);
  await ui.check(ui.field(preview,'保留 神经元'),false);
  await ui.choose(ui.field(preview,'按内容状态筛选') as unknown as HTMLSelectElement,'readable');
  assert.equal(preview.contentEl.querySelectorAll('[data-node-id]').length,2);
  let targets:string[]|undefined;
  ui.plugin.complete=async(_graph:unknown,_progress:unknown,hooks:any)=>{targets=[...hooks.targetIds];return graph;};
  await ui.click(ui.button(preview,'补全已选概念'));
  assert.deepEqual(targets,['axon']);
  assert.equal((preview as any).selected.has('concept'),false);
  assert.equal((preview as any).selected.has('axon'),true);
});

test('article finding highlights real paragraphs and chapter navigation preserves full inert prose',async()=>{
  const ui=uiFixture(),graph=fixtureGraph();
  graph.nodes[1].article={blocks:[{type:'heading',level:2,text:'结构'},
    {type:'paragraph',text:'神经元 neuron 的详细正文。'},{type:'paragraph',text:'第二段：神经元 neuron 与轴突。'},
    {type:'paragraph',text:'<img onerror=attack()>不能执行。'}],textChars:60,totalTextChars:60,truncated:false};
  const preview=await ui.openPreview(graph),details=preview.contentEl.querySelector('.knowledge-seed-article-preview') as unknown as HTMLDetailsElement;
  ui.toggleDetails(details);
  const body=details.querySelector('.knowledge-seed-article-body')!;
  const before=body.textContent;
  await ui.input(ui.field(preview,'在原文中查找'),'ＮＥＵＲＯＮ 神经元');
  assert.equal(body.querySelectorAll('.knowledge-seed-search-match').length,2);
  assert.equal(body.querySelector('.knowledge-seed-active-match')?.getAttribute('data-article-block'),'1');
  await ui.click(ui.button(preview,'下一处'));
  assert.equal(body.querySelector('.knowledge-seed-active-match')?.getAttribute('data-article-block'),'2');
  assert.ok(preview.contentEl.textContent?.includes('匹配 2 个段落或章节 · 第 2 处'));
  assert.equal(body.textContent,before);assert.equal(body.querySelector('img'),null);
  assert.equal(details.querySelector('nav')?.textContent,'结构');
  await ui.input(ui.field(preview,'在原文中查找'),'不存在');
  assert.equal(ui.button(preview,'下一处').disabled,true);assert.ok(preview.contentEl.textContent?.includes('未找到匹配内容'));
});

test('discovery errors retain actual completed snapshots for explicit review without automatic saving',async()=>{
  const ui=uiFixture(),seed=await ui.openSeed();let writes=0;ui.plugin.persist=async()=>{writes++;};
  ui.plugin.discover=async(_seed:unknown,_progress:unknown,_options:unknown,hooks:any)=>{hooks.onSnapshot(fixtureGraph());throw new Error('后续来源不可用');};
  await ui.click(ui.button(seed,'开始发现'));
  assert.equal(seed.closed,false);assert.equal(ui.button(seed,'查看当前结果').disabled,false);
  assert.ok(seed.contentEl.textContent?.includes('已读取内容仍可查看'));
  await ui.click(ui.button(seed,'查看当前结果'));
  assert.equal(ui.modals.at(-1)?.title,'预览知识地图');assert.equal(writes,0);
});

test('progress snapshots preserve candidate search focus and article find text while reading',async()=>{
  const ui=uiFixture(),graph=fixtureGraph(),preview=await ui.openPreview(graph);
  const details=preview.contentEl.querySelector('.knowledge-seed-article-preview') as unknown as HTMLDetailsElement;ui.toggleDetails(details);
  const articleSearch=ui.field(preview,'在原文中查找');await ui.input(articleSearch,'神经元');articleSearch.focus();
  let hooks:any,release!:()=>void;
  ui.plugin.complete=async(_graph:unknown,_progress:unknown,nextHooks:any)=>{hooks=nextHooks;await new Promise<void>(resolve=>{release=resolve;});return graph;};
  ui.dispatchClick(ui.button(preview,'补全已选概念'));await Promise.resolve();hooks.onSnapshot(graph);
  const restored=ui.field(preview,'在原文中查找');
  assert.equal(restored.value,'神经元');assert.equal(restored.ownerDocument.activeElement,restored);
  const search=ui.field(preview,'搜索候选');ui.dispatchInput(search,'神经科学');search.focus();hooks.onSnapshot(graph);
  const restoredSearch=ui.field(preview,'搜索候选');
  assert.equal(restoredSearch.value,'神经科学');assert.equal(restoredSearch.ownerDocument.activeElement,restoredSearch);
  assert.equal(preview.contentEl.querySelectorAll('[data-node-id]').length,1);
  release();await ui.settle();
});

test('settings explain invalid output folders and preserve the last valid path',async()=>{
  const ui=uiFixture();await ui.openSeed();const tab=ui.settingTabs[0];tab.display();
  const settings=tab.containerEl as HTMLElement,input=settings.querySelector('[aria-label="输出目录"]') as unknown as HTMLInputElement;
  const original=ui.plugin.settings.outputFolder;await ui.input(input,'../escape');
  assert.equal(ui.plugin.settings.outputFolder,original);assert.equal(input.getAttribute('aria-invalid'),'true');
  assert.ok(settings.querySelector('.knowledge-seed-error')?.textContent);
  await ui.input(input,'研究图谱');assert.equal(ui.plugin.settings.outputFolder,'研究图谱');assert.equal(input.getAttribute('aria-invalid'),'false');
});

test('article preview renders only registered safe source formulas with inert text fallback',async()=>{
  const ui=uiFixture(),graph=fixtureGraph(),formula='\\frac{a}{b}',unsafe='\\href{https://example.org}{attack}';
  graph.nodes[1].article={blocks:[{type:'heading',level:2,text:formula},{type:'paragraph',text:`公式：${formula}；未登记的 $x$；${unsafe}`},
    {type:'code',text:formula}],formulas:[formula,unsafe],textChars:80,totalTextChars:80,truncated:false};
  const preview=await ui.openPreview(graph),details=preview.contentEl.querySelector('.knowledge-seed-article-preview') as unknown as HTMLDetailsElement;ui.toggleDetails(details);
  assert.deepEqual(ui.mathCalls,[formula]);
  assert.equal(details.querySelectorAll('.native-math').length,1);
  assert.ok(details.querySelector('.knowledge-seed-article-body')?.textContent?.includes(unsafe));
  assert.equal(details.querySelector('a'),null);assert.equal(details.querySelector('pre')?.textContent,formula);
});

/** A controlled queue emits public snapshots; the shipped modal still owns all UI behaviour. */
function backgroundFixtureJobs(states: BackgroundState[] = ['queued', 'reading', 'failed', 'no_match', 'interrupted', 'ready', 'skipped', 'cancelled']) {
  return states.map((state, index): BackgroundJob<{manual:boolean}> => ({
    id:`task-${index}`,path:`Knowledge Seed/概念/概念${index}.md`,ownerId:`concept-${index}`,title:`概念${index}`,
    state,created:1000+index,updated:1000+index,attempt:state==='queued'?0:1,
    ...(state==='interrupted'?{}:{data:{manual:false}}),
  }));
}

async function backgroundUI(jobs = backgroundFixtureJobs()) {
  const ui = uiFixture();
  await ui.plugin.onload();
  ui.plugin.backgroundReader?.dispose();
  const subscribers = new Set<(jobs: readonly BackgroundJob<{manual:boolean}>[]) => void>();
  const callbacks: Array<(jobs: readonly BackgroundJob<{manual:boolean}>[]) => void> = [];
  const actions: string[] = [];
  const reader = {
    jobs,
    paused:false,
    subscribe(callback: (jobs: readonly BackgroundJob<{manual:boolean}>[]) => void) {
      subscribers.add(callback);callbacks.push(callback);callback([...reader.jobs]);
      return () => subscribers.delete(callback);
    },
    pause() {reader.paused=true;actions.push('pause');emit();},
    resume() {reader.paused=false;actions.push('resume');emit();},
    cancel(id: string) {
      const job=reader.jobs.find(item=>item.id===id);
      if (!job||!['queued','reading'].includes(job.state)) return false;
      job.state='cancelled';actions.push(`cancel:${id}`);emit();return true;
    },
    cancelAll() {
      actions.push('cancel-all');for(const job of reader.jobs) if(['queued','reading'].includes(job.state)) job.state='cancelled';emit();
    },
    retry(id: string) {actions.push(`raw-retry:${id}`);return true;},
    refreshGate() {},
    exportHistory() {return reader.jobs.map(({data:_payload,...job})=>job);},
  };
  const emit = () => {for(const listener of subscribers) listener([...reader.jobs]);};
  ui.plugin.backgroundReader=reader;
  const savedPauseStates:boolean[]=[];
  ui.plugin.saveSettings=async()=>{savedPauseStates.push(ui.plugin.backgroundPaused);};
  for(const job of jobs) ui.addFile(job.path);
  const open = () => {ui.plugin.openBackgroundTasks();return ui.modals.at(-1)!;};
  const rows = (modal: typeof ui.modals[number]) => [...modal.contentEl.querySelectorAll('.knowledge-seed-background-task')];
  const rowIds = (modal: typeof ui.modals[number]) => rows(modal).map(row=>row.getAttribute('data-job-id')).sort();
  const actionButton = (modal: typeof ui.modals[number], id: string, label: string) => {
    const row=rows(modal).find(item=>item.getAttribute('data-job-id')===id);
    assert.ok(row,`missing background row ${id}`);
    const button=[...row.querySelectorAll('button')].find(item=>item.getAttribute('aria-label')===label);
    assert.ok(button,`missing background action ${label}`);return button as unknown as HTMLButtonElement;
  };
  return {...ui,reader,actions,savedPauseStates,emit,callbacks,subscribers,open,rows,rowIds,actionButton};
}

test('background task command and status bar both open the shipped task panel',async()=>{
  const ui=await backgroundUI();
  const command=ui.plugin.commands.find((item:any)=>item.id==='background-reading-tasks');
  assert.ok(command,'background task command is registered');
  command.callback();const commandPanel=ui.modals.at(-1)!;
  assert.ok(commandPanel.contentEl.querySelector('[aria-label="后台任务状态"]'));
  commandPanel.close();
  assert.equal(ui.statusBars.length,1);
  await ui.click(ui.statusBars[0] as HTMLButtonElement);
  const statusPanel=ui.modals.at(-1)!;
  assert.notEqual(statusPanel,commandPanel);
  assert.ok(statusPanel.contentEl.querySelector('[aria-label="后台任务状态"]'));
  statusPanel.close();
});

test('background task filters expose active and failed/interrupted work without mutating the queue',async()=>{
  const ui=await backgroundUI(),panel=ui.open();
  const before=ui.reader.jobs.map(job=>[job.id,job.state]);
  const filter=ui.field(panel,'后台任务状态') as unknown as HTMLSelectElement;
  assert.equal(ui.rows(panel).length,8);
  await ui.choose(filter,'active');assert.deepEqual(ui.rowIds(panel),['task-0','task-1']);
  await ui.choose(filter,'issues');assert.deepEqual(ui.rowIds(panel),['task-2','task-3','task-4']);
  await ui.choose(filter,'ready');assert.deepEqual(ui.rowIds(panel),['task-5']);
  await ui.choose(filter,'all');assert.equal(ui.rows(panel).length,8);
  assert.deepEqual(ui.reader.jobs.map(job=>[job.id,job.state]),before);
  assert.deepEqual(ui.actions,[]);
  panel.close();
});

test('background rows open the actual concept path and retry through fresh main eligibility checks',async()=>{
  const ui=await backgroundUI();let panel=ui.open();
  const retryIds:string[]=[];
  ui.plugin.retryBackgroundJob=async(id:string)=>{retryIds.push(id);return id;};
  await ui.click(ui.actionButton(panel,'task-4','打开概念 概念4'));
  assert.deepEqual(ui.openedFiles,[ui.reader.jobs[4].path]);
  assert.equal(panel.closed,true);assert.equal(ui.subscribers.size,0,'opening the note must release the blocking modal');
  assert.equal(ui.revealedLeaves.length,1);assert.equal(ui.loadedLeaves.length,1);
  panel=ui.open();
  await ui.click(ui.actionButton(panel,'task-4','重试 概念4'));
  assert.deepEqual(retryIds,['task-4']);
  assert.deepEqual(ui.actions,[],'restored payload must not be passed directly to queue.retry');
  const cancelReading=ui.actionButton(panel,'task-1','取消 概念1');
  assert.equal(cancelReading.disabled,false);
  await ui.click(cancelReading);
  assert.equal(ui.reader.jobs[1].state,'cancelled');
  assert.deepEqual(ui.actions,['cancel:task-1']);
  panel.close();
});

test('background pause/resume and cancel-all controls preserve completed tasks',async()=>{
  const ui=await backgroundUI(),panel=ui.open();
  await ui.click(ui.button(panel,'暂停后台阅读'));
  assert.equal(ui.plugin.backgroundPaused,true);assert.equal(ui.reader.paused,true);
  assert.ok(ui.button(panel,'继续后台阅读'));
  await ui.click(ui.button(panel,'继续后台阅读'));
  assert.equal(ui.plugin.backgroundPaused,false);assert.equal(ui.reader.paused,false);
  await ui.click(ui.button(panel,'取消并暂停后台阅读'));
  assert.deepEqual(ui.actions,['pause','resume','pause','cancel-all']);
  assert.equal(ui.plugin.backgroundPaused,true);assert.equal(ui.reader.paused,true);
  assert.deepEqual(ui.savedPauseStates,[true,false,true],'cancellation must persist the pause so tasks cannot immediately be repopulated');
  assert.ok(ui.button(panel,'继续后台阅读'));
  assert.equal(ui.reader.jobs[0].state,'cancelled');assert.equal(ui.reader.jobs[1].state,'cancelled');
  assert.equal(ui.reader.jobs[5].state,'ready');
  assert.equal(ui.reader.jobs[2].state,'failed');
  panel.close();
});

test('opening a concept already in a Markdown tab reuses and reveals that tab without opening the file again',async()=>{
  const ui=await backgroundUI(backgroundFixtureJobs(['failed'])),existing=ui.addMarkdownLeaf(ui.reader.jobs[0].path),panel=ui.open();
  await ui.click(ui.actionButton(panel,'task-0','打开概念 概念0'));
  assert.deepEqual(ui.openedFiles,[],'openFile would reset an existing editing view');
  assert.equal(ui.markdownLeaves.length,1);assert.equal(ui.revealedLeaves[0],existing);assert.equal(ui.loadedLeaves[0],existing);
  assert.equal(panel.closed,true);assert.equal(ui.subscribers.size,0);
});

test('failed concept navigation keeps the task panel available and reports the actual open failure',async()=>{
  const ui=await backgroundUI(backgroundFixtureJobs(['failed'])),panel=ui.open();
  ui.setOpenFailure('无法打开笔记，请稍后重试。');
  await ui.click(ui.actionButton(panel,'task-0','打开概念 概念0'));
  assert.equal(panel.closed,false);assert.equal(ui.subscribers.size,1);
  assert.match(ui.rows(panel)[0].textContent??'',/无法打开笔记/);
  assert.ok(ui.notices.some(message=>message.includes('无法打开笔记')));
  assert.equal(ui.revealedLeaves.length,0);assert.deepEqual(ui.openedFiles,[]);
  ui.setOpenFailure();ui.removeFile(ui.reader.jobs[0].path);
  await ui.click(ui.actionButton(panel,'task-0','打开概念 概念0'));
  assert.equal(panel.closed,false);assert.match(ui.rows(panel)[0].textContent??'',/已移动或删除/);
  panel.close();
});

test('opening a saved recovery record closes the task panel only after successful navigation',async()=>{
  const jobs=backgroundFixtureJobs(['failed']);jobs[0].auditFolder='Knowledge Seed/Runs/recovery-test';
  const ui=await backgroundUI(jobs),path=`${jobs[0].auditFolder}/Recovery.md`;
  const file=ui.addFile(path),panel=ui.open();
  ui.setOpenFailure('恢复记录暂时无法打开。');
  await ui.click(ui.button(panel,'查看保存与恢复记录'));
  // The native button's listener deliberately returns void; allow its async
  // navigation and error callback to finish without inventing a queue event.
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(panel.closed,false);assert.match(ui.rows(panel)[0].textContent??'',/暂时无法打开/);
  ui.setOpenFailure();
  await ui.click(ui.button(panel,'查看保存与恢复记录'));await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(panel.closed,true);assert.equal(ui.subscribers.size,0);
  assert.deepEqual(ui.openedFiles,[file.path]);assert.equal(ui.revealedLeaves.length,1);
  const missing=ui.open();ui.removeFile(path);
  await ui.click(ui.button(missing,'查看保存与恢复记录'));await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(missing.closed,false);assert.match(ui.rows(missing)[0].textContent??'',/保存记录已移动或删除/);
  missing.close();
});

test('background failure reasons are lazy inert text and closing releases subscriptions and blocks stale callbacks',async()=>{
  const jobs=backgroundFixtureJobs(['failed']);
  const reason='<img src=x onerror=attack()> %% [[伪造节点]] $x$';jobs[0].reason=reason;
  const ui=await backgroundUI(jobs),panel=ui.open();
  const row=ui.rows(panel)[0];
  assert.equal(row.textContent?.includes(reason),false,'reason is not populated before explicit expansion');
  const details=row.querySelector('details') as unknown as HTMLDetailsElement;
  assert.ok(details,'reason can be explicitly expanded');assert.notEqual(details.open,true);
  ui.toggleDetails(details);
  assert.ok(details.textContent?.includes(reason));
  assert.equal(details.querySelector('img'),null);assert.equal(details.querySelector('a'),null);
  assert.equal(ui.subscribers.size,1);
  const stale=ui.callbacks.at(-1)!;panel.close();
  assert.equal(ui.subscribers.size,0);
  assert.equal(panel.contentEl.children.length,0);
  jobs[0].state='ready';ui.emit();stale([...jobs]);
  assert.equal(panel.contentEl.children.length,0,'a stale snapshot cannot recreate a closed task panel');
});

test('expanded background reasons retain position and show fresh inert text across reader snapshots',async()=>{
  const jobs=backgroundFixtureJobs(['failed','failed']),ui=await backgroundUI(jobs),panel=ui.open();
  jobs[0].reason='第一版读取原因。';jobs[1].reason='另一个未展开的读取原因。';ui.emit();
  const row=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-0')!;
  const old=row.querySelector('details') as unknown as HTMLDetailsElement;ui.toggleDetails(old);
  const list=panel.contentEl.querySelector('.knowledge-seed-node-list')!;
  list.scrollTop=245;panel.contentEl.scrollTop=70;
  const latest='<script>attack()</script> %% [[来源名称]] 最新读取原因。';
  jobs[0].reason=latest;jobs[0].updated=9000;ui.emit();
  let refreshed=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-0')!.querySelector('details') as unknown as HTMLDetailsElement;
  assert.notEqual(refreshed,old);assert.equal(refreshed.open,true);
  assert.ok(refreshed.textContent?.includes(latest));assert.equal(refreshed.textContent?.includes('第一版'),false);
  assert.equal(refreshed.querySelector('script'),null);assert.equal(refreshed.querySelector('a'),null);
  const lazy=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-1')!;
  assert.equal(lazy.textContent?.includes(jobs[1].reason!),false,'closed reasons stay lazy after updates');
  assert.equal(list.scrollTop,245);assert.equal(panel.contentEl.scrollTop,70);
  ui.toggleDetails(old,false);
  ui.emit();
  refreshed=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-0')!.querySelector('details') as unknown as HTMLDetailsElement;
  assert.equal(refreshed.open,true,'a detached old row cannot undo the current expanded state');
  const filter=ui.field(panel,'后台任务状态') as unknown as HTMLSelectElement;
  await ui.choose(filter,'active');await ui.choose(filter,'issues');
  refreshed=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-0')!.querySelector('details') as unknown as HTMLDetailsElement;
  assert.equal(refreshed.open,true);assert.ok(refreshed.textContent?.includes(latest));
  ui.toggleDetails(refreshed,false);ui.emit();
  const collapsed=ui.rows(panel).find(item=>item.getAttribute('data-job-id')==='task-0')!.querySelector('details') as unknown as HTMLDetailsElement;
  assert.notEqual(collapsed.open,true);assert.equal(collapsed.textContent?.includes(latest),false);
  panel.close();
});

test('background retry rejects safely and an async result after close cannot reopen or repaint the task panel',async()=>{
  const ui=await backgroundUI(backgroundFixtureJobs(['failed'])),panel=ui.open();
  ui.plugin.retryBackgroundJob=async()=>{throw new Error('节点身份已变化，请重新打开概念。');};
  await ui.click(ui.actionButton(panel,'task-0','重试 概念0'));
  assert.ok(ui.notices.some(notice=>notice.includes('节点身份已变化')));
  let release!:(value:string)=>void;
  ui.plugin.retryBackgroundJob=async()=>new Promise<string>(resolve=>{release=resolve;});
  ui.dispatchClick(ui.actionButton(panel,'task-0','重试 概念0'));await Promise.resolve();
  assert.ok(release);panel.close();release('task-0');await ui.settle();
  assert.equal(panel.closed,true);assert.equal(panel.contentEl.children.length,0);
  assert.equal(ui.subscribers.size,0);assert.equal(ui.modals.at(-1),panel);
});

test('background task panel handles an empty history and live snapshots without losing its selected filter',async()=>{
  const ui=await backgroundUI([]),panel=ui.open();
  assert.equal(ui.rows(panel).length,0);
  const filter=ui.field(panel,'后台任务状态') as unknown as HTMLSelectElement;
  await ui.choose(filter,'issues');
  ui.reader.jobs.push(...backgroundFixtureJobs(['queued','failed']));ui.emit();
  assert.deepEqual(ui.rowIds(panel),['task-1']);
  assert.equal((ui.field(panel,'后台任务状态') as unknown as HTMLSelectElement).value,'issues');
  panel.close();
});
