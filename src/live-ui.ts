import { App, ItemView, Modal, Notice, type WorkspaceLeaf } from 'obsidian';

export interface LiveMapInfo {
  id: string;
  title: string;
  rootPath: string;
  state: 'running' | 'paused' | 'complete' | 'cancelled' | 'failed' | 'interrupted';
  nodes: number;
  edges: number;
  bodyReady: number;
  limit: number;
  message?: string;
}

export interface LiveMapControls {
  list(): LiveMapInfo[];
  current(): LiveMapInfo | undefined;
  subscribe(listener: () => void): () => void;
  open(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  prune(id: string, path: string, branch: boolean): Promise<void>;
  expand(id: string, path: string, direction?: string): Promise<void>;
  paths(id: string): { path: string; title: string }[];
  focus?(id:string,path:string):Promise<void>;
  configure?(id:string):Promise<void>;
  openNote?(id:string,path:string):Promise<void>;
  reading?():void;
}

export const LIVE_MAP_VIEW = 'knowledge-seed-live-map';
const stateLabels: Record<LiveMapInfo['state'], string> = {
  running: '后台探索中', paused: '探索已暂停', complete: '本轮探索完成',
  cancelled: '探索已停止', failed: '探索遇到问题', interrupted: '探索已中断',
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
  const result = parent.createEl('button', { text, attr: { type: 'button' } });
  result.addEventListener('click', () => { if (!result.disabled) action(); });
  return result;
}

/** Controls beside the core Graph view. No graph renderer or application-private API. */
export class LiveMapView extends ItemView {
  private unsubscribe?: () => void;
  private panelClosed = true;
  private pending = false;
  private lifecycle = 0;
  private lastError = '';
  private selectedPath = '';
  private selectedMap = '';
  private optionKey = '';
  private titleEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private countsEl?: HTMLElement;
  private messageEl?: HTMLElement;
  private progressEl?: HTMLProgressElement;
  private nodeSelect?: HTMLSelectElement;
  private nodeSearch?: HTMLInputElement;
  private nodeMatches?: HTMLElement;
  private directionInput?: HTMLInputElement;
  private openButton?: HTMLButtonElement;
  private pauseButton?: HTMLButtonElement;
  private stopButton?: HTMLButtonElement;
  private configureButton?: HTMLButtonElement;
  private expandButton?: HTMLButtonElement;
  private pruneButton?: HTMLButtonElement;
  private branchButton?: HTMLButtonElement;
  private focusButton?: HTMLButtonElement;
  private openNoteButton?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private readonly controls: LiveMapControls) {
    super(leaf);
    // Initialize once the public ItemView content element exists. Recent core
    // versions can defer inactive sidebar leaves before dispatching onOpen.
    void this.onOpen().catch(error=>new Notice(`图谱控制面板加载失败：${errorText(error)}`));
  }
  getViewType(): string { return LIVE_MAP_VIEW; }
  getDisplayText(): string { return '知识图谱控制'; }
  getIcon(): string { return 'network'; }

  async onOpen(): Promise<void> {
    this.unsubscribe?.();
    this.lifecycle++;
    this.pending = false;
    this.optionKey = '';
    this.panelClosed = false;
    this.contentEl.empty();
    this.contentEl.addClass('knowledge-seed-live-panel');
    const top = this.contentEl.createDiv({ cls: 'knowledge-seed-live-actions' });
    button(top, '我的知识图谱', () => new GraphLibraryModal(this.app, this.controls).open());
    if(this.controls.reading)button(top,'正文任务',()=>this.controls.reading!());
    this.titleEl = this.contentEl.createEl('h3');
    this.statusEl = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    this.countsEl = this.contentEl.createEl('p', { cls: 'knowledge-seed-live-counts' });
    this.progressEl = this.contentEl.createEl('progress', { attr: { 'aria-label': '概念发现进度' } });
    this.messageEl = this.contentEl.createEl('p', { cls: 'knowledge-seed-note' });
    const actions = this.contentEl.createDiv({ cls: 'knowledge-seed-live-actions' });
    this.openButton = button(actions, '打开关系图', () => this.perform(async () => {
      const map = this.controls.current();
      if (map) await this.controls.open(map.id);
    }));
    this.pauseButton = button(actions, '暂停探索', () => this.perform(async () => {
      const map = this.controls.current();
      if (!map) return;
      if (map.state === 'running') await this.controls.pause(map.id);
      else await this.controls.resume(map.id);
    }));
    this.stopButton = button(actions, '停止探索', () => this.perform(async () => {
      const map = this.controls.current();
      if (map) await this.controls.stop(map.id);
    }));
    if (this.controls.configure) this.configureButton = button(actions, '调整探索策略', () => this.perform(async () => {
      const map = this.controls.current();
      if (map) await this.controls.configure!(map.id);
    }));
    this.contentEl.createEl('p', { text: '关系图与正文在后台分别更新。你可以继续浏览、阅读或关闭此面板。', cls: 'knowledge-seed-note' });
    this.contentEl.createEl('h4', { text: '调整当前图谱' });
    const searchLabel = this.contentEl.createEl('label', {text:'查找节点'});
    this.nodeSearch = searchLabel.createEl('input', {type:'search',attr:{'aria-label':'查找图谱节点',placeholder:'输入名称或笔记路径',maxlength:'180'}});
    this.nodeSearch.addEventListener('input', () => {this.lastError='';this.render();});
    this.nodeMatches = this.contentEl.createEl('p', {cls:'knowledge-seed-note',attr:{role:'status','aria-live':'polite'}});
    const nodeLabel = this.contentEl.createEl('label', { text: '选择图中节点' });
    this.nodeSelect = nodeLabel.createEl('select', { attr: { 'aria-label': '选择图中节点' } });
    this.nodeSelect.addEventListener('change', () => {
      this.selectedPath = this.nodeSelect!.value;
      this.lastError = '';
      this.render();
    });
    const directionLabel = this.contentEl.createEl('label', { text: '从此处探索的方向（可选）' });
    this.directionInput = directionLabel.createEl('input', {
      type: 'text', attr: { 'aria-label': '从此处探索的方向', maxlength: '180', placeholder: '例如：统计学、实际应用' },
    });
    const edits = this.contentEl.createDiv({ cls: 'knowledge-seed-live-actions' });
    if(this.controls.openNote)this.openNoteButton=button(edits,'打开笔记',()=>this.perform(async()=>{const selected=this.selection();await this.controls.openNote!(selected.id,selected.path);}));
    this.expandButton = button(edits, '沿此节点探索', () => this.perform(async () => {
      const selected = this.selection();
      await this.controls.expand(selected.id, selected.path, this.directionInput?.value.trim() || undefined);
    }));
    if(this.controls.focus)this.focusButton=button(edits,'以此节点查看',()=>this.perform(async()=>{const selected=this.selection();await this.controls.focus!(selected.id,selected.path);}));
    this.pruneButton = button(edits, '移出此节点', () => this.perform(async () => {
      const selected = this.selection(false);
      await this.controls.prune(selected.id, selected.path, false);
    }));
    this.branchButton = button(edits, '移出此分支', () => this.perform(async () => {
      const selected = this.selection(false);
      await this.controls.prune(selected.id, selected.path, true);
    }));
    this.contentEl.createEl('p', { text: '移出只改变当前图谱范围，笔记和正文会保留。起点保留在图中。', cls: 'knowledge-seed-note' });
    this.contentEl.createEl('p', {text:'原生局部图最多显示中心附近 5 跳。远处分支可选择节点后“以此节点查看”，完整图谱成员继续保留。',cls:'knowledge-seed-note'});
    this.unsubscribe = this.controls.subscribe(() => this.render());
    this.render();
  }

  /** Capture only a currently present real node; stale UI never supplies a typed path. */
  private selection(allowRoot = true): { id: string; path: string } {
    const map = this.controls.current();
    if (!map || map.id !== this.selectedMap || !this.controls.paths(map.id).some(item => item.path === this.selectedPath))
      throw new Error('当前节点已不在图谱中，请重新选择节点。');
    if (!allowRoot && this.selectedPath === map.rootPath) throw new Error('起点保留在图中，请选择其他节点。');
    return { id: map.id, path: this.selectedPath };
  }

  private perform(operation: () => Promise<void>): void {
    if (this.panelClosed || this.pending) return;
    const lifecycle = this.lifecycle;
    this.pending = true;
    this.lastError = '';
    // Resolve the clicked node before rendering can choose a new fallback node.
    const task = operation();
    this.render();
    void task.catch(error => {
      if (this.panelClosed || lifecycle !== this.lifecycle) return;
      const message = errorText(error);
      this.lastError = message;
      this.messageEl?.setText(message);
      new Notice(message);
    }).finally(() => {
      if (lifecycle !== this.lifecycle) return;
      this.pending = false;
      if (!this.panelClosed) this.render();
    });
  }

  private render(): void {
    if (this.panelClosed || !this.nodeSelect) return;
    const map = this.controls.current();
    const paths = map ? this.controls.paths(map.id) : [];
    if ((map?.id ?? '') !== this.selectedMap) {
      this.lastError = '';
      this.selectedMap = map?.id ?? '';
      this.selectedPath = map?.rootPath ?? '';
      if (this.nodeSearch) this.nodeSearch.value = '';
      if (this.directionInput) this.directionInput.value = '';
    }
    const query = this.nodeSearch?.value.trim().toLocaleLowerCase() ?? '';
    const matching = paths.filter(node => !query || `${node.title}\n${node.path}`.toLocaleLowerCase().includes(query));
    if (!matching.some(item => item.path === this.selectedPath)) this.selectedPath = matching[0]?.path ?? '';
    const key = JSON.stringify([this.selectedMap, matching]);
    if (key !== this.optionKey) {
      this.optionKey = key;
      this.nodeSelect.empty();
      if (!matching.length) this.nodeSelect.createEl('option', { text: query?'没有匹配节点':'暂无节点', attr: { value: '' } });
      for (const node of matching) this.nodeSelect.createEl('option', { text: node.title, attr: { value: node.path } });
    }
    this.nodeSelect.value = this.selectedPath;
    this.nodeSelect.disabled = !map || !matching.length || this.pending;
    if(this.nodeSearch)this.nodeSearch.disabled=!map||this.pending;
    this.nodeMatches?.setText(map ? (query?`${matching.length} / ${paths.length} 个匹配节点`:`${paths.length} 个可选节点`) : '');
    this.titleEl?.setText(map?.title ?? '尚未选择知识图谱');
    this.statusEl?.setText(map ? `${stateLabels[map.state]}${this.pending ? ' · 正在执行操作' : ''}` : '从“我的知识图谱”打开已有图谱，或开始新的探索。');
    this.countsEl?.setText(map ? `${map.nodes} / ${map.limit} 个节点 · ${map.edges} 条关系 · ${map.bodyReady<0?'打开后检查正文状态':`${map.bodyReady} 个节点有正文`}` : '');
    this.messageEl?.setText(this.lastError || map?.message || '');
    if (this.progressEl) {
      this.progressEl.hidden = !map;
      this.progressEl.max = Math.max(1, map?.limit ?? 1);
      this.progressEl.value = Math.min(this.progressEl.max, Math.max(0, map?.nodes ?? 0));
    }
    if (this.openButton) this.openButton.disabled = !map || this.pending;
    if (this.pauseButton) {
      this.pauseButton.setText(map?.state === 'running' ? '暂停探索' : '继续探索');
      // Stop ends a pass, not the saved map. Let the controller validate the
      // remaining capacity so a reached cap gets an actionable explanation.
      this.pauseButton.disabled = !map || this.pending;
    }
    if (this.stopButton) this.stopButton.disabled = !map || this.pending || !['running', 'paused'].includes(map.state);
    if (this.configureButton) this.configureButton.disabled = !map || this.pending;
    const available = Boolean(map && this.selectedPath && !this.pending);
    if (this.expandButton) this.expandButton.disabled = !available;
    if (this.focusButton) this.focusButton.disabled = !available;
    if (this.openNoteButton) this.openNoteButton.disabled = !available;
    const removable = available && this.selectedPath !== map?.rootPath;
    if (this.pruneButton) this.pruneButton.disabled = !removable;
    if (this.branchButton) this.branchButton.disabled = !removable;
    if (this.directionInput) this.directionInput.disabled = !available;
  }

  async onClose(): Promise<void> {
    this.lifecycle++;
    this.panelClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.optionKey = '';
    this.contentEl.empty();
  }
}

/** A fast picker for saved scopes; opening never starts a fresh exploration. */
export class GraphLibraryModal extends Modal {
  private unsubscribe?: () => void;
  private panelClosed = true;
  private pending = false;
  private lifecycle = 0;
  private search?: HTMLInputElement;
  private listEl?: HTMLElement;
  private countEl?: HTMLElement;
  constructor(app: App, private readonly controls: LiveMapControls) { super(app); }

  onOpen(): void {
    this.unsubscribe?.();
    this.lifecycle++;
    this.pending = false;
    this.panelClosed = false;
    this.modalEl.addClass('knowledge-seed-window');
    this.contentEl.empty();
    this.contentEl.addClass('knowledge-seed-modal');
    this.setTitle('我的知识图谱');
    this.contentEl.createEl('p', { text: '按起点找回关系图，保留该图的范围和进度。打开已有图谱不会重新生成。', cls: 'knowledge-seed-subtitle' });
    this.search = this.contentEl.createEl('input', { type: 'search', attr: { 'aria-label': '搜索已有知识图谱', placeholder: '搜索起点名称' } });
    this.countEl = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    this.listEl = this.contentEl.createDiv({ cls: 'knowledge-seed-node-list' });
    this.search.addEventListener('input', () => this.render());
    this.unsubscribe = this.controls.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (this.panelClosed || !this.listEl) return;
    const scroll = this.listEl.scrollTop;
    const focused = this.listEl.ownerDocument.activeElement;
    const focusedId = focused && this.listEl.contains(focused)
      ? focused.closest('[data-map-id]')?.getAttribute('data-map-id') : undefined;
    const all = this.controls.list();
    const query = this.search?.value.trim().toLocaleLowerCase() ?? '';
    const visible = all.filter(map => !query || map.title.toLocaleLowerCase().includes(query));
    this.countEl?.setText(`${visible.length} / ${all.length} 个知识图谱`);
    this.listEl.empty();
    if (!visible.length) this.listEl.createEl('p', { text: all.length ? '没有匹配的起点。' : '还没有保存的知识图谱。开始探索后，图谱会自动出现在这里。', cls: 'knowledge-seed-empty' });
    for (const map of visible) {
      const row = this.listEl.createDiv({ cls: 'knowledge-seed-preview-node', attr: { 'data-map-id': map.id } });
      row.createEl('strong', { text: map.title });
      row.createEl('p', { text: `${stateLabels[map.state]} · ${map.nodes} 个节点 · ${map.edges} 条关系 · ${map.bodyReady<0?'打开后检查正文状态':`${map.bodyReady} 个节点有正文`}` });
      const open = button(row, '打开关系图', () => {
        if (this.pending || this.panelClosed) return;
        const lifecycle = this.lifecycle;
        this.pending = true;
        this.render();
        void Promise.resolve().then(() => this.controls.open(map.id)).then(() => {
          if (!this.panelClosed && lifecycle === this.lifecycle) this.close();
        }).catch(error => {
          if (!this.panelClosed && lifecycle === this.lifecycle) new Notice(errorText(error));
        }).finally(() => {
          if (lifecycle !== this.lifecycle) return;
          this.pending = false; if (!this.panelClosed) this.render();
        });
      });
      open.setAttribute('aria-label', `打开关系图 ${map.title}`);
      open.disabled = this.pending;
      if (map.id === focusedId && !open.disabled) open.focus();
    }
    this.listEl.scrollTop = scroll;
  }

  onClose(): void {
    this.lifecycle++;
    this.panelClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }
}
