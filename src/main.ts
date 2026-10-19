import { App, FuzzySuggestModal, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, renderMath, finishRenderMath, type WorkspaceLeaf } from 'obsidian';
import { Cancelled, checkAbort, clampOptions, defaults, generateGraph, type EngineAdapter, type Options, type Seed } from './engine';
import { addEdge, filterGraph, nodeId, normalizeText, relationLabels, stableId, type KnowledgeGraph } from './graph';
import { exportGraph, safeFolder, safeName, saveBundle, mergeManagedLinks, mergeManagedArticle, mergeManagedWebMetadata, mergeManagedReading, nativeSearch, webReading, type ExportBundle, type ManagedUpdate } from './export';
import { publicUrl } from './web';
import { cleanKnowledgeTitle } from './titles';
import { planNameCleanup, type NameChange } from './names';
import { readHistory, rememberRun, moveRun, type NativeRun, type RunRecord } from './history';
import { cloneRunOptions, applyPreset, presets, validateNumericInput, validateDiscovery, type DiscoveryConfig, type PresetId } from './workflow';
import { filterPreviewNodes, selectVisibleNodes, previewSelectionSummary, defaultPreviewSelection, readablePreviewSelection, nodeEvidence, hasPreviewBody, previewReadingState, previewReadingSummary, selectedCompletionTargets, inheritPreviewSelection, articleSearchMatches, type PreviewReadingFilter, type PreviewSort } from './preview';
import { articleBodyTextChars, articleTextSegments, type ArticleContent } from './article';
import { discoverDynamic, completeDynamic, type ReadingHooks } from './dynamic';
import { coalesceGraph, planLegacyMerges, planSourceMerges, mergeDuplicateContent, mergeGeneratedAliases, type MergeCandidate, type MergeNote } from './dedup';
import { executeMergeTransaction, MergeTransactionError } from './merge-transaction';
import { integrateNativeRuns } from './integrated-graph';
import { managedAliases, managedHeader, managedValue } from './ownership';
import { BackgroundReader, type BackgroundJob } from './background';
import { readManagedNote, type ManagedNoteState } from './managed-note';
import { exploreConcepts, explorationSummary } from './exploration';
import { readLiveMaps, serializeLiveMaps, visibleLiveGraph, pruneLiveMap, mergeLiveGraph, foldOwnedRootFileViews, type LiveMapRecord } from './live-map';
import { LIVE_MAP_VIEW, LiveMapView, GraphLibraryModal, type LiveMapInfo, type LiveMapControls } from './live-ui';
import { renderExplorationStrategyControls, explorationStrategyDescription } from './strategy-ui';
import { moveRoaming, projectRoaming, readRoaming, type RoamingAction, type RoamingState } from './roaming';

interface Settings extends Options { outputFolder: string; exportCanvas: boolean; graphDepth: number; backgroundReading: boolean; liveGraph: boolean }
const initialSettings: Settings = { ...defaults, readingMode: 'adaptive', explorationStrategy:'focused', outputFolder: 'Knowledge Seed', exportCanvas: false, graphDepth: 3, backgroundReading: true, liveGraph: true };
const liveReadingLimits = {
  fast: {depth:2,maxPages:24,maxConcepts:120,maxNotes:6},
  balanced: {depth:4,maxPages:64,maxConcepts:320,maxNotes:12},
  deep: {depth:6,maxPages:160,maxConcepts:800,maxNotes:24}
} as const;
// Core local Graph clamps its depth control to 5 (verified in Obsidian 1.12.7).
const displayDepth = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(5, Math.max(0, Math.floor(value))) : 3;
const kindLabels = { seed: '知识起点', web: '公开网页', note: '已有笔记', concept: '提及概念' };
const friendlyError = (error: unknown) => error instanceof Error ? error.message : String(error);

export default class KnowledgeSeedPlugin extends Plugin {
  settings: Settings = { ...initialSettings };
  activeController?: AbortController;
  busy = false;
  lastRun?: NativeRun;
  history: RunRecord[] = [];
  managedNotes = new Map<string, ManagedNoteState>();
  private nativeRootLeaf?: WorkspaceLeaf;
  private nativeGraphLeaf?: WorkspaceLeaf;
  private nativeRootFile?: string;
  private nativeGraphFile?: string;
  private nativeOpenTask: Promise<void> = Promise.resolve();
  backgroundReader?: BackgroundReader<{ manual: boolean; mapId?: string }>;
  private backgroundStatus?: HTMLElement;
  private disposed = false;
  backgroundPaused = false;
  private backgroundCancelGeneration=0;
  private settingsSaveTask: Promise<void> = Promise.resolve();
  private backgroundSaveTimer?: ReturnType<typeof setTimeout>;
  liveMaps: LiveMapRecord[] = [];
  currentLiveId?: string;
  private liveControllers = new Map<string, AbortController>();
  private liveTasks = new Map<string, Promise<void>>();
  private liveListeners = new Set<() => void>();
  private liveWriting = false;
  private liveBodyFeeding = false;
  private liveBodyAttempted = new Set<string>();
  private liveBodyFailures = new Set<string>();
  private seedSetupGeneration=0;
  private liveLeaves = new Map<string, WorkspaceLeaf>();
  private liveLeafStates = new Map<string, {file:string;search:string}>();
  private liveGraphRefreshTimer?: ReturnType<typeof setTimeout>;
  private liveGraphSyncTasks = new Map<string,Promise<void>>();
  private liveControlVersions = new Map<string,number>();
  private liveControlIntents = new Map<string,'paused'|'cancelled'|'running'>();
  private liveEnabled = new Set<string>();
  private liveCenters = new Map<string,string>();
  private roamingStates = new Map<string,RoamingState>();
  private restoreOverviewDepth = new Set<string>();

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) ?? {};
    this.settings = { ...initialSettings, ...clampOptions({...loaded,readingMode:loaded.readingMode??'adaptive',explorationStrategy:loaded.explorationStrategy??initialSettings.explorationStrategy}), graphDepth: displayDepth(loaded.graphDepth), outputFolder: typeof loaded.outputFolder === 'string' ? loaded.outputFolder : initialSettings.outputFolder, exportCanvas: loaded.exportCanvas === true, backgroundReading: loaded.backgroundReading !== false, liveGraph: loaded.liveGraph !== false };
    if (loaded.lastRun && typeof loaded.lastRun.rootPath === 'string' && typeof loaded.lastRun.search === 'string') this.lastRun = loaded.lastRun;
    this.history = readHistory(loaded.history);
    this.liveMaps = readLiveMaps(loaded.liveMaps);
    this.roamingStates = readRoaming(loaded.roaming, this.liveMaps.map(map=>({id:map.id,graph:visibleLiveGraph(map)})));
    this.currentLiveId = this.liveMaps.some(map=>map.id===loaded.currentLiveId) ? loaded.currentLiveId : this.liveMaps[0]?.id;
    if (this.lastRun) this.restoreNativeLeaves(this.lastRun);
    this.addSettingTab(new KnowledgeSeedSettings(this.app, this));
    this.addRibbonIcon('network', 'Knowledge Seed：从起点生成知识地图', () => this.openSeed());
    this.addRibbonIcon('folder-search', 'Knowledge Seed：我的知识图谱', () => this.openGraphLibrary());
    if(typeof this.app.workspace.detachLeavesOfType==='function')this.app.workspace.detachLeavesOfType(LIVE_MAP_VIEW);
    if (typeof this.registerView==='function') this.registerView(LIVE_MAP_VIEW,leaf=>new LiveMapView(leaf,this.liveControls()));
    this.addCommand({id:'graph-library',name:'我的知识图谱',callback:()=>this.openGraphLibrary()});
    this.addCommand({id:'graph-controls',name:'当前图谱：剪枝与继续探索',callback:()=>this.showLiveControls()});
    this.addCommand({ id: 'generate-knowledge-map', name: '从网页或主题生成知识地图', callback: () => this.openSeed() });
    this.addCommand({ id: 'generate-from-current-note', name: '从当前笔记生成知识地图', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void this.openFromFile(file); return true;
    } });
    this.addCommand({ id: 'cancel-discovery', name: '取消当前发现任务', callback: () => this.activeController?.abort() });
    this.addCommand({ id: 'discovery-history', name: '探索历史与重新探索', callback: () => new HistoryModal(this.app, this).open() });
    this.addCommand({ id: 'open-native-graph', name: '打开上次原生知识图谱', callback: async () => {
      if (!this.lastRun) { new Notice('请先生成并保存一次知识图谱。'); return; }
      try { await this.openNativeGraph(this.lastRun); } catch (e) { new Notice(friendlyError(e)); }
    } });
    this.addCommand({ id: 'clean-generated-names', name: '整理旧生成节点名称（先预览）', callback: () => {
      if (this.busy) { new Notice('请等待当前任务结束。'); return; }
      new NameCleanupModal(this.app, this).open();
    } });
    this.addCommand({ id: 'merge-duplicate-nodes', name: '合并重复概念与正文节点（先预览）', callback: () => {
      if (this.busy) { new Notice('请等待当前任务结束。'); return; }
      new DuplicateMergeModal(this.app, this).open();
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      if(leaf)this.selectLiveGraphLeaf(leaf);
      menu.addItem(item => item.setTitle('从此笔记生成知识地图').setIcon('network').onClick(this.liveMenuAction(() => this.openFromFile(file))));
      const path=file.path;
      const owners=this.liveMaps.filter(map=>visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===path));
      const current=owners.find(map=>map.id===this.currentLiveId);
      const targets=current?[current]:owners;
      for(const [index,map] of targets.entries()) {
        const suffix=targets.length>1?`（${map.title} · 图谱 ${index+1}）`:'';
        const add=(title:string,icon:string,operation:()=>Promise<unknown>|void)=>menu.addItem(item=>item
          .setTitle(`Knowledge Seed：${title}${suffix}`).setIcon(icon).onClick(this.liveMenuAction(async()=>{
            // A menu can remain open while a background update or another view
            // changes membership. Never act on a stale or differently scoped node.
            const latest=this.liveMaps.find(item=>item.id===map.id);
            if(!latest||!visibleLiveGraph(latest).nodes.some(node=>latest.nodePaths[node.id]===path))throw new Error('该节点不在当前图谱中，请重新打开菜单。');
            await operation();
          })));
        add('以此节点为中心','focus',()=>this.liveControls().focus!(map.id,path));
        add('进入此处（局部漫游）','footprints',()=>this.roamMap(map.id,{type:'enter',node:this.liveNodeId(map.id,path)}));
        add('沿此节点继续探索','network',()=>this.expandLiveMap(map.id,path));
        add('查看关系与来源','list-tree',()=>this.showLiveNodeEvidence(map.id,path));
        if(path!==map.rootPath) {
          add('补充正文（后台）','book-open',async()=>{
            if(await this.retryConceptBody(path))new Notice(this.backgroundPaused?'已加入正文队列；后台阅读已暂停，可在“正文任务”中继续。':'已加入后台正文队列。');
          });
          add('从此图剪除节点（保留笔记）','scissors',()=>this.pruneMap(map.id,path,false));
          add('从此图剪除分支（保留笔记）','git-branch-minus',()=>this.pruneMap(map.id,path,true));
        }
        add('打开所属图谱','folder-search',()=>this.openLiveMap(map.id));
      }
    }));
    this.backgroundReader = new BackgroundReader({
      canRun: () => !this.disposed && !this.busy && !this.backgroundPaused && this.settings.web,
      run: (job, signal) => this.backgroundTask(job, signal),
      onDisplaced: job => {for(const map of this.liveMaps)for(const node of map.graph.nodes)
        if(map.nodePaths[node.id]===job.path)this.liveBodyAttempted.delete(`${map.id}:${job.path}:${node.managedId??node.id}`);}
    });
    if (typeof this.addStatusBarItem === 'function') this.backgroundStatus = this.addStatusBarItem();
    this.backgroundPaused = loaded.backgroundPaused === true;
    this.backgroundReader.restoreHistory(loaded.readingTasks);
    if (this.backgroundPaused) this.backgroundReader.pause();
    this.backgroundReader.subscribe(() => {
      this.updateBackgroundStatus();
      for(const job of this.backgroundReader?.jobs??[])if(job.state==='ready')for(const map of this.liveMaps)for(const node of map.graph.nodes)
        if(map.nodePaths[node.id]===job.path){node.bodyAvailable=true;node.reading={state:'ready'};}
      this.notifyLive();
      if(!this.liveWriting)void this.feedLiveBodies();
      if (this.disposed) return;
      if (this.backgroundSaveTimer) clearTimeout(this.backgroundSaveTimer);
      this.backgroundSaveTimer = setTimeout(() => {
        this.backgroundSaveTimer = undefined;
        void this.saveSettings().catch(error=>new Notice(`后台阅读记录未能保存：${friendlyError(error)}`));
      },50);
    });
    if (this.backgroundStatus) {
      this.backgroundStatus.onclick = () => this.openBackgroundTasks();
      this.backgroundStatus.setAttribute('aria-label','查看后台正文任务');
      this.backgroundStatus.setAttribute('role','button');
      this.backgroundStatus.setAttribute('tabindex','0');
      this.backgroundStatus.onkeydown = event => { if (event.key==='Enter'||event.key===' ') {event.preventDefault();this.openBackgroundTasks();} };
    }
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file instanceof TFile && file.extension === 'md') void this.queueConceptBody(file,false,undefined,undefined,true).catch(error=>new Notice(friendlyError(error)));
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.selectLiveGraphLeaf(leaf??undefined);
      if(leaf?.getViewState().type!=='markdown')return;
      const file=this.app.workspace.getActiveFile();
      if(file instanceof TFile && file.extension==='md')void this.queueConceptBody(file,false,undefined,undefined,true).catch(error=>new Notice(friendlyError(error)));
    }));
    this.selectLiveGraphLeaf(this.app.workspace.activeLeaf??undefined);
    if(typeof this.app.metadataCache?.on==='function')this.registerEvent(this.app.metadataCache.on('resolved',()=>this.scheduleLiveGraphRefresh()));
    this.addCommand({ id: 'read-current-concept', name: '补充当前概念正文（后台）', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void this.retryConceptBody(file.path).catch(error => new Notice(friendlyError(error)));
      return true;
    } });
    this.addCommand({id:'background-reading-tasks',name:'查看后台正文任务',callback:()=>this.openBackgroundTasks()});
  }

  onunload(): void {
    this.disposed = true;
    if (this.backgroundSaveTimer) clearTimeout(this.backgroundSaveTimer);
    this.backgroundSaveTimer = undefined;
    if(this.liveGraphRefreshTimer)clearTimeout(this.liveGraphRefreshTimer);
    this.liveGraphRefreshTimer=undefined;
    this.activeController?.abort(); this.backgroundReader?.dispose();
    for(const controller of this.liveControllers.values())controller.abort();
    this.liveListeners.clear();
    if(typeof this.app.workspace.detachLeavesOfType==='function')this.app.workspace.detachLeavesOfType(LIVE_MAP_VIEW);
  }
  openSeed(seed?: Seed, request?: DiscoveryConfig): void {
    if (this.busy) { new Notice('已有任务正在进行，请先完成或取消。'); return; }
    new SeedModal(this.app, this, seed, request).open();
  }
  beginSeedSetup():number {return ++this.seedSetupGeneration;}
  canRestoreSeedSetup(generation:number):boolean {return !this.disposed&&generation===this.seedSetupGeneration;}
  async openFromFile(file: TFile): Promise<void> {
    try {
      if (this.busy) throw new Error('已有任务正在进行，请先完成或取消。');
      await this.refreshManagedNotes();
      const owned = this.managedNotes.get(file.path);
      const seed: Seed = owned?.kind === 'concept' && !owned.bodyAvailable && owned.source
        ? {kind:'url',value:publicUrl(owned.source)} : {kind:'note',value:file.path};
      this.openSeed(seed);
    } catch(error) {new Notice(friendlyError(error));}
  }
  async saveSettings(refreshGate = true): Promise<void> {
    if(this.disposed)return;
    if (this.backgroundSaveTimer) clearTimeout(this.backgroundSaveTimer);
    this.backgroundSaveTimer = undefined;
    if(refreshGate && !this.liveWriting)this.backgroundReader?.refreshGate();
    const snapshot = JSON.parse(JSON.stringify({...this.settings,lastRun:this.lastRun,history:this.history,
      backgroundPaused:this.backgroundPaused,readingTasks:this.backgroundReader?.exportHistory()??[],
      liveMaps:serializeLiveMaps(this.liveMaps),currentLiveId:this.currentLiveId,
      roaming:this.liveMaps.filter(map=>this.roamingStates.has(map.id)).map(map=>({mapId:map.id,state:projectRoaming(visibleLiveGraph(map),this.roamingStates.get(map.id)).state}))}));
    const task = this.settingsSaveTask.catch(()=>{}).then(()=>{if(!this.disposed)return this.saveData(snapshot);});
    this.settingsSaveTask = task;
    await task;
  }
  private notifyLive(): void {for(const listener of this.liveListeners)try{listener();}catch{/* A closed view cannot block a worker. */}}
  private liveMenuAction(operation:()=>Promise<unknown>):()=>void {
    return()=>{if(!this.disposed)void Promise.resolve().then(operation).catch(error=>new Notice(friendlyError(error)));};
  }
  showLiveNodeEvidence(id:string,path:string):void {
    const map=this.liveMaps.find(map=>map.id===id),graph=map&&visibleLiveGraph(map);
    const node=graph?.nodes.find(node=>map!.nodePaths[node.id]===path);
    if(!node||!graph)throw new Error('该节点不在当前图谱中。');
    new LiveNodeEvidenceModal(this.app,node.title,graph,node.id).open();
  }
  private liveLeafMatchesBinding(id:string,leaf:WorkspaceLeaf):boolean {
    const state=leaf.getViewState(),owned=this.liveLeafStates.get(id);
    return this.app.workspace.getLeavesOfType('localgraph').includes(leaf)&&state.type==='localgraph'&&state.pinned===true
      &&Boolean(owned)&&state.state?.file===owned!.file&&(state.state?.options as Record<string,unknown>|undefined)?.search===owned!.search;
  }
  /** Restore only an exact, unique saved scope. Labels never establish tab ownership. */
  private matchingLiveMaps(leaf:WorkspaceLeaf):LiveMapRecord[] {
    const state=leaf.getViewState(),file=state.state?.file,search=(state.state?.options as Record<string,unknown>|undefined)?.search;
    if(!this.app.workspace.getLeavesOfType('localgraph').includes(leaf)||state.type!=='localgraph'||state.pinned!==true
      ||typeof file!=='string'||typeof search!=='string')return[];
    return this.liveMaps.filter(map=>{
      if(!map.rootPath)return false;
      const {paths,file:center,projection}=this.liveDisplay(map);
      return paths.includes(file)&&search===nativeSearch(paths)&&(!projection.state.enabled||file===center);
    });
  }
  private selectLiveGraphLeaf(leaf?:WorkspaceLeaf):void {
    if(!leaf||this.disposed)return;
    const bindings=[...this.liveLeaves].filter(([,bound])=>bound===leaf);
    let map:LiveMapRecord|undefined;
    if(bindings.length) {
      const valid=bindings.filter(([id])=>this.liveLeafMatchesBinding(id,leaf));
      if(valid.length===1)map=this.liveMaps.find(item=>item.id===valid[0][0]);
      // A changed filter, file or pin is the user's tab, not a restoration candidate.
    }else {
      const matches=this.matchingLiveMaps(leaf);
      if(matches.length===1) {
        map=matches[0];
        const previous=this.liveLeaves.get(map.id);
        if(!previous||!this.liveLeafMatchesBinding(map.id,previous)) {
          const state=leaf.getViewState(),file=state.state?.file as string,search=(state.state?.options as Record<string,unknown>).search as string;
          this.liveLeaves.set(map.id,leaf);this.liveLeafStates.set(map.id,{file,search});
          if(file!==map.rootPath)this.liveCenters.set(map.id,file);
        }
      }
    }
    if(map&&this.currentLiveId!==map.id){this.currentLiveId=map.id;this.notifyLive();}
  }
  private liveDisplay(map:LiveMapRecord) {
    const graph=visibleLiveGraph(map),projection=projectRoaming(graph,this.roamingStates.get(map.id));
    const nodes=projection.state.enabled?projection.nodes:graph.nodes;
    const paths=nodes.map(node=>map.nodePaths[node.id]).filter(Boolean);
    const center=projection.state.enabled?map.nodePaths[projection.state.center]:this.liveCenters.get(map.id);
    return {paths,file:center&&paths.includes(center)?center:map.rootPath,projection};
  }
  private liveNodeId(id:string,path:string):string {
    const map=this.liveMaps.find(map=>map.id===id);
    const node=map&&visibleLiveGraph(map).nodes.find(node=>map.nodePaths[node.id]===path);
    if(!node)throw new Error('该节点不在当前图谱中。');
    return node.id;
  }
  async roamMap(id:string,action:RoamingAction):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);
    if(!map)throw new Error('图谱记录不存在。');
    const state=moveRoaming(visibleLiveGraph(map),this.roamingStates.get(id),action);
    if(state.enabled&&!(this.app.vault.getAbstractFileByPath(map.nodePaths[state.center]) instanceof TFile))throw new Error('节点笔记已移动或删除，请重新打开图谱以恢复路径。');
    if(state.enabled&&!this.roamingStates.get(id)?.enabled){
      const leaf=this.liveLeaves.get(id),options=leaf?.getViewState().state?.options as Record<string,unknown>|undefined;
      if(leaf&&this.liveLeafMatchesBinding(id,leaf)&&typeof options?.localJumps==='number')state.overviewJumps=displayDepth(options.localJumps);
    }
    this.roamingStates.set(id,state);this.currentLiveId=id;
    if(action.type==='enabled'&&!action.value)this.restoreOverviewDepth.add(id);
    if(state.enabled)this.liveCenters.set(id,map.nodePaths[state.center]);
    await this.syncLiveGraph(map,true);
    this.notifyLive();await this.saveSettings(false);
    if(action.type==='enter')await this.showLiveControls();
  }
  private liveInfo(map:LiveMapRecord): LiveMapInfo {
    const graph=visibleLiveGraph(map);
    return {id:map.id,title:map.title,rootPath:map.rootPath,state:map.state,nodes:graph.nodes.length,edges:graph.edges.length,
      bodyReady:graph.nodes.filter(node=>node.kind!=='seed'&&(node.article || node.bodyAvailable || this.managedNotes.get(map.nodePaths[node.id])?.bodyAvailable)).length,
      limit:map.options.maxConcepts+1,message:map.message};
  }
  liveControls(): LiveMapControls {
    return {
      list:()=>[...this.liveMaps.map(map=>this.liveInfo(map)),...this.history.filter(item=>!this.liveMaps.some(map=>map.rootPath===item.run.rootPath))
        .map(item=>({id:`history:${item.run.folder}`,title:item.title,rootPath:item.run.rootPath,state:'complete' as const,
          nodes:item.nodes,edges:item.relations,bodyReady:-1,limit:item.request?.options.maxConcepts??item.nodes,message:'已保存的历史图谱'}))],
      current:()=>{const map=this.liveMaps.find(map=>map.id===this.currentLiveId);return map&&this.liveInfo(map);},
      subscribe:listener=>{this.liveListeners.add(listener);return()=>this.liveListeners.delete(listener);},
      open:id=>this.openLiveMap(id),pause:id=>this.pauseLiveMap(id),resume:id=>this.resumeLiveMap(id),stop:id=>this.stopLiveMap(id),
      reading:()=>this.openBackgroundTasks(),
      roaming:id=>{
        const map=this.liveMaps.find(map=>map.id===id);if(!map)return;
        const p=this.liveDisplay(map).projection;
        return {...p.state,total:p.total,shown:p.nodes.length,nearby:p.nearby,
          centerTitle:map.graph.nodes.find(node=>node.id===p.state.center)?.title??map.title,centerPath:map.nodePaths[p.state.center],
          route:[...p.state.back.slice(-6),p.state.center].map(id=>({id,title:map.graph.nodes.find(node=>node.id===id)?.title??id})),
          frontier:p.frontier.slice(0,8).map(item=>({id:item.node.id,title:item.node.title,hidden:item.hidden,
            next:item.next.map(node=>({id:node.id,title:node.title}))}))};
      },
      roam:(id,action)=>this.roamMap(id,action),
      enter:async(id,path)=>this.roamMap(id,{type:'enter',node:this.liveNodeId(id,path)}),
      openNote:async(id,path)=>{
        const map=this.liveMaps.find(item=>item.id===id);
        if(!map||!visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===path))throw new Error('该节点不在当前图谱中。');
        const file=this.app.vault.getAbstractFileByPath(path);if(!(file instanceof TFile))throw new Error('节点笔记已移动或删除。');
        await this.openNoteFile(file);
      },
      configure:async id=>{const map=this.liveMaps.find(map=>map.id===id);if(!map)throw new Error('图谱记录不存在。');new LiveStrategyModal(this.app,this,map).open();},
      prune:(id,path,branch)=>this.pruneMap(id,path,branch),expand:(id,path,direction)=>this.expandLiveMap(id,path,direction),
      focus:async(id,path)=>{const map=this.liveMaps.find(map=>map.id===id);if(!map||!visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===path))throw new Error('该节点不在当前图谱中。');
        if(this.roamingStates.get(id)?.enabled){await this.roamMap(id,{type:'enter',node:this.liveNodeId(id,path)});return;}
        this.liveCenters.set(id,path);await this.syncLiveGraph(map,true);},
      paths:id=>{const map=this.liveMaps.find(map=>map.id===id);return map?visibleLiveGraph(map).nodes
        .filter(node=>Boolean(map.nodePaths[node.id])).map(node=>({path:map.nodePaths[node.id],title:node.kind==='seed'?`${node.title}（图谱入口）`:node.title})):[];}
    };
  }
  openGraphLibrary(): void {void this.refreshManagedNotes().then(()=>new GraphLibraryModal(this.app,this.liveControls()).open()).catch(error=>new Notice(friendlyError(error)));}
  async showLiveControls(): Promise<void> {
    const workspace=this.app.workspace;
    const leaf=workspace.getLeavesOfType(LIVE_MAP_VIEW)[0]??workspace.getRightLeaf(false);
    if(leaf)await leaf.setViewState({type:LIVE_MAP_VIEW,active:false});
    if(leaf && typeof leaf.loadIfDeferred==='function')await leaf.loadIfDeferred();
    if(leaf && typeof workspace.revealLeaf==='function')await workspace.revealLeaf(leaf);
  }
  async openLiveMap(id:string): Promise<void> {
    if(id.startsWith('history:')) {
      const item=this.history.find(item=>item.run.folder===id.slice(8));
      if(!item)throw new Error('图谱记录不存在。');
      try {
        const stored=JSON.parse(await this.app.vault.adapter.read(`${item.run.folder}/graph.json`));
        const identities=new Set(stored.nodes.flatMap((node:import('./graph').GraphNode)=>[node.id,node.managedId,...(node.mergedIds??[])]));
        const paths=Object.fromEntries(Object.entries(item.run.nodePaths??{}).filter(([key])=>identities.has(key)));
        const imported=readLiveMaps([{id:`saved-${stableId(item.run.folder)}`,title:item.title,rootPath:item.run.rootPath,
          createdAt:item.createdAt,updatedAt:new Date().toISOString(),state:'complete',graph:stored,nodePaths:paths,excludedIds:[],
          options:clampOptions({...this.settings,...item.request?.options,explorationStrategy:item.request?.options.explorationStrategy??'radial',generatedFolder:item.run.folder.split('/Runs/')[0]}),seed:item.request?.seed??{kind:'topic',value:item.title},folder:item.run.folder}])[0];
        if(imported){this.liveMaps=[imported,...this.liveMaps].slice(0,20);await this.openLiveMap(imported.id);return;}
      }catch{/* A legacy snapshot can still be opened using its original core local graph. */}
      await this.openNativeGraph(item.run);return;
    }
    const map=this.liveMaps.find(map=>map.id===id);
    if(!map||!map.rootPath)throw new Error('图谱尚未建立，或记录不存在。');
    await this.recoverLivePaths(map);
    if(!(this.app.vault.getAbstractFileByPath(map.rootPath) instanceof TFile))throw new Error('起点笔记已移动或删除。');
    this.currentLiveId=id;
    await this.syncLiveGraph(map,true);await this.showLiveControls();this.notifyLive();await this.saveSettings(false);
  }
  private async syncLiveGraph(map:LiveMapRecord,activate=false): Promise<void> {
    const previous=this.liveGraphSyncTasks.get(map.id)??Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>this.updateLiveGraph(map,activate));
    this.liveGraphSyncTasks.set(map.id,task);
    try{await task;}finally{if(this.liveGraphSyncTasks.get(map.id)===task)this.liveGraphSyncTasks.delete(map.id);}
  }
  private scheduleLiveGraphRefresh():void {
    if(this.disposed||!this.liveLeaves.size)return;
    if(this.liveGraphRefreshTimer)clearTimeout(this.liveGraphRefreshTimer);
    this.liveGraphRefreshTimer=setTimeout(()=>{
      this.liveGraphRefreshTimer=undefined;
      for(const map of this.liveMaps)if(this.liveLeaves.has(map.id))void this.syncLiveGraph(map).catch(()=>{});
    },80);
  }
  private async updateLiveGraph(map:LiveMapRecord,activate=false): Promise<void> {
    if(this.disposed)return;
    const workspace=this.app.workspace;
    let leaf=this.liveLeaves.get(map.id);
    if(leaf) {
      if(!this.liveLeafMatchesBinding(map.id,leaf)) {
        this.liveLeaves.delete(map.id);this.liveLeafStates.delete(map.id);leaf=undefined;
      }
    }
    if(!leaf && !activate)return; // Closing a tab never causes a worker to reopen it.
    const {paths,file,projection}=this.liveDisplay(map),search=nativeSearch(paths);
    if(!leaf) {
      const matches=workspace.getLeavesOfType('localgraph').filter(item=>{const state=item.getViewState();
        if(state.pinned!==true||state.state?.file!==file||(state.state?.options as Record<string,unknown>|undefined)?.search!==search)return false;
        if([...this.liveLeaves].some(([id,bound])=>id!==map.id&&bound===item))return false;
        const owners=this.matchingLiveMaps(item);
        return owners.length===1&&owners[0].id===map.id;
      });
      leaf=matches.length===1?matches[0]:workspace.getLeaf('tab');
      this.liveLeaves.set(map.id,leaf);
    }
    const old=leaf.getViewState();
    const oldOptions=(old.state?.options??{}) as Record<string,unknown>;
    const viewOptions:Record<string,unknown>={localJumps:5,localBacklinks:true,localForelinks:true,localInterlinks:true,
      showTags:false,showAttachments:false,hideUnresolved:true,...oldOptions,search};
    if(projection.state.enabled)viewOptions.localJumps=projection.state.radius;
    else if(this.restoreOverviewDepth.has(map.id))viewOptions.localJumps=projection.state.overviewJumps;
    leaf.setPinned(true);
    await leaf.setViewState({...old,type:'localgraph',active:activate,pinned:true,state:{...old.state,file,
      options:viewOptions}});
    if(this.disposed)return;
    if(typeof leaf.loadIfDeferred==='function')await leaf.loadIfDeferred();
    if(activate&&typeof workspace.revealLeaf==='function')await workspace.revealLeaf(leaf);
    const actual=leaf.getViewState(),actualFile=actual.state?.file,actualSearch=(actual.state?.options as Record<string,unknown>|undefined)?.search;
    if(actual.type==='localgraph'&&actual.pinned===true&&typeof actualFile==='string'&&typeof actualSearch==='string')
      this.liveLeafStates.set(map.id,{file:actualFile,search:actualSearch});
    else this.liveLeafStates.delete(map.id);
    this.restoreOverviewDepth.delete(map.id);
  }
  private liveOptions(overrides:Partial<Settings>):Options {
    const options=clampOptions({...this.settings,...overrides,generatedFolder:safeFolder(this.settings.outputFolder)});
    return options.readingMode==='adaptive' ? {...options,...liveReadingLimits[options.readingPace??'balanced']} : options;
  }
  async startLive(seed:Seed,overrides:Partial<Settings>={}):Promise<string> {
    if(this.disposed||this.busy)throw new Error('请等待当前保存结束。');
    if(this.liveMaps.some(map=>map.state==='running'))throw new Error('已有图谱正在增长，请先暂停或停止它。');
    const options=this.liveOptions(overrides);
    const errors=validateDiscovery(seed,options);if(errors.length)throw new Error(errors.join(' '));
    const id=`live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
    const createdAt=new Date().toISOString();
    const graph:KnowledgeGraph={version:1,seed:seed.value.trim(),createdAt,nodes:[],edges:[],warnings:[],stats:{pagesAttempted:0,notesScanned:0,requests:0}};
    const map:LiveMapRecord={id,title:seed.value.trim(),rootPath:'',createdAt,updatedAt:createdAt,state:'running',
      graph,nodePaths:{},excludedIds:[],options,seed:{...seed,value:seed.value.trim()},folder:'',message:'正在建立起点…'};
    this.liveMaps=[map,...this.liveMaps].slice(0,20);this.currentLiveId=id;
    this.liveEnabled.add(id);
    const initialized=this.runLiveExploration(map,map.seed);
    await initialized;return id;
  }
  private runLiveExploration(map:LiveMapRecord,seed:Seed,attachToId?:string):Promise<void> {
    const controller=new AbortController();this.liveControllers.set(map.id,controller);
    const baseStats={...map.graph.stats};
    const remaining=map.options.maxConcepts-visibleLiveGraph(map).nodes.filter(node=>node.kind!=='seed').length;
    const passOptions=attachToId?{...map.options,maxConcepts:Math.min(map.options.maxConcepts,Math.max(1,remaining+1))}:map.options;
    let readyResolve!:()=>void,readyReject!:(error:unknown)=>void;
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    let initialized=false;
    const gate=async()=>{while(map.state==='paused'||this.busy){checkAbort(controller.signal);if(this.disposed)throw new Cancelled();
      await new Promise<void>(resolve=>setTimeout(resolve,50));}checkAbort(controller.signal);};
    const task=(async()=>{
      try {
        await this.refreshManagedNotes(map.options.generatedFolder??map.folder.split('/Runs/')[0]??this.settings.outputFolder);
        const ref=map.rootPath?this.managedNotes.get(map.rootPath):undefined;
        if(ref?.kind==='seed') {
          map.graph=foldOwnedRootFileViews(map.graph,map.rootPath,ref.managedId);
          this.trimLiveNodePaths(map);
        }
        await exploreConcepts(seed,this.adapter(controller.signal),passOptions,controller.signal,{
          shouldContinue:gate,
          shouldExclude:node=>[node.id,node.managedId,...(node.mergedIds??[])].some(id=>id&&map.excludedIds.includes(id)),
          progress:message=>{map.message=message;this.notifyLive();},
          onSnapshot:async next=>{
            await gate();
            const merged=map.graph.nodes.length?mergeLiveGraph(map.graph,next,attachToId):next;
            if(attachToId)merged.stats={pagesAttempted:baseStats.pagesAttempted+next.stats.pagesAttempted,
              notesScanned:baseStats.notesScanned+next.stats.notesScanned,requests:baseStats.requests+next.stats.requests};
            const previous=new Set(visibleLiveGraph(map).nodes.map(node=>node.id));
            const excluded=new Set(map.excludedIds);
            const candidates=merged.nodes.filter(node=>node.kind!=='seed'&&!excluded.has(node.id));
            const selected=new Set(candidates.sort((a,b)=>Number(previous.has(b.id))-Number(previous.has(a.id))||a.depth-b.depth)
              .slice(0,map.options.maxConcepts).map(node=>node.id));
            for(const node of merged.nodes)if(excluded.has(node.id))selected.add(node.id);
            map.graph=filterGraph(merged,selected);
            map.title=map.graph.nodes.find(node=>node.kind==='seed')?.title??map.title;
            await this.saveLiveSnapshot(map,controller.signal);
            if(!initialized){await this.openLiveMap(map.id);initialized=true;readyResolve();}
          }
        });
        checkAbort(controller.signal);map.state='complete';map.message=explorationSummary(visibleLiveGraph(map));
      }catch(error) {
        map.state=controller.signal.aborted?'cancelled':'failed';
        map.message=controller.signal.aborted?'已停止增长，已建立的图谱与正文保留。':`探索停止：${friendlyError(error)}；已保存内容保留。`;
        if(!initialized)readyReject(error);else if(!controller.signal.aborted)new Notice(map.message);
      }finally {
        this.liveControllers.delete(map.id);this.liveTasks.delete(map.id);map.updatedAt=new Date().toISOString();
        if(!this.disposed){this.notifyLive();await this.saveSettings(false).catch(()=>{});void this.feedLiveBodies();}
      }
    })();
    this.liveTasks.set(map.id,task);
    return ready;
  }
  private async saveLiveSnapshot(map:LiveMapRecord,signal:AbortSignal):Promise<void> {
    while(this.busy){checkAbort(signal);await new Promise<void>(resolve=>setTimeout(resolve,25));}
    checkAbort(signal);this.liveWriting=true;
    try {
      const graph:KnowledgeGraph={...visibleLiveGraph(map),displayDepth:5,request:{seed:map.seed,options:cloneRunOptions({...map.options,graphDepth:5})}};
      await this.persist(graph,{signal,baseFolder:map.options.generatedFolder??map.folder.split('/Runs/')[0]??this.settings.outputFolder,saved:async(run,saved)=>{
        const root=saved.nodes.find(node=>node.kind==='seed')!;
        const base=foldOwnedRootFileViews(map.graph,run.rootPath,root.managedId??root.id);
        map.graph=mergeLiveGraph(base,saved);map.nodePaths={...map.nodePaths,...run.nodePaths};map.rootPath=run.rootPath;
        this.trimLiveNodePaths(map);
        map.folder=run.folder;map.updatedAt=new Date().toISOString();
        if(this.currentLiveId===map.id)this.lastRun=run;
        this.notifyLive();await this.saveSettings(false);await this.syncLiveGraph(map);
      }});
    }finally {this.liveWriting=false;void this.feedLiveBodies();}
  }
  private trimLiveNodePaths(map:LiveMapRecord):void {
    const retained=new Set(map.graph.nodes.flatMap(node=>[node.id,node.managedId,...(node.mergedIds??[])].filter((id):id is string=>Boolean(id))));
    map.nodePaths=Object.fromEntries(Object.entries(map.nodePaths).filter(([id])=>retained.has(id)));
  }
  /** Apply only confirmed file moves; keep the map object held by a live worker. */
  private remapLivePaths(moved:ReadonlyMap<string,string>):void {
    if(!moved.size)return;
    for(const map of this.liveMaps) {
      map.rootPath=moved.get(map.rootPath)??map.rootPath;
      map.nodePaths=Object.fromEntries(Object.entries(map.nodePaths).map(([id,path])=>[id,moved.get(path)??path]));
      if(map.seed.kind==='note')map.seed={...map.seed,value:moved.get(map.seed.value)??map.seed.value};
      for(const node of map.graph.nodes)if(node.locator && (node.kind==='note'||node.kind==='concept') && node.locator.endsWith('.md'))
        node.locator=moved.get(node.locator)??node.locator;
      for(const edge of map.graph.edges)for(const evidence of edge.evidence)if(evidence.locator)
        evidence.locator=moved.get(evidence.locator)??evidence.locator;
      const center=this.liveCenters.get(map.id);if(center)this.liveCenters.set(map.id,moved.get(center)??center);
      const owned=this.liveLeafStates.get(map.id);if(owned)this.liveLeafStates.set(map.id,{...owned,file:moved.get(owned.file)??owned.file});
    }
  }
  private async recoverLivePaths(map:LiveMapRecord):Promise<void> {
    await this.refreshManagedNotes(map.options.generatedFolder??map.folder.split('/Runs/')[0]??this.settings.outputFolder);
    const owners=new Map<string,string>();
    for(const[path,ref]of this.managedNotes)for(const id of[ref.managedId,...ref.mergedIds]) {
      const prior=owners.get(id);
      if(prior&&prior!==path)throw new Error('多个生成笔记声称同一身份，请先检查重复节点。');
      owners.set(id,path);
    }
    const moved=new Map<string,string>();
    for(const node of map.graph.nodes) {
      const paths=new Set([node.id,node.managedId,...(node.mergedIds??[])].filter((id):id is string=>Boolean(id))
        .map(id=>owners.get(id)).filter((path):path is string=>Boolean(path)));
      if(paths.size>1)throw new Error('图谱节点关联了多个生成笔记，请先审阅合并。');
      const target=[...paths][0],oldPath=map.nodePaths[node.id];
      if(!target||!oldPath||target===oldPath)continue;
      if(moved.has(oldPath)&&moved.get(oldPath)!==target)throw new Error('图谱路径与生成笔记身份冲突，停止恢复。');
      moved.set(oldPath,target);
    }
    this.remapLivePaths(moved);
  }
  private async feedLiveBodies():Promise<void> {
    if(this.liveBodyFeeding||this.disposed||this.liveWriting||this.backgroundPaused||!this.backgroundReader||!this.settings.web||!this.settings.backgroundReading)return;
    this.liveBodyFeeding=true;
    try {
      for(const map of this.liveMaps.filter(map=>map.options.web&&this.liveEnabled.has(map.id)&&(map.state==='running'||map.state==='complete')))for(const node of visibleLiveGraph(map).nodes) {
        const path=map.nodePaths[node.id],ref=path&&this.managedNotes.get(path);
        const key=`${map.id}:${path}:${node.managedId??node.id}`;
        if(!path||!ref||ref.bodyAvailable||ref.kind!=='concept'||ref.readingState==='excluded'||this.liveBodyAttempted.has(key))continue;
        const file=this.app.vault.getAbstractFileByPath(path);if(!(file instanceof TFile))continue;
        try {
          const expectedIds=[node.id,node.managedId,...(node.mergedIds??[])].filter((id):id is string=>Boolean(id));
          const currentIds=new Set([ref.managedId,...ref.mergedIds]);
          if(!expectedIds.some(id=>currentIds.has(id)))throw new Error('任务对应的节点归属已变化，请重新打开当前概念。');
          const id=await this.queueConceptBody(file,false,ref.managedId,map.id);
          if(id)this.liveBodyAttempted.add(key);
        }catch(error) {
          // One reassigned or unreadable note cannot block healthy concepts.
          // Retain the ownership refusal and report it once per cached identity.
          if(!this.disposed&&!this.liveBodyFailures.has(key)) {
            this.liveBodyFailures.add(key);
            new Notice(`正文补充未排队：${node.title}；${friendlyError(error)}`);
          }
        }
      }
    }finally {this.liveBodyFeeding=false;}
  }
  private liveNeedsBody(path:string,ownerIds?:ReadonlySet<string>):boolean {
    return this.liveMaps.some(map=>this.liveEnabled.has(map.id)&&!['cancelled','failed','interrupted'].includes(map.state)
      &&visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===path&&(!ownerIds
        ||[node.id,node.managedId,...(node.mergedIds??[])].some(id=>Boolean(id)&&ownerIds.has(id!)))));
  }
  async pauseLiveMap(id:string):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)return;
    this.liveControlVersions.set(id,(this.liveControlVersions.get(id)??0)+1);
    this.liveControlIntents.set(id,'paused');
    if(map.state!=='running')return;
    map.state='paused';map.message='概念增长已暂停；正文任务可在后台正文面板单独控制。';this.notifyLive();await this.saveSettings(false);
  }
  async resumeLiveMap(id:string):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)throw new Error('图谱记录不存在。');
    const version=(this.liveControlVersions.get(id)??0)+1;this.liveControlVersions.set(id,version);
    this.liveControlIntents.set(id,'running');
    this.liveEnabled.add(id);
    if(this.liveMaps.some(other=>other!==map&&other.state==='running'))throw new Error('请先暂停其他正在增长的图谱。');
    const controller=this.liveControllers.get(id);
    if(controller&&!controller.signal.aborted){map.state='running';this.notifyLive();await this.saveSettings(false);return;}
    if(controller)await this.liveTasks.get(id);
    if(version!==this.liveControlVersions.get(id))return;
    await this.expandLiveMap(id,map.rootPath);
  }
  async applyLiveStrategy(id:string,proposal:Options):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)throw new Error('图谱记录不存在。');
    const errors=validateDiscovery(map.seed,{...proposal,graphDepth:5});if(errors.length)throw new Error(errors.join(' '));
    const version=this.liveControlVersions.get(id)??0;
    const running=map.state==='running',paused=map.state==='paused';
    const controller=this.liveControllers.get(id);if(controller){controller.abort();await this.liveTasks.get(id);}
    map.options=clampOptions({...map.options,explorationStrategy:proposal.explorationStrategy,breadthDecay:proposal.breadthDecay,
      directionDepthBoost:proposal.directionDepthBoost,offDirectionDepth:proposal.offDirectionDepth,directionRules:proposal.directionRules});
    const unchanged=version===(this.liveControlVersions.get(id)??0);
    const full=visibleLiveGraph(map).nodes.filter(node=>node.kind!=='seed').length>=map.options.maxConcepts;
    if(unchanged&&(running||paused))map.state=full?'complete':paused?'paused':'interrupted';
    else if(!unchanged&&this.liveControlIntents.get(id)==='paused')map.state='paused';
    map.message=full?'探索策略已保存；当前图谱已达到节点上限，剪除不需要的节点后可继续探索。':'探索策略已保存；已有节点、正文和剪枝结果保留。';
    this.notifyLive();await this.saveSettings(false);
    if(running&&!full&&version===(this.liveControlVersions.get(id)??0)&&map.state==='interrupted')await this.resumeLiveMap(id);
  }
  async stopLiveMap(id:string):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)return;
    this.liveControlVersions.set(id,(this.liveControlVersions.get(id)??0)+1);
    this.liveControlIntents.set(id,'cancelled');
    map.state='cancelled';this.liveControllers.get(id)?.abort();map.message='已停止增长，保留当前图谱。';
    this.liveEnabled.delete(id);
    for(const job of this.backgroundReader?.jobs??[])if(job.data?.mapId===id&&!this.liveNeedsBody(job.path))this.backgroundReader?.cancel(job.id);
    this.notifyLive();await this.saveSettings(false);
  }
  async pruneMap(id:string,path:string,branch:boolean):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)throw new Error('图谱记录不存在。');
    Object.assign(map,pruneLiveMap(map,path,branch));
    const visiblePaths=new Set(visibleLiveGraph(map).nodes.map(node=>map.nodePaths[node.id]));
    for(const job of this.backgroundReader?.jobs??[])if(job.data?.mapId===id&&!visiblePaths.has(job.path)&&!this.liveNeedsBody(job.path))this.backgroundReader?.cancel(job.id);
    await this.syncLiveGraph(map);this.notifyLive();await this.saveSettings(false);
  }
  async expandLiveMap(id:string,path:string,direction?:string):Promise<void> {
    const map=this.liveMaps.find(map=>map.id===id);if(!map)throw new Error('图谱记录不存在。');
    const version=(this.liveControlVersions.get(id)??0)+1;this.liveControlVersions.set(id,version);this.liveControlIntents.set(id,'running');
    if(this.liveControllers.has(id)){this.liveControllers.get(id)?.abort();await this.liveTasks.get(id);}
    if(this.liveMaps.some(other=>other.state==='running'))throw new Error('请先暂停其他正在增长的图谱。');
    const priorNode=map.graph.nodes.find(node=>map.nodePaths[node.id]===path);
    await this.recoverLivePaths(map);
    if(priorNode)path=map.nodePaths[priorNode.id]??path;
    const rootFile=this.app.vault.getAbstractFileByPath(map.rootPath);
    if(rootFile instanceof TFile) {
      const ref=readManagedNote(await this.app.vault.read(rootFile),rootFile.basename);
      if(ref?.kind==='seed') {
        map.graph=foldOwnedRootFileViews(map.graph,map.rootPath,ref.managedId);
        this.trimLiveNodePaths(map);
      }
    }
    const node=visibleLiveGraph(map).nodes.find(node=>map.nodePaths[node.id]===path);if(!node)throw new Error('请选择当前图谱中的节点。');
    if(visibleLiveGraph(map).nodes.filter(item=>item.kind!=='seed').length>=map.options.maxConcepts)throw new Error('当前图谱已达到节点上限；先剪除不需要的节点或分支，再继续探索。');
    const ref=this.managedNotes.get(path);
    const url=node.entityUrl??(node.kind==='web'?node.locator:undefined)??ref?.source;
    const seed:Seed=node.kind==='seed'?{...map.seed}:url?{kind:'url',value:publicUrl(url)}:node.kind==='note'?{kind:'note',value:path}:{kind:'topic',value:node.title};
    if(version!==this.liveControlVersions.get(id))return;
    if(this.liveMaps.some(other=>other!==map&&other.state==='running'))throw new Error('请先暂停其他正在增长的图谱。');
    if(direction?.trim())map.options={...map.options,searchTerms:[direction.trim().slice(0,180),...map.options.searchTerms].slice(0,20)};
    map.state='running';map.message=`沿“${node.title}”继续探索…`;this.currentLiveId=id;this.notifyLive();
    this.liveEnabled.add(id);
    await this.runLiveExploration(map,seed,node.id);
  }
  openBackgroundTasks(): void { new BackgroundReadingModal(this.app,this).open(); }
  async openNoteFile(file:TFile):Promise<void> {
    const workspace=this.app.workspace;
    const existing=workspace.getLeavesOfType('markdown').find(leaf=>leaf.getViewState().state?.file===file.path);
    const leaf=existing??workspace.getLeaf('tab');
    if(!existing)await leaf.openFile(file);
    if(typeof leaf.loadIfDeferred==='function')await leaf.loadIfDeferred();
    if(!this.disposed&&typeof workspace.revealLeaf==='function')await workspace.revealLeaf(leaf);
    try{await this.queueConceptBody(file,false,undefined,undefined,true);}catch(error){if(!this.disposed)new Notice(friendlyError(error));}
  }
  private generatedBaseForFile(path:string,mapId?:string):string {
    const candidates=[...this.liveMaps.filter(map=>map.id===mapId),...this.liveMaps.filter(map=>map.id!==mapId)];
    for(const map of candidates)if(Object.values(map.nodePaths).includes(path)){
      const base=safeFolder(map.options.generatedFolder??map.folder.split('/Runs/')[0]);
      if(path.startsWith(base+'/'))return base;
    }
    return safeFolder(this.settings.outputFolder);
  }
  async setBackgroundPaused(paused: boolean): Promise<void> {
    this.backgroundPaused = paused;
    if (paused) this.backgroundReader?.pause();
    else {this.backgroundReader?.resume();void this.feedLiveBodies();}
    this.updateBackgroundStatus();
    await this.saveSettings();
  }
  toggleBackgroundPause(): Promise<void> { return this.setBackgroundPaused(!this.backgroundPaused); }
  async cancelBackgroundTasks():Promise<void> {
    this.backgroundCancelGeneration++;
    this.backgroundPaused=true;
    this.backgroundReader?.pause();
    this.backgroundReader?.cancelAll();
    this.updateBackgroundStatus();
    await this.saveSettings();
  }
  async retryBackgroundJob(id: string): Promise<string | undefined> {
    const generation=this.backgroundCancelGeneration;
    const job = this.backgroundReader?.jobs.find(item=>item.id===id);
    if (!job) throw new Error('后台任务记录不存在，请重新打开概念。');
    const file = this.app.vault.getAbstractFileByPath(job.path);
    if (!(file instanceof TFile)) throw new Error('概念笔记已移动或删除，请重新打开节点。');
    const ref = readManagedNote(await this.app.vault.read(file),file.basename);
    if(this.disposed||generation!==this.backgroundCancelGeneration)return;
    if (!ref || ref.managedId!==job.ownerId) throw new Error('任务对应的节点归属已变化，请重新打开当前概念。');
    return this.retryConceptBody(job.path,job.ownerId);
  }
  async queueConceptBody(file: TFile, manual = false, expectedOwnerId?: string, mapId?:string, userInitiated=false): Promise<string | undefined> {
    if (this.disposed || !this.backgroundReader || !this.settings.web || (!manual && !this.settings.backgroundReading)) return;
    const generation=this.backgroundCancelGeneration;
    const origins=this.liveMaps.filter(map=>(!mapId||map.id===mapId)&&visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===file.path));
    const origin=origins.find(map=>map.id===this.currentLiveId)??origins[0];
    if(!manual&&origin?.options.web===false)return;
    const base = this.generatedBaseForFile(file.path,mapId);
    if (!file.path.startsWith(base + '/') || file.path.startsWith(base + '/Runs/')
      || this.settings.excludeFolders.some(folder => file.path === folder || file.path.startsWith(folder + '/'))) return;
    const ref = readManagedNote(await this.app.vault.read(file),file.basename);
    if(this.disposed||generation!==this.backgroundCancelGeneration||!this.settings.web||(!manual&&!this.settings.backgroundReading))return;
    if(expectedOwnerId && ref?.managedId!==expectedOwnerId)throw new Error('任务对应的节点归属已变化，请重新打开当前概念。');
    // A feeder may be cancelled while awaiting the file; a user's opened note
    // can still enter their paused queue without reviving automatic feeding.
    if(!manual&&!userInitiated&&mapId&&(this.backgroundPaused||!this.liveEnabled.has(mapId)))return;
    if (!ref || ref.kind !== 'concept' || ref.bodyAvailable || ref.readingState === 'excluded') return;
    const ids = new Set([ref.managedId, ...ref.mergedIds]);
    if(!manual&&!userInitiated&&mapId) {
      const map=this.liveMaps.find(item=>item.id===mapId);
      if(!map||!visibleLiveGraph(map).nodes.some(node=>map.nodePaths[node.id]===file.path
        &&[node.id,node.managedId,...(node.mergedIds??[])].some(id=>Boolean(id)&&ids.has(id!))))
        throw new Error('任务对应的节点归属已变化，请重新打开当前概念。');
    }
    if ([...this.managedNotes].some(([path, other]) => path !== file.path && [other.managedId,...other.mergedIds].some(id=>ids.has(id))))
      throw new Error('多个生成笔记声称同一身份，请先审阅合并重复节点。');
    const priority=manual||userInitiated;
    const job = this.backgroundReader.enqueue({ path: file.path, ownerId: ref.managedId, title: ref.title, data: { manual,...(mapId?{mapId}:{}) } }, { immediate: priority,priority:priority?'user':'automatic' });
    if(!job&&priority)throw new Error('后台正文队列已满，请取消部分等待任务或稍后重试。');
    if(manual&&job&&!['queued','reading'].includes(job.state)&&!this.backgroundReader.retry(job.id, {path:file.path,ownerId:ref.managedId,title:ref.title,data:{manual:true}}))
      throw new Error('后台正文队列已满，请取消部分等待任务或稍后重试。');
    return job?.id;
  }
  async retryConceptBody(path: string, expectedOwnerId?: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('概念笔记已移动或删除，请重新打开节点。');
    if (!this.settings.web) throw new Error('公开网页读取已关闭，请先在插件设置中开启。');
    const id = await this.queueConceptBody(file, true, expectedOwnerId);
    if (!id) new Notice('当前笔记已有正文，或不属于可安全补充的生成空概念。');
    return id;
  }
  private updateBackgroundStatus(): void {
    const jobs = this.backgroundReader?.jobs ?? [];
    const active = jobs.find(job => job.state === 'reading');
    const waiting = jobs.filter(job => job.state === 'queued').length;
    const last = [...jobs].sort((a,b)=>b.updated-a.updated)[0];
    const text = active ? `补正文：${active.title}${waiting ? ` · 等待 ${waiting}` : ''}`
      : this.backgroundPaused ? `正文已暂停${waiting ? ` · 等待 ${waiting}` : ''}`
      : waiting ? `正文等待：${waiting}` : last?.state === 'ready' ? `正文已补充：${last.title}`
      : last && ['failed','no_match','interrupted'].includes(last.state) ? `正文待重试：${last.title}` : '后台正文';
    this.backgroundStatus?.setText(text);
    this.backgroundStatus?.setAttribute('title', last?.reason ?? '打开生成的空概念时按需补正文，不切换阅读窗口。');
  }
  private async backgroundTask(job: BackgroundJob<{ manual: boolean; mapId?:string }>, signal: AbortSignal) {
    const bodyBase=this.generatedBaseForFile(job.path,job.data?.mapId);
    const guard = () => {
      checkAbort(signal);
      if (this.disposed || !this.settings.web || (!job.data?.manual && !this.settings.backgroundReading)) throw new Cancelled();
      if(job.data?.mapId) {
        if(!this.liveNeedsBody(job.path))throw new Cancelled();
      }
    };
    guard();
    await this.refreshManagedNotes(bodyBase); guard();
    const ref = this.managedNotes.get(job.path);
    const file = this.app.vault.getAbstractFileByPath(job.path);
    if (!(file instanceof TFile) || !ref || ref.managedId !== job.ownerId || ref.kind !== 'concept'
      || ref.bodyAvailable || ref.readingState === 'excluded') return { state: 'skipped' as const, reason: '节点已变化或已有正文，无需自动补充。' };
    const ownIds = new Set([ref.managedId,...ref.mergedIds]);
    if ([...this.managedNotes].some(([path,other])=>path!==job.path && [other.managedId,...other.mergedIds].some(id=>ownIds.has(id))))
      throw new Error('多个生成笔记声称同一身份，请先审阅合并重复节点。');
    const aliases = [...ref.mergedIds], ownerId = ref.managedId;
    let before = await this.app.vault.read(file); guard();
    if(!job.data?.manual&&job.data?.mapId) {
      const fresh=readManagedNote(before,file.basename);
      if(!fresh||fresh.managedId!==ownerId||fresh.kind!=='concept'||fresh.bodyAvailable||fresh.readingState==='excluded'
        ||!this.liveNeedsBody(job.path,new Set([fresh.managedId,...fresh.mergedIds])))
        return {state:'skipped' as const,reason:'节点归属或合并身份已变化，保留当前笔记。'};
    }
    const rootId = nodeId('seed', `read:${ownerId}`);
    const targetId = nodeId('concept', `read:${ownerId}`);
    const graph: KnowledgeGraph = {
      version: 1, seed: ref.title, createdAt: new Date().toISOString(),
      nodes: [
        { id: rootId, kind: 'seed', title: ref.title, excerpt: '用户打开生成的空概念，按需补充正文。', depth: 0, status: 'derived' },
        { id: targetId, kind: 'concept', managedId: ownerId, mergedIds: aliases, title: ref.title, locator: job.path,
          ...(ref.source ? {entityUrl: publicUrl(ref.source)} : {}), bodyAvailable: false,
          excerpt: '来源正文中的术语或链接名称，定义与语义关系待核实。', depth: 1, status: 'derived', reading: {state:'pending'} }
      ], edges: [], warnings: [], stats: {pagesAttempted:0,notesScanned:0,requests:0}
    };
    const result = await completeDynamic(graph, this.adapter(signal), {...this.settings, readingMode:'adaptive', readingPace:'balanced'},
      signal, undefined, {targetIds:[targetId]});
    guard();
    const source = result.nodes.find(node => node.kind === 'web' && node.managedId === ownerId && node.article);
    const target = source ?? result.nodes.find(node => node.id === targetId || node.mergedIds?.includes(targetId));
    const reading = target?.reading ?? {state:'failed' as const,reason:'本轮没有取得可确认的正文，可再次重试。'};
    // Only this original file is eligible for writing. Discovered neighbours in
    // the temporary reading graph remain unselected and are never materialized.
    while (this.busy) {
      await new Promise<void>(resolve => setTimeout(resolve, 50)); guard();
    }
    this.busy = true;
    let auditFolder: string | undefined;
    try {
      await this.refreshManagedNotes(bodyBase); guard();
      const current = this.managedNotes.get(job.path);
      const currentFile = this.app.vault.getAbstractFileByPath(job.path);
      if (!(currentFile instanceof TFile) || !current || current.managedId !== ownerId || current.kind !== 'concept'
        || current.bodyAvailable || current.source !== ref.source || current.readingState === 'excluded'
        || this.settings.excludeFolders.some(folder => job.path === folder || job.path.startsWith(folder + '/')))
        return {state:'skipped' as const,reason:'读取期间节点、正文或来源已变化，保留当前内容。'};
      const currentBytes=await this.app.vault.read(currentFile);
      if(currentBytes!==before) {
        // Live discovery may append verified relationships while this body fetch
        // is in flight. Accept only that block changing; preserve all its latest
        // bytes, and keep refusing changes to attributes or manual prose.
        const withoutLinks=(text:string)=>text.replace(new RegExp(`<!-- knowledge-seed:links:${ownerId} -->[\\s\\S]*?<!-- /knowledge-seed:links:${ownerId} -->`,'g'),'');
        if(withoutLinks(currentBytes).trimEnd()!==withoutLinks(before).trimEnd())return {state:'skipped' as const,reason:'读取期间笔记被编辑，已停止写入并保留全部编辑。'};
        mergeManagedLinks(currentBytes,ownerId,[]);before=currentBytes;
      }
      const identities = new Map<string,string>();
      for (const [path, owned] of this.managedNotes) for (const id of [owned.managedId,...owned.mergedIds]) {
        if (identities.has(id) && identities.get(id) !== path) throw new Error('多个生成笔记声称同一身份，请先审阅合并重复节点。');
        identities.set(id,path);
      }
      if (source?.locator) {
        const url = publicUrl(source.locator);
        if (ref.source ? publicUrl(ref.source) !== url : !this.canAssignResolvedSource(source, current))
          throw new Error('新正文来源与当前概念身份不一致，未写入正文。');
        for (const [path, owned] of this.managedNotes) {
          if (path === job.path || !owned.source) continue;
          let sameSource = false;
          try { sameSource = publicUrl(owned.source) === url; } catch {}
          if (sameSource) throw new Error('该来源已有独立节点，请先预览合并重复概念与正文节点，避免生成第二份正文。');
        }
        for (const id of [source.id,...(source.mergedIds ?? [])])
          if (identities.has(id) && identities.get(id) !== job.path) throw new Error('新正文身份已属于另一个节点，请先审阅去重合并。');
      }
      const article = source && webReading(source);
      const update: ManagedUpdate = {path:job.path,ownerId,lines:[],reading,
        ...(article && source ? {article,sourceUrl:source.locator,assignSource:Boolean(source.sourceResolution),
          mergedIds:[...new Set([...aliases,source.id,...(source.mergedIds??[])])].filter(id=>id!==ownerId && id!==targetId)} : {})};
      const merge = (content:string) => {
        const metadata = update.article && update.sourceUrl ? mergeManagedWebMetadata(content,ownerId,update.sourceUrl,update.assignSource) : content;
        const body = update.article ? mergeManagedArticle(metadata,ownerId,update.article) : metadata;
        const state = mergeManagedReading(body,ownerId,reading);
        return mergeGeneratedAliases(state,ownerId,update.mergedIds??[]);
      };
      const after = merge(before);
      const base = bodyBase;
      if(this.generatedBaseForFile(job.path,job.data?.mapId)!==base)throw new Error('输出目录已变化，停止补充原节点。');
      if (!job.path.startsWith(base+'/') || job.path.startsWith(base+'/Runs/')) throw new Error('输出目录已变化，停止补充原节点。');
      auditFolder = `${base}/Runs/read-${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,7)}`;
      const bundle: ExportBundle = {folder:auditFolder,rootPath:job.path,nodePaths:{[ownerId]:job.path},search:nativeSearch([job.path]),
        overviewPath:`${auditFolder}/Recovery.md`,updates:[update],files:[{path:`${auditFolder}/reading.json`,
          content:JSON.stringify({version:1,pluginVersion:this.manifest?.version??'1.4.0',kind:'background-reading',
            path:job.path,ownerId,title:ref.title,reading,source:source??null,stats:result.stats,warnings:result.warnings,
            selectedNeighbourCount:0},null,2)}]};
      await saveBundle(bundle, {
        exists:async path=>{guard();return this.app.vault.adapter.exists(path);},
        mkdir:async path=>{guard();await this.app.vault.createFolder(path);},
        create:async(path,content)=>{guard();await this.app.vault.create(path,content);},
        prepareUpdate:async()=>{guard();const actual=await this.app.vault.read(currentFile);guard();
          if(actual!==before)throw new Error('笔记在预检前被编辑，停止覆盖。');merge(actual);return actual;},
        journal:async(path,expected,next)=>{const journal=this.app.vault.getAbstractFileByPath(path);
          if(!(journal instanceof TFile))throw new Error('保存记录不存在。');
          await this.app.vault.process(journal,text=>{if(text!==expected)throw new Error('保存记录已被编辑，停止覆盖。');return next;});},
        update:async()=>{guard();await this.app.vault.process(currentFile,text=>{guard();
          if(text!==before)throw new Error('笔记在预检后被编辑，停止覆盖。');return after;});}
      });
      // Completion preserves lastRun, discovery history, graph scope and focus.
      return {state:article ? (reading.state==='no_match'?'no_match' as const:'ready' as const)
        : reading.state==='no_match'?'no_match' as const:reading.state==='excluded'?'skipped' as const:'failed' as const,
        reason:article ? `已保留 ${source!.article!.textChars} 个正文字符及目录。${reading.reason??''}` : reading.reason,
        auditFolder};
    } catch(error) {
      if(signal.aborted || error instanceof Cancelled) throw error;
      return {state:'failed' as const,reason:`补充未完成：${friendlyError(error)}${auditFolder?'；保存记录：'+auditFolder:''}`,auditFolder};
    } finally {this.busy=false;this.backgroundReader?.refreshGate();}
  }
  async refreshManagedNotes(folder=this.settings.outputFolder): Promise<void> {
    const base = safeFolder(folder);
    const next=new Map([...this.managedNotes].filter(([path])=>!path.startsWith(base+'/')));
    // The native metadata index can lag immediately after a write. Read only our
    // generated folder to establish current ownership before reusing a path.
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(base + '/') || file.path.startsWith(base + '/Runs/')) continue;
      if (this.settings.excludeFolders.some(folder => file.path === folder || file.path.startsWith(folder + '/'))) continue;
      const content = await this.app.vault.read(file);
      try {
        const ref = readManagedNote(content, file.basename);
        if (ref) next.set(file.path, ref);
      } catch { /* Invalid ownership metadata belongs to the user; do not reuse. */ }
    }
    this.managedNotes=next;
  }
  adapter(signal?: AbortSignal): EngineAdapter {
    return {
      request: async (url: string) => {
        // Obsidian's public request API avoids browser CORS; no cookies/credentials are supplied.
        const timer: { id?: ReturnType<typeof setTimeout> } = {};
        let aborted: (()=>void) | undefined;
        try {
          checkAbort(signal);
          const response = await Promise.race([
            requestUrl({ url: publicUrl(url), method: 'GET', throw: false, headers: { Accept: 'text/html,application/json;q=0.9', 'User-Agent': 'KnowledgeSeed/1.4.0 (Obsidian research plugin)' } }),
            new Promise<never>((_resolve, reject) => {
              timer.id = setTimeout(() => reject(new Error('网页请求超时（20 秒）；请检查网络后重试。')), 20000);
              aborted = () => reject(new Cancelled());
              signal?.addEventListener('abort',aborted,{once:true});
              if(signal?.aborted)aborted();
            })
          ]);
          if (new TextEncoder().encode(response.text).byteLength > 2 * 1024 * 1024) throw new Error('响应超过 2 MB 上限。');
          return { status: response.status, text: response.text, headers: response.headers };
        } finally { if (timer.id) clearTimeout(timer.id); if(aborted)signal?.removeEventListener('abort',aborted); }
      },
      listNotes: () => this.app.vault.getMarkdownFiles().filter(file=>{
        const known=this.managedNotes.get(file.path),fm=this.app.metadataCache.getFileCache(file)?.frontmatter;
        const bases=[this.settings.outputFolder,...this.liveMaps.map(map=>map.options.generatedFolder??map.folder.split('/Runs/')[0])];
        if(bases.some(base=>base&&file.path.startsWith(base+'/Runs/')))return false;
        // Generated navigation roots are graph controls, not knowledge sources.
        return known?.kind!=='seed'&&!(bases.some(base=>base&&file.path.startsWith(base+'/'))&&fm?.kind==='seed'&&typeof fm.knowledge_seed_id==='string');
      }).map(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const known = this.managedNotes.get(file.path);
        const generated = file.path.startsWith(this.settings.outputFolder + '/');
        const managedId = generated ? known?.managedId : typeof fm?.knowledge_seed_id === 'string' ? fm.knowledge_seed_id : undefined;
        return { path: file.path, title: known?.title ?? (managedId && typeof fm?.title === 'string' ? fm.title : file.basename), managedId, bodyAvailable:known?.bodyAvailable, sourceUrl:known?.source ?? (typeof fm?.source==='string' ? fm.source : undefined) };
      }),
      readNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== 'md') throw new Error(`找不到 Markdown 笔记：${path}`);
        return this.app.vault.cachedRead(file);
      },
      resolveLink: (link, from) => this.app.metadataCache.getFirstLinkpathDest(link, from)?.path ?? null,
      noteLinks: path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== 'md') return undefined;
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return undefined;
        return (cache.links ?? []).filter(link => link.position.end.offset <= 200000
          && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.link.trim()))
          .map(link => ({ target: link.link, label: link.displayText, quote: link.original, endOffset: link.position.end.offset }));
      }
    };
  }
  private combineManagedSourceViews(graph: KnowledgeGraph, owned: Map<string, {path: string; ownerId: string}>): KnowledgeGraph {
    const urlKey = (value?: string): string | undefined => {try{return value ? publicUrl(value) : undefined;}catch{return undefined;}};
    const webByPath = new Map<string, typeof graph.nodes>();
    for (const node of graph.nodes.filter(node=>node.kind==='web' && node.status==='retrieved' && node.article)) {
      const canonical = owned.get(node.id), ref = canonical && this.managedNotes.get(canonical.path);
      if (!canonical || !ref || node.managedId !== ref.managedId || !urlKey(ref.source) || urlKey(node.locator)!==urlKey(ref.source)) continue;
      const views = webByPath.get(canonical.path) ?? []; views.push(node); webByPath.set(canonical.path,views);
    }
    const moved = new Map<string,string>();
    const aliases = new Map<string,Set<string>>();
    for (const [path,views] of webByPath) {
      // All views already share the live file's owner and explicit URL. Keep the
      // most complete retrieved reading rather than downgrading a longer source.
      const target = [...views].sort((a,b)=>(b.article?.textChars??0)-(a.article?.textChars??0)
        || Number(b.id===b.managedId)-Number(a.id===a.managedId))[0];
      const ref = this.managedNotes.get(path)!;
      const duplicates = graph.nodes.filter(node=>node.id!==target.id && node.kind!=='seed' && (
        views.some(view=>view.id===node.id)
        || ((node.kind==='note' || node.kind==='concept') && node.locator===path && node.managedId===ref.managedId
          && (!node.entityUrl || urlKey(node.entityUrl)===urlKey(ref.source)))
      ));
      for (const node of duplicates) {
        moved.set(node.id,target.id);
        const ids = aliases.get(target.id) ?? new Set<string>(target.mergedIds??[]);
        // File-view note IDs depend on paths, so they are remapped in this audit
        // without becoming permanent entity aliases after a later file rename.
        if(node.kind==='web' || node.kind==='concept') ids.add(node.id);
        for(const id of node.mergedIds??[]) ids.add(id);
        aliases.set(target.id,ids);
      }
    }
    if(!moved.size)return graph;
    const result: KnowledgeGraph = {...graph,nodes:graph.nodes.filter(node=>!moved.has(node.id)).map(node=>aliases.has(node.id)
      ? {...node,mergedIds:[...aliases.get(node.id)!].filter(id=>id!==(node.managedId??node.id))} : node),edges:[],
      warnings:[...graph.warnings,`已将 ${moved.size} 个同一生成文件的已有笔记或网页视图合并，保留原文件正文、关系与证据。`]};
    for(const edge of graph.edges)for(const evidence of edge.evidence)addEdge(result,moved.get(edge.from)??edge.from,moved.get(edge.to)??edge.to,edge.relation,
      {...evidence,sourceId:moved.get(evidence.sourceId)??evidence.sourceId});
    return result;
  }
  private canAssignResolvedSource(node: import('./graph').GraphNode, ref: {kind?:string;source?:string;bodyAvailable:boolean;title:string}): boolean {
    if(ref.kind!=='concept'||ref.source||ref.bodyAvailable||node.kind!=='web'||node.status!=='retrieved'
      ||!node.article?.textChars||node.reading?.state!=='ready'||typeof node.sourceResolution?.term!=='string'
      ||typeof node.sourceResolution.queryUrl!=='string'||!node.locator
      ||normalizeText(cleanKnowledgeTitle(node.sourceResolution.term))!==normalizeText(cleanKnowledgeTitle(ref.title)))return false;
    try {
      const query=new URL(publicUrl(node.sourceResolution.queryUrl)),source=new URL(publicUrl(node.locator));
      return query.protocol==='https:'&&!query.port&&['zh.wikipedia.org','en.wikipedia.org'].includes(query.hostname)
        &&query.pathname==='/w/api.php'&&query.searchParams.get('action')==='query'&&query.searchParams.get('list')==='search'
        &&query.searchParams.get('srnamespace')==='0'&&query.searchParams.get('format')==='json'
        &&normalizeText(query.searchParams.get('srsearch')??'').includes(normalizeText(node.sourceResolution.term))
        &&source.protocol==='https:'&&!source.port&&source.hostname===query.hostname&&source.pathname.startsWith('/wiki/');
    }catch{return false;}
  }
  private managedPreviewSourceViews(input: KnowledgeGraph): KnowledgeGraph {
    const graph={...input,nodes:input.nodes.map(node=>({...node}))};
    const owned=new Map<string,{path:string;ownerId:string}>();
    for(const[path,ref]of this.managedNotes)for(const id of[ref.managedId,...ref.mergedIds]){
      const prior=owned.get(id);
      if(prior&&prior.path!==path)throw new Error('多个生成笔记声称同一身份，请先检查重复节点。');
      owned.set(id,{path,ownerId:ref.managedId});
    }
    for(const node of graph.nodes.filter(node=>node.kind==='web'&&node.status==='retrieved'&&node.article)){
      if(owned.has(node.id)||!node.locator)continue;
      const claimed=node.managedId&&owned.get(node.managedId),claimedRef=claimed&&this.managedNotes.get(claimed.path);
      if(claimed&&claimedRef&&!claimedRef.source){
        if(!this.canAssignResolvedSource(node,claimedRef))throw new Error('已有概念的正文来源确认信息无效，原笔记未修改。');
        owned.set(node.id,claimed);node.mergedIds=[...new Set([...(node.mergedIds??[]),node.id])];continue;
      }
      const url=publicUrl(node.locator);
      const matches=[...this.managedNotes].filter(([,ref])=>{
        if((ref.kind!=='concept'&&ref.kind!=='web')||!ref.source)return false;
        try{return publicUrl(ref.source)===url;}catch{return false;}
      });
      if(matches.length!==1)continue;
      const[path,ref]=matches[0];owned.set(node.id,{path,ownerId:ref.managedId});
      node.mergedIds=[...new Set([...(node.mergedIds??[]),node.id])];
    }
    for(const node of graph.nodes){
      const canonical=owned.get(node.id);if(!canonical)continue;
      const ref=this.managedNotes.get(canonical.path),source=ref?.source;
      if(node.entityUrl&&(!source||publicUrl(node.entityUrl)!==publicUrl(source))&&!(ref&&this.canAssignResolvedSource(node,ref)))throw new Error('当前概念网址与已合并身份冲突，请重新发现。');
      if(node.kind==='web'&&!source&&ref&&!this.canAssignResolvedSource(node,ref))throw new Error('已有概念的正文来源确认信息无效，原笔记未修改。');
      if(node.kind==='web'&&source&&node.locator&&publicUrl(node.locator)!==publicUrl(source))throw new Error('已有网页笔记的来源与本次读取网址冲突，请重新发现，原正文未修改。');
      node.managedId=canonical.ownerId;
    }
    return this.combineManagedSourceViews(coalesceGraph(graph),owned);
  }
  async discover(seed: Seed, progress: (text: string) => void, overrides: Partial<Settings> = {}, hooks: ReadingHooks = {}): Promise<KnowledgeGraph> {
    if (this.busy) throw new Error('已有任务正在进行。');
    this.backgroundReader?.pause();
    this.busy = true; this.activeController = new AbortController();
    try {
      const folder = safeFolder(this.settings.outputFolder);
      await this.refreshManagedNotes();
      const raw = {...this.settings, ...overrides};
      const configured = Object.fromEntries(Object.keys(defaults).map(key => [key, raw[key as keyof Options]])) as unknown as Options;
      const options = { ...clampOptions({...configured, generatedFolder: folder}), graphDepth: displayDepth(overrides.graphDepth ?? this.settings.graphDepth) };
      const {generatedFolder: _generatedFolder, ...requestOptions} = options;
      const decorate = (graph: KnowledgeGraph): KnowledgeGraph => ({...this.managedPreviewSourceViews(graph),displayDepth:options.graphDepth,
        request:{seed:{...seed,value:seed.value.trim()},options:cloneRunOptions(requestOptions)}});
      const graph = options.readingMode==='adaptive'
        ? await discoverDynamic({...seed},this.adapter(this.activeController.signal),options,this.activeController.signal,progress,{...hooks,onSnapshot:graph=>hooks.onSnapshot?.(decorate(graph))})
        : await generateGraph({...seed},this.adapter(this.activeController.signal),options,this.activeController.signal,progress);
      return decorate(graph);
    } finally { this.busy = false; this.activeController = undefined; if (!this.backgroundPaused) this.backgroundReader?.resume(); }
  }
  async complete(graph: KnowledgeGraph, progress: (text:string)=>void, hooks: ReadingHooks = {}): Promise<KnowledgeGraph> {
    if(this.busy)throw new Error('已有任务正在进行。');
    this.backgroundReader?.pause();
    this.busy=true;this.activeController=new AbortController();
    try {
      await this.refreshManagedNotes();
      const options={...clampOptions({...this.settings,...graph.request?.options,readingMode:'adaptive',generatedFolder:safeFolder(this.settings.outputFolder)}),
        graphDepth:displayDepth(graph.displayDepth??this.settings.graphDepth)};
      const decorate=(next:KnowledgeGraph):KnowledgeGraph=>({...this.managedPreviewSourceViews(next),displayDepth:options.graphDepth,request:graph.request});
      return decorate(await completeDynamic(graph,this.adapter(this.activeController.signal),options,this.activeController.signal,progress,
        {...hooks,onSnapshot:next=>hooks.onSnapshot?.(decorate(next))}));
    } finally {this.busy=false;this.activeController=undefined;if (!this.backgroundPaused) this.backgroundReader?.resume();}
  }
  async persist(graph: KnowledgeGraph, live?: {signal:AbortSignal; baseFolder?:string; saved:(run:NativeRun,graph:KnowledgeGraph)=>Promise<void>}): Promise<string> {
    if (this.busy) throw new Error('已有任务正在进行。');
    graph = coalesceGraph({...graph,nodes:graph.nodes.map(node=>({...node}))});
    if (!live && !graph.nodes.some(n => n.status === 'retrieved')) throw new Error('没有成功获取来源，无法保存知识地图。');
    const guard=()=>{checkAbort(live?.signal);if(this.disposed)throw new Cancelled();};
    guard();
    const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
    if(!live)this.backgroundReader?.pause();
    this.busy = true;
    let folder = this.settings.outputFolder;
    try {
      const base = safeFolder(live?.baseFolder??this.settings.outputFolder);
      await this.refreshManagedNotes(base);
      guard();
      const nodePaths: Record<string, string> = {}, existing: Record<string, string> = {};
      const owned = new Map<string, {path: string; ownerId: string}>();
      for (const [path, ref] of this.managedNotes) for (const id of [ref.managedId, ...ref.mergedIds]) {
        const prior = owned.get(id);
        if (prior && prior.path !== path) throw new Error('多个生成笔记声称同一身份，请先检查重复节点。');
        owned.set(id, {path, ownerId: ref.managedId});
      }
      for (const node of graph.nodes.filter(node=>node.kind==='web' && node.article)) {
        if (owned.has(node.id) || !node.locator) continue;
        const claimed=node.managedId&&owned.get(node.managedId),claimedRef=claimed&&this.managedNotes.get(claimed.path);
        if(claimed&&claimedRef&&!claimedRef.source){
          if(!this.canAssignResolvedSource(node,claimedRef))throw new Error('已有概念的正文来源确认信息无效，原笔记未修改。');
          owned.set(node.id,claimed);node.mergedIds=[...new Set([...(node.mergedIds??[]),node.id])];continue;
        }
        const url = publicUrl(node.locator);
        const matches = [...this.managedNotes].filter(([,ref])=>{
          if((ref.kind!=='concept' && ref.kind!=='web') || !ref.source) return false;
          try{return publicUrl(ref.source)===url;}catch{return false;}
        });
        if(matches.length!==1) continue;
        const [path,ref] = matches[0];
        owned.set(node.id,{path,ownerId:ref.managedId});
        node.mergedIds=[...new Set([...(node.mergedIds??[]),node.id])];
      }
      for (const node of graph.nodes) {
        const canonical = owned.get(node.id);
        if (!canonical) continue;
        const ref=this.managedNotes.get(canonical.path),source=ref?.source;
        if (node.entityUrl && (!source || publicUrl(node.entityUrl)!==publicUrl(source)) && !(ref&&this.canAssignResolvedSource(node,ref))) throw new Error('当前概念网址与已合并身份冲突，请重新发现。');
        if(node.kind==='web'&&!source&&ref&&!this.canAssignResolvedSource(node,ref))throw new Error('已有概念的正文来源确认信息无效，原笔记未修改。');
        if(node.kind==='web' && source && node.locator && publicUrl(node.locator)!==publicUrl(source)) throw new Error('已有网页笔记的来源与本次读取网址冲突，请重新发现，原正文未修改。');
        node.managedId=canonical.ownerId;
        if((node.kind==='note'||node.kind==='concept')&&node.locator?.endsWith('.md'))node.locator=canonical.path;
        if(live && ref?.bodyAvailable && !node.article) {node.bodyAvailable=true;node.reading={state:'ready'};}
      }
      const root=graph.nodes.find(node=>node.kind==='seed')!,rootFile=owned.get(root.id);
      if(rootFile&&this.managedNotes.get(rootFile.path)?.kind==='seed')
        graph=foldOwnedRootFileViews(graph,rootFile.path,rootFile.ownerId);
      graph=coalesceGraph(graph);
      graph=this.combineManagedSourceViews(graph,owned);
      for(const node of graph.nodes){
        const retainedPath=(node.kind==='note'||node.kind==='concept')&&node.locator?.endsWith('.md')
          ?node.locator:owned.get(node.id)?.path;
        for(const alias of node.mergedIds??[]){
          const claimed=owned.get(alias);
          if(claimed&&claimed.path!==retainedPath)throw new Error(`另一篇生成笔记已拥有该概念身份：${claimed.path}。请先使用“合并重复概念与正文节点”预览并去重合并，原笔记未修改。`);
        }
      }
      const allocated = new Set<string>();
      const rootFileTitle=graph.request?.seed.kind==='note'?`${cleanKnowledgeTitle(root.title)}（图谱入口）`:undefined;
      for (const node of graph.nodes) {
        if ((node.kind === 'note' || node.kind === 'concept') && node.locator?.endsWith('.md')) {
          const target = this.app.vault.getAbstractFileByPath(node.locator);
          if (!(target instanceof TFile)) throw new Error(`原笔记已移动或删除：${node.locator}；请重新发现。`);
          nodePaths[node.id] = target.path;
          if (node.managedId && target.path.startsWith(base + '/')) existing[target.path] = node.managedId;
          continue;
        }
        const reused = owned.get(node.id);
        if (reused) { nodePaths[node.id] = reused.path; existing[reused.path] = reused.ownerId; node.managedId = reused.ownerId; continue; }
        const category = node.kind === 'seed' ? '起点' : node.kind === 'web' ? '网页' : '概念';
        const name = safeName(node.kind==='seed'&&rootFileTitle?rootFileTitle:cleanKnowledgeTitle(node.title)).replace(/%/g, '-');
        let candidate = `${base}/${category}/${name}.md`, suffix = 2;
        while (allocated.has(candidate.toLocaleLowerCase()) || this.app.vault.getMarkdownFiles().some(file => file.path.toLocaleLowerCase() === candidate.toLocaleLowerCase()) || await this.app.vault.adapter.exists(candidate)) candidate = `${base}/${category}/${name} (${suffix++}).md`;
        allocated.add(candidate.toLocaleLowerCase()); nodePaths[node.id] = candidate;
      }
      const bundle = exportGraph(graph, base, runId, { nodePaths, existing, canvas: this.settings.exportCanvas,rootFileTitle });
      if(live) {
        const structural={...graph,nodes:graph.nodes.map(({article,...node})=>({...node,excerpt:node.excerpt.slice(0,400),
          ...(article?{bodyAvailable:true}:{})})),edges:graph.edges.map(edge=>({...edge,evidence:edge.evidence.map(item=>({...item,quote:item.quote.slice(0,600)}))}))};
        const document=bundle.files.find(file=>file.path.endsWith('/graph.json'));
        if(document)document.content=JSON.stringify(structural,null,2);
      }
      folder = bundle.folder;
      const preparedUpdates=new Map<string,{before:string;after:string}>();
      const mergeUpdate=(content:string,update:import('./export').ManagedUpdate):string=>{
        const metadata=update.article&&update.sourceUrl?mergeManagedWebMetadata(content,update.ownerId,update.sourceUrl,update.assignSource===true):content;
        const withArticle=update.article?mergeManagedArticle(metadata,update.ownerId,update.article):metadata;
        const withReading=update.reading?mergeManagedReading(withArticle,update.ownerId,update.reading):withArticle;
        const withAliases=mergeGeneratedAliases(withReading,update.ownerId,update.mergedIds??[]);
        return mergeManagedLinks(withAliases,update.ownerId,update.lines);
      };
      // Repeated concept snapshots commonly change only a few relationship blocks.
      // Omit byte-identical replacements rather than backing up every old node.
      if(live) {
        const changed:ManagedUpdate[]=[];
        for(const update of bundle.updates) {
          guard();const file=this.app.vault.getAbstractFileByPath(update.path);
          if(!(file instanceof TFile))throw new Error(`生成节点已移动：${update.path}`);
          const before=await this.app.vault.read(file);
          if(mergeUpdate(before,update)!==before)changed.push(update);
        }
        bundle.updates=changed;
      }
      await saveBundle(bundle, {
        exists: async path => {guard();return this.app.vault.adapter.exists(normalizePath(path));},
        mkdir: async path => {guard();await this.app.vault.createFolder(normalizePath(path));},
        create: async (path, content) => {
          guard();await this.app.vault.create(normalizePath(path), content);
          if(path.startsWith(base+'/')&&!path.startsWith(base+'/Runs/')&&path.endsWith('.md')) {
            const ref=readManagedNote(content,path.split('/').pop()!.replace(/\.md$/,''));
            if(ref)this.managedNotes.set(path,ref);
          }
        },
        prepareUpdate:async update=>{
          guard();
          const file=this.app.vault.getAbstractFileByPath(update.path);
          if(!(file instanceof TFile))throw new Error(`找不到生成笔记：${update.path}`);
          const before=await this.app.vault.read(file),after=mergeUpdate(before,update);
          preparedUpdates.set(update.path,{before,after});return before;
        },
        journal:async(path,expected,next)=>{
          const file=this.app.vault.getAbstractFileByPath(path);
          if(!(file instanceof TFile))throw new Error('本次保存日志不存在，停止保存。');
          await this.app.vault.process(file,current=>{if(current!==expected)throw new Error('本次保存日志已被修改，停止覆盖。');return next;});
        },
        update: async (path, ownerId, lines, article) => {
          guard();
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error(`找不到生成笔记：${path}`);
          const prepared=preparedUpdates.get(path);
          if(!prepared)throw new Error(`生成笔记尚未完成预检：${path}`);
          await this.app.vault.process(file, content => {
            guard();
            if(content!==prepared.before)throw new Error(`生成笔记在预检后被编辑，请重新保存；本次不会覆盖新内容：${path}`);
            return prepared.after;
          });
        }
      });
      const currentRun: NativeRun = { rootPath: bundle.rootPath, search: bundle.search, folder: bundle.folder, graphDepth: displayDepth(graph.displayDepth), nodePaths: bundle.nodePaths };
      if(live) {guard();await live.saved(currentRun,graph);return bundle.folder;}
      this.lastRun = currentRun;
      try {
        this.lastRun = await this.integratedNativeRun(currentRun);
        await this.app.vault.create(`${bundle.folder}/integrated.json`, JSON.stringify(this.lastRun, null, 2));
      } catch (error) { new Notice(`本次笔记已保存；整合历史图谱失败，可重新打开图谱重试：${friendlyError(error)}`); }
      this.history = rememberRun(this.history, {run: this.lastRun, title: graph.nodes.find(node => node.kind === 'seed')?.title ?? graph.seed,
        createdAt: graph.createdAt, nodes: graph.nodes.length, relations: graph.edges.length, request: graph.request});
      try { await this.saveSettings(); }
      catch { new Notice('笔记与证据已完整保存；记住上次图谱失败，下次启动可从起点笔记手动打开局部关系图。'); }
      try { await this.openNativeGraph(this.lastRun); }
      catch { new Notice(`文件已保存，自动打开原生关系图失败；请手动打开 ${bundle.rootPath} 的局部关系图。`); }
      const integratedCount = new Set(Object.values(this.lastRun.nodePaths ?? bundle.nodePaths)).size;
      new Notice(`本次保存 ${graph.nodes.length} 个节点和 ${graph.edges.length} 条关系${integratedCount > graph.nodes.length ? `；整合图谱范围包含 ${integratedCount} 篇笔记` : ''}。`);
      return bundle.folder;
    } catch (e) {
      throw new Error(`保存未完成：${friendlyError(e)}。如果已出现目录“${folder}”，其中是本次部分输出；缺少 COMPLETE.json 表示未完成。`);
    } finally { this.busy = false; if(!live && !this.backgroundPaused)this.backgroundReader?.resume(); }
  }
  private restoreNativeLeaves(run: NativeRun): void {
    const graph = this.app.workspace.getLeavesOfType('localgraph').find(leaf => {
      const state = leaf.getViewState();
      return state.pinned === true && state.state?.file === run.rootPath;
    });
    if (!graph) return;
    this.nativeGraphLeaf = graph; this.nativeGraphFile = run.rootPath;
    this.nativeRootLeaf = this.app.workspace.getLeavesOfType('markdown')
      .find(leaf => leaf.getViewState().state?.file === run.rootPath);
    this.nativeRootFile = this.nativeRootLeaf ? run.rootPath : undefined;
  }
  openNativeGraph(run: NativeRun): Promise<void> {
    // Commands can overlap while openFile awaits. Serialize them to preserve
    // one owned pair, including when the requested run changes.
    const task = this.nativeOpenTask.catch(() => {}).then(async () => this.showNativeGraph(await this.integratedNativeRun(run)));
    this.nativeOpenTask = task;
    return task;
  }
  /** Read completed manifests; graph membership follows actual files, not equal display names. */
  async integratedNativeRun(run: NativeRun): Promise<NativeRun> {
    await this.refreshManagedNotes();
    const base = safeFolder(this.settings.outputFolder), prefix = `${base}/Runs/`;
    const files = this.app.vault.getFiles();
    const allPaths = new Set(files.map(file => file.path));
    const ordinaryNote = (path: unknown): path is string => typeof path === 'string' && path.endsWith('.md')
      && !/^(?:\/|[a-z]:)/i.test(path) && !/[\\\x00-\x1f]/.test(path)
      && path.split('/').every(part => part && !part.startsWith('.')) && !path.startsWith(prefix);
    const allowed = new Set(files.filter(file => ordinaryNote(file.path)
      && !this.settings.excludeFolders.some(folder => file.path === folder || file.path.startsWith(folder + '/'))
      && this.managedNotes.get(file.path)?.readingState !== 'excluded'
      && !(this.managedNotes.get(file.path)?.kind === 'concept' && !this.managedNotes.get(file.path)?.bodyAvailable
        && !['pending','reading','failed','no_match'].includes(this.managedNotes.get(file.path)?.readingState ?? '')))
      .map(file => file.path));
    const identities = new Map<string, string | null>();
    for (const [path, ref] of this.managedNotes) for (const id of [ref.managedId, ...ref.mergedIds])
      identities.set(id, identities.has(id) && identities.get(id) !== path ? null : path);
    const completed: NativeRun[] = [];
    for (const file of files.filter(file => file.path.startsWith(prefix) && file.path.endsWith('/native.json')
      && file.path.slice(prefix.length).split('/').length === 2)) {
      const folder = file.path.slice(0, -'/native.json'.length);
      if (!allPaths.has(`${folder}/COMPLETE.json`)) continue;
      try {
        const completion = JSON.parse(await this.app.vault.adapter.read(`${folder}/COMPLETE.json`));
        if (completion.status !== 'complete') continue;
        const native = JSON.parse(await this.app.vault.read(file));
        if (!ordinaryNote(native.rootPath) || !native.nodePaths || typeof native.nodePaths !== 'object' || Array.isArray(native.nodePaths)) continue;
        if (Object.values(native.nodePaths).some(path => !ordinaryNote(path))) continue;
        const paths: Record<string, string> = {};
        for (const [id, path] of Object.entries(native.nodePaths)) {
          if (!/^[a-z0-9_-]+$/i.test(id)) continue;
          const ownedPath = identities.get(id);
          paths[id] = ownedPath ?? path as string;
        }
        const rootId = Object.keys(native.nodePaths).find(id => native.nodePaths[id] === native.rootPath);
        const rootPath = rootId ? paths[rootId] : native.rootPath;
        if (!rootPath || !allPaths.has(rootPath)) continue;
        completed.push({folder, rootPath, nodePaths: paths, search: nativeSearch(Object.values(paths)), graphDepth:run.graphDepth});
      } catch { /* Incomplete, malformed or unrelated files cannot extend the map. */ }
    }
    const currentSnapshot = completed.find(item => item.folder === run.folder);
    const remappedCurrent = run.nodePaths ? Object.fromEntries(Object.entries(run.nodePaths)
      .map(([id,path]) => [id, identities.get(id) ?? path])) : undefined;
    const currentRootId = Object.keys(run.nodePaths ?? {}).find(id => run.nodePaths![id] === run.rootPath);
    const rootPath = currentSnapshot?.rootPath ?? (currentRootId && remappedCurrent ? remappedCurrent[currentRootId] : run.rootPath);
    const {integratedFolders: previousScope, ...singleRun} = run;
    // Recompute from the original single-run selection. An old union would keep
    // disconnected historical nodes alive after their shared bridge disappears.
    // Without that snapshot, an integrated legacy view can safely retain only
    // its requested root; a legacy single-run selection remains compatible.
    const restored: NativeRun = {...singleRun, rootPath, nodePaths: currentSnapshot?.nodePaths
      ?? (Array.isArray(previousScope) ? {[currentRootId ?? `root-${stableId(rootPath)}`]:rootPath} : remappedCurrent ?? {})};
    for (const path of Object.values(restored.nodePaths ?? {})) if (ordinaryNote(path) && allPaths.has(path)
      && !this.settings.excludeFolders.some(folder => path === folder || path.startsWith(folder + '/'))
      && this.managedNotes.get(path)?.readingState !== 'excluded') allowed.add(path);
    return integrateNativeRuns({...restored,graphDepth:run.graphDepth}, completed, allowed);
  }
  private async showNativeGraph(run: NativeRun): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(run.rootPath);
    if (!(file instanceof TFile)) throw new Error('起点笔记不存在；请重新生成。');
    const workspace = this.app.workspace;
    if (!this.nativeRootLeaf || !workspace.getLeavesOfType('markdown').includes(this.nativeRootLeaf)
      || this.nativeRootLeaf.getViewState().state?.file !== this.nativeRootFile) this.nativeRootLeaf = undefined;
    if (!this.nativeGraphLeaf || !workspace.getLeavesOfType('localgraph').includes(this.nativeGraphLeaf)
      || this.nativeGraphLeaf.getViewState().state?.file !== this.nativeGraphFile
      || this.nativeGraphLeaf.getViewState().pinned !== true) this.nativeGraphLeaf = undefined;
    if (!this.nativeRootLeaf && !this.nativeGraphLeaf) this.restoreNativeLeaves(run);
    const root = this.nativeRootLeaf ?? workspace.getLeaf('tab');
    this.nativeRootLeaf = root;
    await root.openFile(file); this.nativeRootFile = file.path;
    const leaf = this.nativeGraphLeaf ?? workspace.getLeaf('split');
    this.nativeGraphLeaf = leaf;
    leaf.setPinned(true);
    await leaf.setViewState({ type: 'localgraph', active: true, pinned: true, state: {
      file: file.path, options: { search: run.search, localJumps: displayDepth(run.graphDepth), localBacklinks: true, localForelinks: true, localInterlinks: true, showAttachments: false, hideUnresolved: true }
    } });
    this.nativeGraphFile = file.path;
  }

  async nameCleanupPlan(): Promise<NameChange[]> {
    await this.refreshManagedNotes();
    return planNameCleanup([...this.managedNotes].map(([path, ref]) => ({ path, ...ref })), new Set(this.app.vault.getMarkdownFiles().map(file => file.path)));
  }
  async duplicateMergePlan(): Promise<MergeCandidate[]> {
    if (this.busy) throw new Error('请等待当前任务结束。');
    await this.refreshManagedNotes();
    const notes: MergeNote[] = [];
    for (const [path, ref] of this.managedNotes) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) notes.push({path, ownerId:ref.managedId, title:ref.title, kind:ref.kind ?? '', source:ref.source, content:await this.app.vault.read(file)});
    }
    const found = new Map<string, MergeCandidate>(), ambiguous = new Set<string>();
    for(const candidate of planSourceMerges(notes))found.set(candidate.from,candidate);
    const runs = [this.lastRun, ...this.history.map(record => record.run)].filter((run): run is NativeRun => Boolean(run));
    for (const run of runs) {
      // Immutable original graphs are evidence, not rewritten migration targets.
      if (!run.folder.startsWith(safeFolder(this.settings.outputFolder) + '/Runs/')) continue;
      try {
        const graph = JSON.parse(await this.app.vault.adapter.read(`${run.folder}/graph.json`)) as KnowledgeGraph;
        const paths = run.nodePaths ?? JSON.parse(await this.app.vault.adapter.read(`${run.folder}/native.json`)).nodePaths;
        for (const candidate of planLegacyMerges(graph, paths, notes)) {
          if (found.has(candidate.from) && found.get(candidate.from)!.to !== candidate.to) ambiguous.add(candidate.from);
          found.set(candidate.from, candidate);
        }
      } catch { /* Missing historical evidence never authorizes a title-only merge. */ }
    }
    return [...found.values()].filter(candidate => !ambiguous.has(candidate.from)).sort((a,b) => a.title.localeCompare(b.title));
  }
  async applyDuplicateMerge(candidates: MergeCandidate[]): Promise<string> {
    if (this.busy) throw new Error('请等待当前任务结束。');
    if (!candidates.length) throw new Error('请先选择需要合并的节点。');
    const fresh = await this.duplicateMergePlan();
    if (candidates.some(item => !fresh.some(row => JSON.stringify(row) === JSON.stringify(item)))) throw new Error('合并候选已变化，请重新预览。');
    const owners=new Map<string,string>();
    for(const[path,ref]of this.managedNotes)for(const id of[ref.managedId,...ref.mergedIds]){
      const prior=owners.get(id);
      if(prior&&prior!==path)throw new Error(`生成笔记身份冲突：${prior} 与 ${path}。请先核对笔记属性，原文未修改。`);
      owners.set(id,path);
    }
    this.busy = true;
    const base = safeFolder(this.settings.outputFolder), folder = `${base}/Runs/merge-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const before = new Map<string,string>(), after = new Map<string,string>(), rewired = new Map<string,string>(), sources = new Set(candidates.map(item => item.from));
    let completed: Array<{from:string;to:string}> = [];
    let failure: unknown;
    let journalContent: string | undefined;
    try {
      for (const candidate of candidates) for (const path of [candidate.from,candidate.to]) if (!before.has(path)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`合并文件已移动：${path}`);
        before.set(path,await this.app.vault.read(file));
      }
      for (const candidate of candidates) {
        if (stableId(before.get(candidate.from)!) !== candidate.fromHash || stableId(before.get(candidate.to)!) !== candidate.toHash) throw new Error('笔记已修改，请重新预览。');
      }
      const moved = new Map(candidates.map(candidate => [candidate.from,candidate.to]));
      // Use the native index and exact offsets; never rewrite prose, code or ambiguous labels.
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (file.path.startsWith(base + '/Runs/')) continue;
        const content = before.get(file.path) ?? await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) throw new Error(`笔记链接尚未建立索引：${file.path}；请稍后再试。`);
        const replacements = new Map<string,{start:number;end:number;text:string}>();
        for (const link of [...(cache.links ?? []),...(cache.embeds ?? [])]) {
          const destination = this.app.metadataCache.getFirstLinkpathDest(link.link.split('#')[0],file.path);
          const to = destination && moved.get(destination.path); if (!to) continue;
          const target = this.app.vault.getAbstractFileByPath(to); if (!(target instanceof TFile)) throw new Error(`合并目标已移动：${to}`);
          const {start,end} = link.position;
          if (content.slice(start.offset,end.offset) !== link.original) throw new Error(`链接索引与正文不一致：${file.path}；请稍后再试。`);
          const hash = link.link.indexOf('#'), subpath = hash < 0 ? '' : link.link.slice(hash);
          const text = this.app.fileManager.generateMarkdownLink(target,file.path,subpath,link.displayText);
          replacements.set(`${start.offset}:${end.offset}`,{start:start.offset,end:end.offset,text:(link.original.startsWith('!') ? '!' : '') + text});
        }
        if (!replacements.size) continue;
        before.set(file.path,content);
        let rewritten = content;
        let boundary = content.length;
        for (const item of [...replacements.values()].sort((a,b)=>b.start-a.start)) {
          if (item.end > boundary) throw new Error(`链接索引存在重叠：${file.path}`);
          boundary = item.start; rewritten = rewritten.slice(0,item.start)+item.text+rewritten.slice(item.end);
        }
        rewired.set(file.path,rewritten);
        if (!sources.has(file.path)) after.set(file.path,rewritten);
      }
      for (const candidate of candidates) {
        const target = after.get(candidate.to) ?? before.get(candidate.to)!;
        const source = rewired.get(candidate.from) ?? before.get(candidate.from)!;
        after.set(candidate.to,mergeDuplicateContent(target,source,{...candidate,toHash:stableId(target),fromHash:stableId(source)}));
      }
      const settingsBefore = JSON.stringify((await this.loadData()) ?? {...this.settings,lastRun:this.lastRun,history:this.history},null,2);
      const result = await executeMergeTransaction(folder,[...after].map(([path,body])=>({path,before:before.get(path)!,after:body})),
        candidates.map(candidate=>({path:candidate.from,content:before.get(candidate.from)!,to:candidate.to})),{
          exists:path=>this.app.vault.adapter.exists(path), mkdir:async path=>{await this.app.vault.createFolder(path);},
          create:async(path,content)=>{if(path===`${folder}/journal.json`){await this.app.vault.create(`${folder}/plugin-data-before.bak`,settingsBefore);}await this.app.vault.create(path,content);if(path===`${folder}/journal.json`)journalContent=content;},
          journal:async(path,content)=>{const file=this.app.vault.getAbstractFileByPath(path); if(!(file instanceof TFile)) throw new Error('合并日志不存在。'); await this.app.vault.process(file,current=>{if(current!==journalContent)throw new Error('合并日志已被修改，停止覆盖。');return content;});journalContent=content;},
          process:async(path,expected,content)=>{const file=this.app.vault.getAbstractFileByPath(path); if(!(file instanceof TFile)) throw new Error(`文件已移动：${path}`); await this.app.vault.process(file,current=>{if(current!==expected) throw new Error(`文件正在被编辑：${path}`); return content;});},
          trash:async(path,expected,retained)=>{const file=this.app.vault.getAbstractFileByPath(path); if(!(file instanceof TFile) || await this.app.vault.read(file)!==expected) throw new Error(`归档来源已变化：${path}`); if(!retained || await this.app.vault.adapter.exists(retained))throw new Error('原文件归档路径不可用。'); await this.app.vault.rename(file,retained);}
        });
      completed = result.completed;
    } catch (error) { completed = error instanceof MergeTransactionError ? error.completed : []; failure = error; }
    try {
      if (completed.length) {
        const moved = new Map(completed.map(item=>[item.from,item.to]));
        this.remapLivePaths(moved);
        const previousRun = this.lastRun;
        this.history = this.history.map(record=>({...record,run:moveRun(record.run,moved),request:record.request?.seed.kind==='note' ? {...record.request,seed:{...record.request.seed,value:moved.get(record.request.seed.value)??record.request.seed.value}} : record.request}));
        if (this.lastRun) this.lastRun = moveRun(this.lastRun,moved);
        // Keep historical graph/native manifests immutable. A new projection records
        // the surviving files and remapped evidence, rather than resurrecting old paths.
        if (!failure && previousRun) {
          const original = JSON.parse(await this.app.vault.adapter.read(`${previousRun.folder}/graph.json`)) as KnowledgeGraph;
          const originalPaths = previousRun.nodePaths ?? JSON.parse(await this.app.vault.adapter.read(`${previousRun.folder}/native.json`)).nodePaths as Record<string,string>;
          const projection = coalesceGraph({...original,nodes:original.nodes.map(node=>{
            const to = moved.get(originalPaths[node.id]);
            const target = to && original.nodes.find(other=>other.kind==='web' && originalPaths[other.id]===to);
            return node.kind==='concept' && target ? {...node,entityUrl:target.locator,locator:undefined,managedId:undefined} : {...node};
          }),createdAt:new Date().toISOString(),stats:{pagesAttempted:0,notesScanned:0,requests:0}});
          const nodePaths = Object.fromEntries(projection.nodes.map(node=>[node.id,moved.get(originalPaths[node.id])??originalPaths[node.id]]));
          const current = {...this.lastRun!,folder,nodePaths,search:nativeSearch(Object.values(nodePaths))};
          await this.app.vault.create(`${folder}/graph.json`,JSON.stringify({...projection,operation:'merge',mergedFromRun:previousRun.folder,originalStats:original.stats,completed},null,2));
          await this.app.vault.create(`${folder}/native.json`,JSON.stringify({rootPath:current.rootPath,nodePaths,search:current.search,graphDepth:current.graphDepth},null,2));
          await this.app.vault.create(`${folder}/Overview.md`,[
            '# 重复节点合并记录', '',
            `合并了 ${completed.length} 对概念与正文节点，保留 ${projection.nodes.length} 个节点、${projection.edges.length} 条关系。本次操作没有读取网页。`, '',
            '## 路径变化', '',
            ...completed.map(item=>`- ${item.from} → ${item.to}`), '',
            '## 备份与核查', '',
            'journal.json 记录每个原路径及其 .bak 备份。原概念文件以 source-N.bak 保留，完整正文、关系和属性已并入目标笔记。', '',
            `原探索记录：${previousRun.folder}；其中 graph.json 与 native.json 保留原样。本目录记录合并后的节点和关系。`, '',
            '恢复时先关闭 Obsidian，按 journal.json 将各备份复制回对应原路径；将 plugin-data-before.bak 复制回插件目录的 data.json，恢复历史与当前图映射。请勿在部分恢复状态继续探索。', ''
          ].join('\n'));
          await this.app.vault.create(`${folder}/COMPLETE.json`,JSON.stringify({status:'complete',operation:'merge',completedAt:new Date().toISOString(),merged:completed.length}));
          this.lastRun=current;
          this.history=rememberRun(this.history,{run:current,title:projection.nodes.find(node=>node.kind==='seed')?.title??projection.seed,createdAt:projection.createdAt,nodes:projection.nodes.length,relations:projection.edges.length,request:projection.request});
        }
        await this.saveSettings(); await this.refreshManagedNotes();
        if (this.lastRun) {
          const map=this.liveMaps.find(map=>map.id===this.currentLiveId&&map.rootPath===this.lastRun!.rootPath);
          if(map)await this.openLiveMap(map.id);else await this.openNativeGraph(this.lastRun);
        }
        new Notice(`已合并 ${completed.length} 个重复节点。原文备份与进度记录：${folder}`);
      }
    } finally { this.busy = false; }
    if (failure) throw failure;
    return folder;
  }
  async applyNameCleanup(changes: NameChange[]): Promise<void> {
    if (this.busy) throw new Error('请等待当前任务结束。');
    if (!changes.length) return;
    this.busy = true;
    const completed: NameChange[] = [];
    let runPaths = this.lastRun?.nodePaths;
    try {
      // FileManager.renameFile updates links according to the core preference.
      // Refuse an explicitly disabled preference, rather than leave broken links.
      const configPath = `${this.app.vault.configDir}/app.json`;
      let automaticLinks = false;
      if (await this.app.vault.adapter.exists(configPath)) {
        const config = JSON.parse(await this.app.vault.adapter.read(configPath));
        automaticLinks = config.alwaysUpdateLinks === true;
      }
      if (!automaticLinks) throw new Error('请先在 Obsidian“文件与链接”设置中启用“始终更新内部链接”，再整理名称。');
      if (this.lastRun && !runPaths) {
        const manifest = JSON.parse(await this.app.vault.adapter.read(`${this.lastRun.folder}/native.json`));
        runPaths = manifest.nodePaths;
      }
      const targets = new Set<string>();
      for (const change of changes) {
        const base = safeFolder(this.settings.outputFolder);
        if (!change.from.startsWith(base + '/') || change.from.startsWith(base + '/Runs/') || change.to.slice(0, change.to.lastIndexOf('/')) !== change.from.slice(0, change.from.lastIndexOf('/'))) throw new Error('改名计划超出生成目录。');
        const file = this.app.vault.getAbstractFileByPath(change.from);
        if (!(file instanceof TFile)) throw new Error(`文件已移动：${change.from}`);
        mergeManagedLinks(await this.app.vault.read(file), change.ownerId, []);
        if (targets.has(change.to.toLocaleLowerCase()) || await this.app.vault.adapter.exists(change.to)) throw new Error(`目标已存在：${change.to}`);
        targets.add(change.to.toLocaleLowerCase());
      }
      for (const change of changes) {
        const file = this.app.vault.getAbstractFileByPath(change.from);
        if (!(file instanceof TFile)) throw new Error(`文件已移动：${change.from}`);
        mergeManagedLinks(await this.app.vault.read(file), change.ownerId, []);
        await this.app.fileManager.renameFile(file, change.to); completed.push(change);
      }
    } finally {
      const moved = new Map(completed.map(change => [change.from, change.to]));
      this.remapLivePaths(moved);
      if (completed.length) this.history = this.history.map(record => ({...record, run: moveRun(record.run, moved),
        request: record.request?.seed.kind === 'note' ? {...record.request, seed: {...record.request.seed, value: moved.get(record.request.seed.value) ?? record.request.seed.value}} : record.request}));
      if (completed.length && this.lastRun && runPaths) {
        const nodePaths = Object.fromEntries(Object.entries(runPaths).map(([id, path]) => [id, moved.get(path) ?? path]));
        this.lastRun = { ...this.lastRun, rootPath: moved.get(this.lastRun.rootPath) ?? this.lastRun.rootPath, nodePaths, search: nativeSearch(Object.values(nodePaths)) };
        this.nativeRootFile = this.nativeRootFile ? moved.get(this.nativeRootFile) ?? this.nativeRootFile : undefined;
        this.nativeGraphFile = this.nativeGraphFile ? moved.get(this.nativeGraphFile) ?? this.nativeGraphFile : undefined;
      }
      try {
        if (completed.length) {
          await this.app.vault.create(`${safeFolder(this.settings.outputFolder)}/名称整理-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), completed, requested: changes.length, currentRun: this.lastRun }, null, 2));
          await this.saveSettings();
          await this.refreshManagedNotes();
          if (this.lastRun) {
            const map=this.liveMaps.find(map=>map.id===this.currentLiveId&&map.rootPath===this.lastRun!.rootPath);
            if(map)await this.openLiveMap(map.id);else await this.openNativeGraph(this.lastRun);
          }
          new Notice(`已整理 ${completed.length} 个生成节点名称。`);
        }
      } finally { this.busy = false; }
    }
  }
}

class LiveNodeEvidenceModal extends Modal {
  constructor(app:App,private title:string,private graph:KnowledgeGraph,private nodeId:string){super(app);}
  onOpen():void {
    this.setTitle(`${this.title}：关系与来源`);
    this.modalEl.addClass('knowledge-seed-window');this.contentEl.addClass('knowledge-seed-modal');
    this.contentEl.createEl('p',{text:'以下为当前图谱保留的关系和来源证据；提及与链接不表示因果关系。',cls:'knowledge-seed-note'});
    const entries=nodeEvidence(this.graph,this.nodeId);
    if(!entries.length)this.contentEl.createEl('p',{text:'此节点尚无单独的关系证据，可打开节点笔记查看已保留内容。'});
    for(const entry of entries) {
      const item=this.contentEl.createDiv({cls:'knowledge-seed-evidence'});
      item.createEl('strong',{text:`${entry.fromTitle} → ${relationLabels[entry.relation]} → ${entry.toTitle}`});
      item.createEl('p',{text:entry.quote});item.createEl('small',{text:`${entry.sourceTitle} · ${entry.method}`});
      const locator=entry.locator??this.graph.nodes.find(node=>node.id===entry.sourceId)?.locator;
      if(locator)try{item.createEl('a',{text:'打开来源网页',href:publicUrl(locator),attr:{target:'_blank',rel:'noopener noreferrer'}});}catch{/* A vault path or unsafe URL is plain evidence, not a web link. */}
    }
  }
  onClose():void {this.contentEl.empty();}
}

class LiveStrategyModal extends Modal {
  private readonly draft:Options;
  private pending=false;
  constructor(app:App,private plugin:KnowledgeSeedPlugin,private map:LiveMapRecord){
    super(app);this.draft=cloneRunOptions({...map.options,graphDepth:5});
  }
  onOpen():void {
    this.setTitle(`调整“${this.map.title}”的探索策略`);
    this.modalEl.addClass('knowledge-seed-window');this.contentEl.addClass('knowledge-seed-modal');
    this.contentEl.createEl('p',{text:'更换策略保留已有图谱、正文和剪枝结果。正在探索的图使用新策略继续；已停止的图保存后可点击继续探索。',cls:'knowledge-seed-subtitle'});
    this.contentEl.createEl('p',{text:`本图探索深度上限为 ${this.map.options.depth} 层，节点上限保持不变。`,cls:'knowledge-seed-note'});
    const controls=this.contentEl.createDiv();renderExplorationStrategyControls(controls,this.draft);
    const status=this.contentEl.createEl('p',{attr:{role:'status'}});
    let cancelButton:import('obsidian').ButtonComponent;
    new Setting(this.contentEl).addButton(button=>button.setButtonText('保存策略').setCta().onClick(async()=>{
      if(this.pending)return;
      const invalid=controls.querySelector<HTMLInputElement|HTMLTextAreaElement>('input:invalid,textarea:invalid');
      if(invalid){invalid.focus();invalid.reportValidity();status.setText('请先修正标出的策略参数。');return;}
      this.pending=true;button.setDisabled(true);cancelButton.setDisabled(true);controls.inert=true;
      try{await this.plugin.applyLiveStrategy(this.map.id,this.draft);this.close();}
      catch(error){status.setText(friendlyError(error));}
      finally{this.pending=false;button.setDisabled(false);cancelButton.setDisabled(false);controls.inert=false;}
    })).addButton(button=>{cancelButton=button;button.setButtonText('取消').onClick(()=>this.close());});
  }
}

class SeedModal extends Modal {
  seed: Seed; running = false; keepController = false; runOptions: Settings;
  private preset = 'custom';
  private timer?: ReturnType<typeof setInterval>;
  private startButton?: HTMLButtonElement;
  private autoDetectedUrl=false;
  private startupError='';
  private generation=0;
  constructor(app: App, private plugin: KnowledgeSeedPlugin, seed?: Seed, request?: DiscoveryConfig) {
    super(app); this.seed = {...(request?.seed ?? seed ?? { kind: 'topic', value: '' })};
    const options = {...plugin.settings,...request?.options,explorationStrategy:request?request.options.explorationStrategy??'radial':plugin.settings.explorationStrategy};
    this.runOptions = cloneRunOptions({...options,readingMode:request ? request.options.readingMode??'manual' : options.readingMode??'adaptive',maxBodyChars:clampOptions(options).maxBodyChars});
    this.scope.register(['Mod'], 'Enter', () => {if (!this.running) this.startButton?.click(); return false;});
  }
  private redraw(): void { if (!this.running) { this.contentEl.empty(); this.onOpen(); } }
  onOpen(): void {
    this.generation=this.plugin.beginSeedSetup();
    this.modalEl.addClass('knowledge-seed-window');
    this.contentEl.addClass('knowledge-seed-modal');
    this.setTitle('从一个起点，发现相关知识');
    this.contentEl.createEl('p', { text: '输入起点后尽快打开 Obsidian 原生图。概念和连接在后台逐步加入，正文独立补充；也可选择先预览再保存。', cls: 'knowledge-seed-subtitle' });
    const inputArea = this.contentEl.createDiv();
    new Setting(inputArea).setName('开始后直接显示关系图').setDesc('持续写入真实笔记并同步到当前起点图谱；关闭本窗口后后台继续。关闭此选项可先预览再保存。').addToggle(toggle=>toggle.setValue(this.runOptions.liveGraph).onChange(value=>{this.runOptions.liveGraph=value;refreshSummary();}));
    let kindControl: import('obsidian').DropdownComponent;
    new Setting(inputArea).setName('起点类型').addDropdown(dropdown => {kindControl = dropdown; dropdown.addOptions({ topic: '知识主题', url: '网页地址', note: '库内笔记' }).setValue(this.seed.kind).onChange(value => { this.seed.kind = value as Seed['kind'];this.autoDetectedUrl=false; });});
    new Setting(inputArea).setName('知识起点').addTextArea(input => {
      input.inputEl.setAttribute('aria-label', '知识起点');
      input.setValue(this.seed.value).setPlaceholder('例如：预测编码；也可直接粘贴 https://…').onChange(value => {
        this.seed.value = value;
        const isUrl=/^https?:\/\//i.test(value.trim());
        if(this.seed.kind==='topic'&&isUrl){this.seed.kind='url';this.autoDetectedUrl=true;kindControl.setValue('url');}
        else if(this.seed.kind==='url'&&this.autoDetectedUrl&&!isUrl){this.seed.kind='topic';this.autoDetectedUrl=false;kindControl.setValue('topic');}
      });
    }).addButton(button => button.setButtonText('选择笔记').onClick(() => new NotePicker(this.app, file => {
      this.seed = {kind:'note', value:file.path};this.autoDetectedUrl=false; this.redraw();
    }).open()));
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === 'md' && this.seed.kind !== 'note') new Setting(inputArea).setName('从当前笔记出发').addButton(button => button.setButtonText(active.basename).onClick(() => { this.seed = { kind: 'note', value: active.path }; this.redraw(); }));
    readingPaceControl(inputArea,this.runOptions,()=>refreshSummary());
    keywordControl(inputArea,this.runOptions,'searchTerms',()=>refreshSummary());
    const strategyControls=inputArea.createDiv();renderExplorationStrategyControls(strategyControls,this.runOptions,()=>refreshSummary());
    const summary = inputArea.createEl('p', {cls:'knowledge-seed-summary'});
    const refreshSummary = () => {
      strategyControls.hidden=!this.runOptions.liveGraph;
      if(this.runOptions.liveGraph){summary.setText(`先显示起点和已发现概念，正文独立补充。${explorationStrategyDescription(this.runOptions)}`);return;}
      if(this.runOptions.readingMode==='adaptive')summary.setText(this.runOptions.web
        ? `${paceDescriptions[this.runOptions.readingPace??'balanced']} 可以随时查看当前结果，再补充感兴趣的概念。`
        : '先读取相关已有笔记，保留提及概念；关闭公开网页后不会联网补充正文。');
      else {const chosen=presets.find(preset=>preset.id===this.preset); summary.setText(`${chosen ? chosen.description + ' ' : ''}本次探索 ${this.runOptions.depth} 层；${this.runOptions.web ? `最多读取 ${this.runOptions.maxPages} 个网页（含失败）` : '仅本地'}、${this.runOptions.maxNotes} 篇相关笔记、${this.runOptions.maxConcepts} 个概念。`);}
    };
    refreshSummary();
    const controls = inputArea.createEl('details', { cls: 'knowledge-seed-options' });
    controls.createEl('summary', { text: '高级选项（范围、语言和手动限制）' });
    new Setting(controls).setName('读取方式').setDesc('自适应按阅读节奏优先获取正文；手动模式使用下面的数量与深度限制。').addDropdown(dropdown=>dropdown.addOptions({adaptive:'自适应读取',manual:'手动限制'}).setValue(this.runOptions.readingMode??'adaptive').onChange(value=>{this.runOptions.readingMode=value as Options['readingMode'];refreshSummary();}));
    new Setting(controls).setName('探索预设').setDesc('手动模式的本次范围预设；保留补充词与排除词。').addDropdown(dropdown => {
      dropdown.addOption('custom','当前参数'); for (const preset of presets) dropdown.addOption(preset.id, preset.label);
      dropdown.setValue(this.preset).onChange(value => {if (value !== 'custom') this.runOptions = applyPreset(this.runOptions, value as PresetId); this.preset = value; this.redraw();});
    }).addButton(button => button.setButtonText('恢复默认参数').onClick(() => {this.runOptions = cloneRunOptions(this.plugin.settings); this.preset='custom'; this.redraw();}));
    discoveryControls(controls, this.runOptions, () => {this.preset='custom'; refreshSummary();},false);
    this.contentEl.createEl('p', { text: '本版按真实链接与关键词发现知识，不使用模型。笔记正文不上传；公开检索会发送起点或概念名称、来源标题和补充检索词。', cls: 'knowledge-seed-note' });
    const progressEl = this.contentEl.createEl('p', { cls: 'knowledge-seed-progress', attr: { role: 'status', 'aria-live': 'polite' } });
    if(this.startupError)progressEl.setText(`${this.startupError} 参数已保留，修正后可以再次开始。`);
    const liveResults=this.contentEl.createDiv({cls:'knowledge-seed-live-results'});
    let finishRequested=false;
    let lastSnapshot:KnowledgeGraph|undefined;
    const hasCurrentBody=()=>Boolean(lastSnapshot?.nodes.some(hasPreviewBody));
    let resultButton: import('obsidian').ButtonComponent;
    new Setting(this.contentEl.createDiv({cls:'knowledge-seed-actions'})).addButton(button => {this.startButton = button.buttonEl; button.setButtonText('开始发现').setTooltip('Ctrl / Cmd + Enter').setCta().onClick(async () => {
      if (this.running) return;
      const invalid = Array.from(inputArea.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input:invalid, textarea:invalid'))
        .find(input=>this.runOptions.liveGraph||!strategyControls.contains(input));
      if (invalid) { controls.open = true; invalid.focus(); invalid.reportValidity(); progressEl.setText('请先修正标出的参数。'); return; }
      const errors = validateDiscovery(this.seed, this.runOptions);
      if (this.seed.kind === 'note') {const file=this.app.vault.getAbstractFileByPath(this.seed.value.trim()); if (!(file instanceof TFile) || file.extension !== 'md') errors.push('请选择仍存在的 Markdown 笔记。');}
      if (errors.length) { progressEl.setText(errors.join(' ')); return; }
      if(this.runOptions.liveGraph) {
        // Only the setup dialog closes. The new background session owns its own
        // controller; Escape after launch cannot abort a different foreground job.
        const generation=this.generation;
        this.keepController=true;this.running=false;this.close();
        try{await this.plugin.startLive({...this.seed},this.runOptions);}catch(error){
          if(error instanceof Cancelled||(error instanceof Error&&error.name==='AbortError')||!this.plugin.canRestoreSeedSetup(generation))return;
          const message=friendlyError(error);new Notice(message);
          const retry=new SeedModal(this.app,this.plugin,this.seed);
          retry.runOptions=cloneRunOptions(this.runOptions);retry.preset=this.preset;retry.autoDetectedUrl=this.autoDetectedUrl;
          retry.startupError=message;retry.open();
        }
        return;
      }
      this.running = true; this.keepController = false; finishRequested=false;lastSnapshot=undefined; inputArea.inert = true; button.setDisabled(true);resultButton.setDisabled(true);liveResults.empty();
      const started = Date.now(); let stage = '准备发现…';
      const showProgress = () => progressEl.setText(`${finishRequested?'正在整理已读取内容…':stage} · 已用 ${Math.floor((Date.now()-started)/1000)} 秒`);
      showProgress(); this.timer = setInterval(showProgress,1000);
      try {
        const graph = await this.plugin.discover(this.seed, text => {if(this.keepController)return;stage = text; showProgress();}, this.runOptions,{
          shouldFinish:()=>finishRequested,
          onSnapshot:graph=>{
            if(this.keepController || this.plugin.activeController?.signal.aborted)return;
            lastSnapshot=graph;
            const reading=graph.nodes.find(node=>node.reading?.state==='reading');
            if(reading)stage=`正在读取：${reading.title}`;
            liveResults.empty();
            const readable=graph.nodes.filter(node=>node.kind!=='seed'&&hasPreviewBody(node));
            const pending=graph.nodes.filter(node=>node.kind==='concept'&&!hasPreviewBody(node)&&node.reading?.state!=='excluded');
            if(readable.length || pending.length){
              liveResults.createEl('p',{text:`已获取 ${readable.length} 项正文 · ${pending.length} 个概念待补充`,cls:'knowledge-seed-note'});
              for(const node of [...readable,...pending].slice(0,8)){
                const row=liveResults.createDiv({cls:'knowledge-seed-live-node'});
                row.createEl('strong',{text:node.title});row.createEl('span',{text:readingLabel(node),cls:'knowledge-seed-badge'});
                if(node.article)renderArticlePreview(row,node.article);
                else if(node.excerpt)row.createEl('p',{text:node.excerpt.slice(0,180)});
              }
            }
            resultButton.setDisabled(!readable.length||finishRequested);showProgress();
          }
        });
        if (this.keepController) return;
        this.running = false;
        this.close(); new PreviewModal(this.app, this.plugin, graph).open();
      } catch (e) {
        if (!(e instanceof Cancelled) && !(e instanceof Error && e.name === 'AbortError')) { progressEl.setText(`${friendlyError(e)}${hasCurrentBody()?' 已读取内容仍可查看，也可以重新探索。':''}`); new Notice(friendlyError(e)); }
        else {lastSnapshot=undefined;progressEl.setText('已取消，尚未写入文件。');}
      } finally { clearInterval(this.timer); this.timer=undefined; this.running = false; inputArea.inert = false; button.setDisabled(false);resultButton.setDisabled(!hasCurrentBody()); }
    });}).addButton(button=>{resultButton=button;button.setButtonText('查看当前结果').setDisabled(true).onClick(()=>{
      if(!this.running){if(lastSnapshot?.nodes.some(hasPreviewBody)){this.close();new PreviewModal(this.app,this.plugin,lastSnapshot).open();}return;}
      if(finishRequested)return;finishRequested=true;button.setDisabled(true);progressEl.setText('正在整理已读取内容，显示当前结果…');
    });}).addButton(button => button.setButtonText('取消读取').onClick(() => {this.plugin.activeController?.abort();})).addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
  }
  onClose(): void {
    clearInterval(this.timer); this.timer=undefined;
    if (this.running) { this.keepController = true; this.plugin.activeController?.abort(); }
    this.contentEl.empty();
  }
}

class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app:App, private chosen:(file:TFile)=>void) {super(app); this.setPlaceholder('搜索笔记名称或文件夹…');}
  getItems():TFile[] {return this.app.vault.getMarkdownFiles();}
  getItemText(file:TFile):string {return file.path;}
  onChooseItem(file:TFile):void {this.chosen(file);}
}

class BackgroundReadingModal extends Modal {
  private closed = false;
  private unsubscribe?: () => void;
  private filter = 'all';
  private expandedJobs=new Set<string>();
  constructor(app: App, private plugin: KnowledgeSeedPlugin) {super(app);}
  onOpen(): void {
    this.closed=false;
    this.modalEl.addClass('knowledge-seed-window');this.contentEl.addClass('knowledge-seed-modal');
    this.setTitle('后台正文任务');
    this.contentEl.createEl('p',{text:'点开生成的空概念后，后台补充正文并保留原节点。任务记录最多保留 50 项；重启中断的任务可重新打开概念或重试。',cls:'knowledge-seed-subtitle'});
    const toolbar=this.contentEl.createDiv({cls:'knowledge-seed-toolbar'});
    const counts=this.contentEl.createEl('p',{attr:{role:'status','aria-live':'polite'}});
    const list=this.contentEl.createDiv({cls:'knowledge-seed-node-list'});
    const labels: Record<string,string>={queued:'等待中',reading:'正在读正文',ready:'正文已补充',failed:'读取失败',no_match:'未确认来源',interrupted:'重启中断',skipped:'无需补充',cancelled:'已取消'};
    let pauseButton: HTMLButtonElement;
    const show=()=>{
      if(this.closed)return;
      pauseButton?.setText(this.plugin.backgroundPaused?'继续后台阅读':'暂停后台阅读');
      const jobs=[...(this.plugin.backgroundReader?.jobs??[])].sort((a,b)=>b.updated-a.updated);
      const active=jobs.filter(job=>['queued','reading'].includes(job.state)).length;
      const issues=jobs.filter(job=>['failed','no_match','interrupted'].includes(job.state)).length;
      counts.setText(`${this.plugin.backgroundPaused?'后台已暂停 · ':''}${active} 项待处理 · ${issues} 项需重试或确认来源 · 共 ${jobs.length} 项记录`);
      const scroll=list.scrollTop;
      for(const detail of list.querySelectorAll('details')){
        const id=detail.closest('[data-job-id]')?.getAttribute('data-job-id');
        if(id){if(detail.open)this.expandedJobs.add(id);else this.expandedJobs.delete(id);}
      }
      const known=new Set(jobs.map(job=>job.id));
      this.expandedJobs=new Set([...this.expandedJobs].filter(id=>known.has(id)));
      list.empty();
      const visible=jobs.filter(job=>this.filter==='all'||this.filter==='active'&&['queued','reading'].includes(job.state)
        ||this.filter==='issues'&&['failed','no_match','interrupted'].includes(job.state)||this.filter==='ready'&&job.state==='ready');
      if(!visible.length)list.createEl('p',{text:jobs.length?'当前筛选没有任务。':'还没有后台任务。打开图谱中的生成空概念即可开始；也可用“补充当前概念正文（后台）”命令。',cls:'knowledge-seed-empty'});
      for(const job of visible){
        const row=list.createDiv({cls:'knowledge-seed-background-task knowledge-seed-preview-node',attr:{'data-job-id':job.id,'data-state':job.state}});
        const title=row.createDiv();title.createEl('strong',{text:job.title});title.createSpan({text:labels[job.state]??job.state,cls:'knowledge-seed-badge'});
        row.createEl('p',{text:job.path,cls:'knowledge-seed-background-path'});
        row.createEl('small',{text:`更新于 ${new Date(job.updated).toLocaleString()} · 已尝试 ${job.attempt} 次`});
        const status=row.createEl('p',{attr:{role:'status'}});
        const report=(error:unknown)=>{if(this.closed)return;status.setText(friendlyError(error));new Notice(friendlyError(error));};
        new Setting(row).addButton(button=>button.setButtonText('打开概念').onClick(async()=>{
          try{const file=this.app.vault.getAbstractFileByPath(job.path);if(!(file instanceof TFile))throw new Error('概念笔记已移动或删除，请在库中重新打开节点。');
            await this.plugin.openNoteFile(file);if(!this.closed)this.close();
          }catch(error){report(error);}
        }).buttonEl.setAttribute('aria-label',`打开概念 ${job.title}`))
          .addButton(button=>button.setButtonText('重试').setDisabled(['queued','reading','ready'].includes(job.state)).onClick(async()=>{
            button.setDisabled(true);
            try{await this.plugin.retryBackgroundJob(job.id);}catch(error){report(error);}
            finally{if(!this.closed)button.setDisabled(false);}
          }).buttonEl.setAttribute('aria-label',`重试 ${job.title}`))
          .addButton(button=>button.setButtonText('取消').setDisabled(!['queued','reading'].includes(job.state)).onClick(()=>this.plugin.backgroundReader?.cancel(job.id))
            .buttonEl.setAttribute('aria-label',`取消 ${job.title}`));
        if(job.reason){
          const details=row.createEl('details');details.createEl('summary',{text:'查看读取结果与原因'});
          let shown=false;
          const showReason=()=>{if(shown)return;shown=true;details.createEl('p',{text:job.reason!,cls:'knowledge-seed-task-reason'});};
          details.open=this.expandedJobs.has(job.id);if(details.open)showReason();
          details.addEventListener('toggle',()=>{
            if(this.closed||!this.contentEl.contains(row))return;
            if(details.open){this.expandedJobs.add(job.id);showReason();}else this.expandedJobs.delete(job.id);
          });
        }
        if(job.auditFolder){
          const auditPath=`${job.auditFolder}/Recovery.md`;
          row.createEl('button',{text:'查看保存与恢复记录'}).addEventListener('click',()=>{
            const file=this.app.vault.getAbstractFileByPath(auditPath);
            if(!(file instanceof TFile)){report(new Error('保存记录已移动或删除。'));return;}
            void this.plugin.openNoteFile(file).then(()=>{if(!this.closed)this.close();}).catch(report);
          });
        }
      }
      list.scrollTop=scroll;
    };
    new Setting(toolbar).setName('任务状态').addDropdown(dropdown=>dropdown.addOptions({all:'全部任务',active:'待处理',issues:'需要重试或确认',ready:'正文已补充'})
      .setValue(this.filter).onChange(value=>{this.filter=value;show();}).selectEl.setAttribute('aria-label','后台任务状态'))
      .addButton(button=>{pauseButton=button.buttonEl;button.setButtonText(this.plugin.backgroundPaused?'继续后台阅读':'暂停后台阅读')
        .onClick(async()=>{try{await this.plugin.toggleBackgroundPause();if(!this.closed)show();}catch(error){if(!this.closed)new Notice(friendlyError(error));}});})
      .addButton(button=>button.setButtonText('取消并暂停后台阅读').onClick(async()=>{
        try{await this.plugin.cancelBackgroundTasks();if(!this.closed)show();}catch(error){if(!this.closed)new Notice(friendlyError(error));}
      }));
    this.contentEl.createEl('p',{text:'暂停与取消会停止后续读取和写入；已经保存的正文会保留。重试会重新核对当前笔记、来源和节点归属。',cls:'knowledge-seed-note'});
    this.unsubscribe=this.plugin.backgroundReader?.subscribe(show);show();
  }
  onClose(): void {this.closed=true;this.unsubscribe?.();this.unsubscribe=undefined;this.contentEl.empty();}
}

class HistoryModal extends Modal {
  constructor(app:App, private plugin:KnowledgeSeedPlugin) {super(app);}
  onOpen():void {
    this.modalEl.addClass('knowledge-seed-window');
    this.setTitle('探索历史'); this.contentEl.addClass('knowledge-seed-modal');
    this.contentEl.createEl('p',{text:'保留最近 20 次成功保存的探索。打开图谱不联网；重新探索会先显示原参数供你调整。',cls:'knowledge-seed-subtitle'});
    const list=this.contentEl.createDiv({cls:'knowledge-seed-node-list'});
    if (!this.plugin.history.length) list.createEl('p',{text:'还没有本版探索记录。以前的图谱可通过“打开上次原生知识图谱”查看。',cls:'knowledge-seed-empty'});
    for (const record of this.plugin.history) {
      const row=list.createDiv({cls:'knowledge-seed-preview-node'});
      row.createEl('strong',{text:record.title});
      row.createEl('p',{text:`${new Date(record.createdAt).toLocaleString()} · ${record.nodes} 个节点、${record.relations} 条关系`});
      const status=row.createEl('p',{attr:{role:'status'}});
      new Setting(row).addButton(button=>button.setButtonText('打开原生图谱').onClick(async()=>{
        try {await this.plugin.openNativeGraph(record.run); this.close();} catch(e){status.setText(friendlyError(e));}
      })).addButton(button=>button.setButtonText('按原参数重新探索').setDisabled(!record.request).onClick(()=>{
        this.close(); this.plugin.openSeed(undefined,record.request);
      })).addButton(button=>button.setButtonText('查看运行概览').onClick(async()=>{
        const file=this.app.vault.getAbstractFileByPath(`${record.run.folder}/Overview.md`);
        if (!(file instanceof TFile)) {status.setText('运行概览已移动或删除。');return;}
        try {await this.app.workspace.getLeaf('tab').openFile(file); this.close();} catch(e){status.setText(friendlyError(e));}
      }));
    }
  }
  onClose():void {this.contentEl.empty();}
}

class DuplicateMergeModal extends Modal {
  private applying = false;
  private closed = false;
  constructor(app: App, private plugin: KnowledgeSeedPlugin) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('knowledge-seed-window'); this.contentEl.addClass('knowledge-seed-modal');
    this.setTitle('合并重复概念与正文节点');
    this.contentEl.createEl('p',{text:'保留网页正文节点，将同一证据支持的概念笔记内容、属性和关系合入其中。重定向实际内部链接，原概念移入本次备份目录并改为 .bak；所有受影响笔记先备份。这里只列出有历史证据的明确配对，同名本身不会触发合并。'});
    const status = this.contentEl.createEl('p',{text:'检查生成笔记与历史证据…',attr:{role:'status'}});
    void this.plugin.duplicateMergePlan().then(candidates=>{
      if(this.closed) return;
      status.setText(`找到 ${candidates.length} 对可合并节点。核对保留路径后选择需要合并的项目。`);
      const selected = new Set(candidates.map(candidate=>candidate.from));
      const list = this.contentEl.createDiv({cls:'knowledge-seed-node-list'});
      for(const candidate of candidates) new Setting(list).setName(candidate.title).setDesc(`${candidate.from} → ${candidate.to}；${candidate.reason}`)
        .addToggle(toggle=>toggle.setValue(true).onChange(value=>{if(value) selected.add(candidate.from); else selected.delete(candidate.from);}));
      new Setting(this.contentEl).addButton(button=>button.setButtonText('合并选中节点并保留备份').setCta().setDisabled(!candidates.length).onClick(async()=>{
        const chosen = candidates.filter(candidate=>selected.has(candidate.from));
        if(!chosen.length){status.setText('请先选择要合并的节点。');return;}
        this.applying=true;button.setDisabled(true);status.setText('正在备份、合并正文和重定向链接…');
        try{await this.plugin.applyDuplicateMerge(chosen);this.applying=false;this.close();}
        catch(error){status.setText(`${friendlyError(error)}${error instanceof MergeTransactionError ? `。备份和进度记录：${error.folder}` : ''}。请关闭后重新预览完成合并，或按日志恢复备份，再继续普通探索。`);}
        finally{this.applying=false;}
      })).addButton(button=>button.setButtonText('取消').onClick(()=>this.close()));
    }).catch(error=>status.setText(friendlyError(error)));
  }
  close():void{if(!this.applying)super.close();}
  onClose():void{this.closed=true;this.contentEl.empty();}
}

class NameCleanupModal extends Modal {
  applying = false;
  private closed = false;
  constructor(app: App, private plugin: KnowledgeSeedPlugin) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('knowledge-seed-window');
    this.setTitle('整理旧生成节点名称'); this.contentEl.addClass('knowledge-seed-modal');
    this.contentEl.createEl('p', { text: '只整理当前输出目录内、带插件所有权标记且名称含旧编号或百科后缀的生成笔记。保留正文，通过 Obsidian 改名并更新链接。请先启用“文件与链接 → 始终更新内部链接”。' });
    const status = this.contentEl.createEl('p', { text: '检查名称…', attr: { role: 'status' } });
    void this.plugin.nameCleanupPlan().then(changes => {
      if (this.closed) return;
      status.setText(`找到 ${changes.length} 个可整理名称。同名文件使用 (2)、(3) 区分。`);
      const list = this.contentEl.createDiv({ cls: 'knowledge-seed-node-list' });
      for (const change of changes) list.createEl('p', { text: `${change.from} → ${change.to}`, cls: 'knowledge-seed-name-change' });
      new Setting(this.contentEl).addButton(button => button.setButtonText('整理这些生成节点').setCta().setDisabled(!changes.length).onClick(async () => {
        this.applying = true; button.setDisabled(true); status.setText('正在改名及更新链接…');
        try { await this.plugin.applyNameCleanup(changes); this.applying = false; this.close(); }
        catch (error) { status.setText(`整理未全部完成：${friendlyError(error)}。已完成的改名保留，记录位于输出目录。`); }
        finally { this.applying = false; button.setDisabled(false); }
      })).addButton(button => button.setButtonText('取消').onClick(() => this.close()));
    }).catch(error => status.setText(friendlyError(error)));
  }
  close(): void { if (!this.applying) super.close(); }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

type NumericOption = 'maxPages' | 'depth' | 'maxNotes' | 'maxConcepts' | 'scanLimit' | 'searchLimit' | 'linkLimit' | 'maxBodyChars' | 'maxNoteChars' | 'graphDepth';
const numericOptions: Array<{ key: NumericOption; title: string; min: number; max: number; desc: string }> = [
  { key: 'depth', title: '探索深度', min: 0, max: 20, desc: '0 只读取起点和检索候选；更大数值沿正文链接及笔记内部链接继续探索。' },
  { key: 'maxPages', title: '网页读取上限', min: 0, max: 500, desc: '含失败尝试。与深度共同控制任务总量。' },
  { key: 'maxNotes', title: '相关已有笔记上限', min: 0, max: 500, desc: '含沿内部链接读取的笔记。' },
  { key: 'maxConcepts', title: '新概念上限', min: 0, max: 1000, desc: '只保留有正文提及证据的候选概念。' },
  { key: 'graphDepth', title: '原生图显示深度', min: 0, max: 5, desc: '控制保存后局部关系图显示几跳（Obsidian 核心支持 0–5），不会增加网络请求。探索深度可单独设到 20。' },
  { key: 'searchLimit', title: '每次检索候选数', min: 0, max: 100, desc: '先按标题及摘要相关性排序；0 可关闭百科候选检索，仅沿提供的网页扩展。' },
  { key: 'linkLimit', title: '每页扩展链接数', min: 0, max: 100, desc: '控制每一层的扩展宽度。链接先筛选再排序。' },
  { key: 'scanLimit', title: '候选笔记扫描上限', min: 1, max: 50000, desc: '更大的笔记库可提高此值；扫描进度与截断会记录。' },
  { key: 'maxBodyChars', title: '每网页正文字符数', min: 2000, max: 200000, desc: '正文保留预算至少 2000 字，按完整段落截断；原文不足时保留全部，不补写内容。每次任务最多保留 400 万正文字符，HTML 响应仍限制为 2 MB。' },
  { key: 'maxNoteChars', title: '每笔记分析字符数', min: 80, max: 200000, desc: '超过部分不参与匹配，明确记录截断。' },
];
const paceDescriptions = {fast:'尽快找到核心资料，优先呈现可读正文。',balanced:'兼顾速度与关联内容，逐步补齐重要概念。',deep:'投入更多时间，沿上下文继续读取和补充概念。'};
function readingPaceControl(container:HTMLElement,settings:Settings,changed:()=>Promise<void>|void=()=>{}):void {
  new Setting(container).setName('阅读节奏').setDesc('先得到可读内容；不够时可以继续补充。').addDropdown(dropdown=>dropdown.addOptions({fast:'快速了解',balanced:'均衡探索',deep:'深入阅读'}).setValue(settings.readingPace??'balanced').onChange(async value=>{settings.readingPace=value as Options['readingPace'];await changed();}));
}
function keywordControl(container:HTMLElement,settings:Settings,key:'searchTerms'|'excludeTerms',changed:()=>Promise<void>|void=()=>{}):void {
  const option=key==='searchTerms'
    ? {key,title:'探索方向与补充词',label:'补充检索词',limit:20,desc:'告诉插件想读哪方面。每行一个领域词、完整名称、英文名或同义词，例如：PCA → 统计学、降维。'}
    : {key,title:'排除关键词',label:'排除关键词',limit:100,desc:'每行一个词。自动候选名称包含它时跳过，指定起点保留。'};
  new Setting(container).setName(option.title).setDesc(`${option.desc} 最多 ${option.limit} 条，每条 180 字符。`).addTextArea(text=>{
    const errorEl=text.inputEl.parentElement!.createEl('small',{cls:'knowledge-seed-error',attr:{'aria-live':'polite'}});
    text.inputEl.setAttribute('aria-label',option.label);
    text.setValue(settings[key].join('\n')).onChange(async value=>{
      const lines=[...new Set(value.split('\n').map(line=>line.trim()).filter(Boolean))];
      const error=lines.length>option.limit ? `最多 ${option.limit} 条，请删除多余词项。` : lines.some(line=>line.length>180) ? '每条词项最多 180 字符。' : '';
      text.inputEl.setCustomValidity(error);text.inputEl.setAttribute('aria-invalid',String(Boolean(error)));errorEl.setText(error);
      if(error)return;settings[key]=lines;await changed();
    });
  });
}
function readingLabel(node:import('./graph').GraphNode):string {
  if(node.reading?.state==='excluded')return '已排除';
  if(node.reading?.state==='reading')return '正在读取';
  if(hasPreviewBody(node))return '正文可读';
  if(node.kind==='web'&&node.status==='retrieved')return '仅有摘录，待补正文';
  return ({pending:'待补正文',failed:'读取失败，可重试',no_match:'尚未匹配来源',excluded:'已排除',ready:'正文可读'} as const)[node.reading?.state??'pending'];
}
function appendArticleText(container:HTMLElement,text:string,formulas?:string[]):void {
  for(const segment of articleTextSegments(text,formulas)){
    if(segment.math){try{container.appendChild(renderMath(segment.text,false));continue;}catch{/* Preserve original text when math rendering is unavailable. */}}
    container.createEl('span',{text:segment.text});
  }
}
function renderArticlePreview(container:HTMLElement,article:ArticleContent,nodeId?:string):void {
  const details=container.createEl('details',{cls:'knowledge-seed-article-preview'});
  if(nodeId)details.setAttribute('data-reading-node',nodeId);
  details.createEl('summary',{text:'阅读全文'});
  let populated=false;
  const populate=()=>{
    if(populated)return;populated=true;
    const body=details.createDiv({cls:'knowledge-seed-article-body'});
    const search=details.createDiv({cls:'knowledge-seed-article-search'});details.insertBefore(search,body);
    const status=search.createEl('small',{text:'在已读取原文中查找；不改变保存内容。',attr:{role:'status','aria-live':'polite'}});
    let matches:number[]=[],current=0;
    const focusMatch=()=>{
      body.querySelectorAll('.knowledge-seed-active-match').forEach(node=>node.classList.remove('knowledge-seed-active-match'));
      const matched=body.querySelector<HTMLElement>(`[data-article-block="${matches[current]}"]`);
      matched?.classList.add('knowledge-seed-active-match');matched?.scrollIntoView?.({block:'nearest'});
      status.setText(matches.length?`匹配 ${matches.length} 个段落或章节 · 第 ${current+1} 处`:'未找到匹配内容，试试英文名或更短的关键词。');
    };
    let previous:import('obsidian').ButtonComponent,next:import('obsidian').ButtonComponent;
    new Setting(search).addText(input=>{
      input.inputEl.setAttribute('aria-label','在原文中查找');
      const find=(value:string)=>{
        body.querySelectorAll('.knowledge-seed-search-match').forEach(node=>node.classList.remove('knowledge-seed-search-match'));
        matches=articleSearchMatches(article,value);current=0;
        matches.forEach(index=>body.querySelector(`[data-article-block="${index}"]`)?.classList.add('knowledge-seed-search-match'));
        previous.setDisabled(!matches.length);next.setDisabled(!matches.length);
        if(value.trim())focusMatch();else {body.querySelectorAll('.knowledge-seed-active-match').forEach(node=>node.classList.remove('knowledge-seed-active-match'));status.setText('在已读取原文中查找；不改变保存内容。');}
      };
      input.setPlaceholder('查找原文关键词…').onChange(find);
      (details as HTMLDetailsElement & {restoreReadingQuery?:(query:string)=>void}).restoreReadingQuery=query=>{input.setValue(query);find(query);};
    }).addButton(button=>{previous=button;button.setButtonText('上一处').setDisabled(true).onClick(()=>{current=(current-1+matches.length)%matches.length;focusMatch();});})
      .addButton(button=>{next=button;button.setButtonText('下一处').setDisabled(true).onClick(()=>{current=(current+1)%matches.length;focusMatch();});});
    const headings=article.blocks.flatMap((block,index)=>block.type==='heading'?[{index,text:block.text}]:[]);
    if(headings.length){
      const toc=details.createEl('details',{cls:'knowledge-seed-article-toc'});details.insertBefore(toc,body);
      toc.createEl('summary',{text:'章节目录'});
      const nav=toc.createEl('nav',{attr:{'aria-label':'原文章节'}});
      for(const heading of headings){const button=nav.createEl('button',{text:heading.text,attr:{type:'button'}});button.addEventListener('click',()=>body.querySelector<HTMLElement>(`[data-article-block="${heading.index}"]`)?.scrollIntoView?.({block:'start'}));}
    }
    for(const [index,block] of article.blocks.entries()){
      let element:HTMLElement;
      if(block.type==='heading')element=body.createEl(block.level<=2?'h3':'h4',{text:block.text});
      else if(block.type==='list'){element=body.createEl(block.ordered?'ol':'ul');for(const item of block.items)appendArticleText(element.createEl('li'),item,article.formulas);}
      else if(block.type==='table'){element=body.createEl('table');for(const cells of block.rows){const row=element.createEl('tr');for(const text of cells)appendArticleText(row.createEl('td'),text,article.formulas);}}
      else {element=body.createEl(block.type==='code'?'pre':block.type==='quote'?'blockquote':'p');if(block.type==='code')element.setText(block.text);else appendArticleText(element,block.text,article.formulas);}
      element.setAttribute('data-article-block',String(index));
    }
    if(article.formulas?.length)void finishRenderMath().catch(()=>{/* Formula source remains available if native styling fails. */});
  };
  details.addEventListener('toggle',()=>{if(details.open)populate();});
  // A restored reading view needs its body immediately, before the next toggle.
  (details as HTMLDetailsElement & {populateReading?:()=>void}).populateReading=populate;
}
function discoveryControls(container: HTMLElement, settings: Settings, changed: () => Promise<void> | void = () => {}, includeSearchTerms=true): void {
  new Setting(container).setName('检索公开网页').setDesc('笔记正文不上传；公开检索会发送起点或概念名称、来源标题和补充检索词。关闭后仅在库内探索。').addToggle(toggle => toggle.setValue(settings.web).onChange(async value => { settings.web = value; await changed(); }));
  new Setting(container).setName('主要百科语言').addDropdown(dropdown => dropdown.addOptions({ zh: '中文', en: 'English' }).setValue(settings.wikiLanguage).onChange(async value => { settings.wikiLanguage = value as 'zh' | 'en'; await changed(); }));
  new Setting(container).setName('检索语言范围').setDesc('中英文检索仍受网页读取总上限约束；补充对应的另一语言术语可提高命中质量。').addDropdown(dropdown => dropdown.addOptions({ primary: '主要语言', both: '中英文' }).setValue(settings.searchLanguageMode).onChange(async value => { settings.searchLanguageMode = value as Options['searchLanguageMode']; await changed(); }));
  new Setting(container).setName('相关性筛选').setDesc('聚焦减少旁支；平衡兼顾主题与拓展；广泛保留更多正文链接。任何模式都会排除导航与站点杂项。').addDropdown(dropdown => dropdown.addOptions({ strict: '聚焦', balanced: '平衡', broad: '广泛' }).setValue(settings.relevance).onChange(async value => { settings.relevance = value as Options['relevance']; await changed(); }));
  for (const option of numericOptions) new Setting(container).setName(option.title).setDesc(`${option.desc} 可输入 ${option.min}–${option.max}。`).addText(text => {
    text.inputEl.type = 'number'; text.inputEl.min = String(option.min); text.inputEl.max = String(option.max); text.inputEl.step = '1';
    text.inputEl.setAttribute('aria-label', option.title);
    const errorEl = text.inputEl.parentElement!.createEl('small',{cls:'knowledge-seed-error',attr:{'aria-live':'polite'}});
    text.setValue(String(settings[option.key])).onChange(async value => {
      const result=validateNumericInput(option.key,value);
      text.inputEl.setCustomValidity(result.error ?? ''); text.inputEl.setAttribute('aria-invalid',String(Boolean(result.error))); errorEl.setText(result.error ?? '');
      if (result.value === undefined) return;
      settings[option.key] = result.value; await changed();
    });
  });
  if(includeSearchTerms)keywordControl(container,settings,'searchTerms',changed);
  keywordControl(container,settings,'excludeTerms',changed);
}

class PreviewModal extends Modal {
  selected: Set<string>; saving = false;
  private query = ''; private kind: import('./graph').NodeKind|'all' = 'all'; private maxDepth?: number;
  private reading:PreviewReadingFilter='all'; private sort:PreviewSort='reading';
  private page = 0; private searchTimer?: ReturnType<typeof setTimeout>;
  private completing=false; private finishRequested=false; private closed=false; private completionStatus='';
  private completionTimer?:ReturnType<typeof setInterval>;
  constructor(app: App, private plugin: KnowledgeSeedPlugin, private graph: KnowledgeGraph) { super(app); this.selected = defaultPreviewSelection(graph); }
  private acceptSnapshot(next:KnowledgeGraph):void {
    this.selected=inheritPreviewSelection(this.graph,next,this.selected);this.graph=next;
  }
  private redrawReading():void {
    if(this.closed)return;
    const modalScroll=this.contentEl.scrollTop,listScroll=this.contentEl.querySelector('.knowledge-seed-node-list')?.scrollTop??0;
    const focused=this.contentEl.ownerDocument.activeElement as HTMLInputElement|null;
    const focusRecord=focused&&this.contentEl.contains(focused)?{label:focused.getAttribute('aria-label'),node:focused.closest('[data-reading-node]')?.getAttribute('data-reading-node'),start:focused.selectionStart,end:focused.selectionEnd}:undefined;
    const opened=[...this.contentEl.querySelectorAll<HTMLDetailsElement>('.knowledge-seed-article-preview')].filter(details=>details.open)
      .map(details=>({id:details.getAttribute('data-reading-node'),scroll:details.querySelector('.knowledge-seed-article-body')?.scrollTop??0,query:details.querySelector<HTMLInputElement>('[aria-label="在原文中查找"]')?.value??''}));
    clearTimeout(this.searchTimer);this.contentEl.empty();this.onOpen();this.contentEl.scrollTop=modalScroll;
    const list=this.contentEl.querySelector('.knowledge-seed-node-list');if(list)list.scrollTop=listScroll;
    for(const record of opened){
      const details=[...this.contentEl.querySelectorAll<HTMLDetailsElement>('.knowledge-seed-article-preview')].find(details=>details.getAttribute('data-reading-node')===record.id);
      if(!details)continue;details.open=true;(details as HTMLDetailsElement & {populateReading?:()=>void}).populateReading?.();
      (details as HTMLDetailsElement & {restoreReadingQuery?:(query:string)=>void}).restoreReadingQuery?.(record.query);
      const body=details.querySelector('.knowledge-seed-article-body');if(body)body.scrollTop=record.scroll;
    }
    if(focusRecord?.label){
      const target=[...this.contentEl.querySelectorAll<HTMLInputElement>('[aria-label]')].find(input=>input.getAttribute('aria-label')===focusRecord.label&&(!focusRecord.node||input.closest('[data-reading-node]')?.getAttribute('data-reading-node')===focusRecord.node));
      target?.focus();if(target?.type==='text'&&typeof focusRecord.start==='number')target.setSelectionRange?.(focusRecord.start,focusRecord.end??focusRecord.start);
    }
  }
  private async complete(targetIds?:string[]):Promise<void> {
    if(this.completing||this.saving||this.closed)return;
    if(!(this.graph.request?.options.web??this.plugin.settings.web))return;
    this.completing=true;this.finishRequested=false;this.completionStatus='正在补充正文…';this.redrawReading();
    const started=Date.now();let stage='正在补充正文…';
    const show=()=>{if(this.closed)return;this.completionStatus=`${this.finishRequested?'正在整理已读取内容…':stage} · 已用 ${Math.floor((Date.now()-started)/1000)} 秒`;
      this.contentEl.querySelector<HTMLElement>('.knowledge-seed-completion-status')?.setText(this.completionStatus);};
    this.completionTimer=setInterval(show,1000);
    try {
      const next=await this.plugin.complete(this.graph,text=>{if(this.closed)return;stage=text;show();},{targetIds,
        shouldFinish:()=>this.finishRequested,
        onSnapshot:next=>{if(this.closed||this.plugin.activeController?.signal.aborted)return;this.acceptSnapshot(next);this.redrawReading();show();}});
      if(this.closed)return;
      this.acceptSnapshot(next);this.completionStatus=this.finishRequested?'已保留当前正文，可以继续补充或保存。':'正文补充完成；未读概念保留提及证据，可以再试。';
    } catch(error){
      if(this.closed)return;
      this.completionStatus=error instanceof Cancelled || error instanceof Error&&error.name==='AbortError' ? '已取消补充，尚未写入文件。' : friendlyError(error);
      if(!(error instanceof Cancelled)&&!(error instanceof Error&&error.name==='AbortError'))new Notice(friendlyError(error));
    } finally {clearInterval(this.completionTimer);this.completionTimer=undefined;this.completing=false;this.redrawReading();}
  }
  onOpen(): void {
    this.modalEl.addClass('knowledge-seed-window');
    this.contentEl.addClass('knowledge-seed-modal'); this.setTitle('预览知识地图');
    this.contentEl.createEl('p', { text: `${this.graph.nodes.length} 个候选、${this.graph.edges.length} 条关系。搜索和类型筛选仅改变列表显示；保存以勾选及保留的来源为准。` });
    const readableSelection=readablePreviewSelection(this.graph);
    const unreadCount=this.graph.nodes.filter(node=>node.kind==='concept'&&node.reading?.state!=='excluded'&&!readableSelection.has(node.id)).length;
    const canComplete=this.graph.request?.options.web??this.plugin.settings.web;
    this.contentEl.createEl('p',{cls:'knowledge-seed-note',text:`默认保留来源和有提及证据的概念。${unreadCount ? `${unreadCount} 个概念待补正文，仍可保存并连接到已有图谱；点击“补充正文”优先读取感兴趣的节点。` : '可以展开全文核对内容，再保存到原生图谱。'}`});
    if(unreadCount&&!canComplete)this.contentEl.createEl('p',{cls:'knowledge-seed-note',text:'本次仅在库内探索。需要网络正文时，请开启公开网页后重新探索；现有概念和证据仍可保存。'});
    const counts=previewReadingSummary(this.graph);
    const quality=this.contentEl.createDiv({cls:'knowledge-seed-content-summary',attr:{'aria-label':'内容状态'}});
    quality.createEl('strong',{text:`${counts.readable} 项正文可读`});quality.createEl('span',{text:`${counts.pending} 项待补正文`});
    if(counts.issues)quality.createEl('span',{text:`${counts.issues} 项需要重试或确认来源`,cls:'knowledge-seed-content-issue'});
    const statistics = this.contentEl.createEl('p', { cls: 'knowledge-seed-save-summary',attr:{role:'status','aria-live':'polite'} });
    const toolbar=this.contentEl.createDiv({cls:'knowledge-seed-toolbar'});
    const filter=()=>({query:this.query,kind:this.kind,maxDepth:this.maxDepth,reading:this.reading,sort:this.sort});
    new Setting(toolbar).setName('筛选候选').addText(input=>{input.inputEl.setAttribute('aria-label','搜索候选');input.setValue(this.query).setPlaceholder('搜索名称、摘要、来源…').onChange(value=>{
      this.query=value; this.page=0; clearTimeout(this.searchTimer); this.searchTimer=setTimeout(render,150);
    });}).addDropdown(dropdown=>dropdown.addOptions({all:'全部类型',seed:'起点',web:'网页',note:'已有笔记',concept:'概念'}).setValue(this.kind).onChange(value=>{this.kind=value as typeof this.kind; this.page=0; render();}))
      .addDropdown(dropdown=>{dropdown.addOption('all','全部层级'); for(const depth of [...new Set(this.graph.nodes.map(node=>node.depth))].sort((a,b)=>a-b)) dropdown.addOption(String(depth),`≤ ${depth} 层`);
        if(this.maxDepth!==undefined&&this.graph.nodes.some(node=>node.depth===this.maxDepth))dropdown.setValue(String(this.maxDepth));
        dropdown.onChange(value=>{this.maxDepth=value==='all'?undefined:Number(value); this.page=0; render();});});
    new Setting(toolbar).setName('内容与排序').addDropdown(dropdown=>{
      dropdown.selectEl.setAttribute('aria-label','按内容状态筛选');
      dropdown.addOptions({all:'全部内容状态',readable:'正文可读',pending:'待补正文',issues:'失败或未匹配',excluded:'已排除'}).setValue(this.reading).onChange(value=>{this.reading=value as PreviewReadingFilter;this.page=0;render();});
    }).addDropdown(dropdown=>{
      dropdown.selectEl.setAttribute('aria-label','候选排序');
      dropdown.addOptions({reading:'可读正文优先',discovery:'发现顺序',depth:'从浅到深',title:'按名称'}).setValue(this.sort).onChange(value=>{this.sort=value as PreviewSort;this.page=0;render();});
    }).addButton(button=>button.setButtonText('清除筛选').onClick(()=>{this.query='';this.kind='all';this.maxDepth=undefined;this.reading='all';this.page=0;this.redrawReading();}));
    new Setting(toolbar).addButton(button=>button.setButtonText('选择筛选结果').onClick(()=>{this.selected=selectVisibleNodes(this.graph,this.selected,filter(),true); render();}))
      .addButton(button=>button.setButtonText('取消筛选结果').onClick(()=>{this.selected=selectVisibleNodes(this.graph,this.selected,filter(),false); render();}))
      .addButton(button=>button.setButtonText('只选有正文的来源').onClick(()=>{this.selected=readablePreviewSelection(this.graph); render();}))
      .addButton(button=>button.setButtonText('保留全部概念').onClick(()=>{this.selected=defaultPreviewSelection(this.graph);render();}));
    if (this.graph.warnings.length) {
      const details = this.contentEl.createEl('details', { cls: 'knowledge-seed-warnings' });
      details.createEl('summary', { text: `${this.graph.warnings.length} 项读取范围或问题` });
      const list = details.createEl('ul'); this.graph.warnings.forEach(w => list.createEl('li', { text: w }));
    }
    const list = this.contentEl.createDiv({ cls: 'knowledge-seed-node-list' });
    const pagination=this.contentEl.createDiv({cls:'knowledge-seed-pagination'});
    let saveButton: import('obsidian').ButtonComponent;
    let selectedCompletionButton:import('obsidian').ButtonComponent;
    const refresh = () => {
      const result=previewSelectionSummary(this.graph,this.selected);
      statistics.setText(`将保存 ${result.nodeCount} 个节点、${result.edgeCount} 条关系。${result.droppedSelectedCount ? ` ${result.droppedSelectedCount} 个已勾选概念因来源未保留，无法保存。` : ''}${!result.graph.nodes.some(node=>node.status==='retrieved') ? ' 请至少保留一个已成功读取的来源。' : ''}`);
      statistics.createEl('small',{text:` 新建 ${result.newCount} 项内容，复用 ${result.reusedCount} 篇已有笔记；${result.pendingCount} 个概念将保留证据并标为待补。`});
      saveButton?.setDisabled(this.saving || this.completing || !result.graph.nodes.some(node=>node.status==='retrieved'));
      selectedCompletionButton?.setDisabled(this.saving||this.completing||!canComplete||!selectedCompletionTargets(this.graph,this.selected).length);
    };
    const render=()=>{
      list.empty(); pagination.empty(); refresh();
      const candidates=filterPreviewNodes(this.graph,filter()), pageSize=25;
      this.page=Math.max(0,Math.min(this.page,Math.max(0,Math.ceil(candidates.length/pageSize)-1)));
      if(!candidates.length) list.createEl('p',{text:'没有匹配的候选。清空搜索或更换筛选条件；其他候选的勾选保持不变。',cls:'knowledge-seed-empty'});
      for (const node of candidates.slice(this.page*pageSize,(this.page+1)*pageSize)) {
      const row = list.createDiv({ cls: 'knowledge-seed-preview-node' });
      row.setAttribute('data-node-id',node.id);row.setAttribute('data-reading-state',previewReadingState(node));
      const heading = row.createDiv();
      const checkbox = heading.createEl('input', { type: 'checkbox', attr: { 'aria-label': `保留 ${node.title}` } });
      checkbox.checked = this.selected.has(node.id); checkbox.disabled = node.kind === 'seed'||node.reading?.state==='excluded';
      checkbox.addEventListener('change', () => { if (checkbox.checked) this.selected.add(node.id); else this.selected.delete(node.id); refresh(); });
      heading.createEl('span', { text: kindLabels[node.kind], cls: `knowledge-seed-badge knowledge-seed-${node.kind}` });
      heading.createEl('strong', { text: node.title });
      heading.createEl('small',{text:`第 ${node.depth} 层`});
      if(node.kind!=='seed')heading.createEl('span',{text:readingLabel(node),cls:'knowledge-seed-badge'});
      row.createEl('p', { text: node.excerpt.slice(0, 180) });
      if (node.article) {
        const bodyChars = articleBodyTextChars(node.article);
        const bodyTarget = Math.max(2000, this.graph.request?.options.maxBodyChars ?? this.plugin.settings.maxBodyChars);
        const range = node.article.truncated ? '已按完整段落或结构块结束截断；保存后可查看保留范围。'
          : bodyChars < 2000 ? '原文不足 2000 字，已完整保留。' : '保存时保留全部已提取正文。';
        const boundary = bodyChars > bodyTarget ? `为保留完整段落，正文超过 ${bodyTarget.toLocaleString()} 字符目标，保留到当前段落或结构块结束。` : '';
        row.createEl('p', { cls: 'knowledge-seed-note', text: this.graph.request?.options.readingMode==='adaptive'
          ? `${node.article.blocks.filter(block=>block.type==='heading').length} 个章节。${node.article.truncated?'正文保留到完整段落结束；下方可查看当前内容。':'已保留原文，展开下方即可阅读。'}`
          : `详细正文 ${bodyChars.toLocaleString()} 字符，${node.article.blocks.filter(block => block.type === 'heading').length} 个章节。${range}${boundary}上方仅为预览摘录。` });
        renderArticlePreview(row,node.article,node.id);
      } else if (node.kind === 'concept') {
        const message = node.locator?.endsWith('.md') && node.bodyAvailable !== false
          ? node.bodyAvailable ? '复用已有笔记正文，保留原文件内容。' : '复用已有笔记；本次未重新读取正文，保留原文件内容。'
          : `保留提及证据，${node.reading?.reason??'正文待补充；发现名称不代表没有相关内容。'}`;
        row.createEl('p', { cls: 'knowledge-seed-note', text: message });
        if(!node.bodyAvailable)new Setting(row).addButton(button=>button.setButtonText('补充正文').setTooltip(canComplete?`优先读取 ${node.title}`:'请开启公开网页后重新探索').setDisabled(this.completing||this.saving||!canComplete).onClick(()=>this.complete([node.id])));
      }
      if (node.locator) row.createEl('small', { text: node.locator });
      const evidence=row.createEl('details'); evidence.createEl('summary',{text:'查看此节点的关系与来源证据'}); let populated=false;
      evidence.addEventListener('toggle',()=>{if(!evidence.open || populated)return; populated=true;
        const entries=nodeEvidence(this.graph,node.id); if(!entries.length)evidence.createEl('p',{text:'此节点没有单独的关系证据。'});
        for(const entry of entries){const item=evidence.createDiv({cls:'knowledge-seed-evidence'});item.createEl('strong',{text:`${entry.fromTitle} → ${relationLabels[entry.relation]} → ${entry.toTitle}`});item.createEl('p',{text:entry.quote});item.createEl('small',{text:`${entry.sourceTitle} · ${entry.method}`});}
      });
      if(node.locator && /^https?:\/\//i.test(node.locator)) {
        try {row.createEl('a',{text:'打开原网页',href:publicUrl(node.locator),attr:{target:'_blank',rel:'noopener noreferrer'}});} catch {/* Do not offer an unsafe external address. */}
      }
      }
      new Setting(pagination).setName(`${candidates.length} 个匹配候选 · 第 ${this.page+1} / ${Math.max(1,Math.ceil(candidates.length/pageSize))} 页`)
        .addButton(button=>button.setButtonText('上一页').setDisabled(this.page===0).onClick(()=>{this.page--;render();list.scrollTop=0;}))
        .addButton(button=>button.setButtonText('下一页').setDisabled((this.page+1)*pageSize>=candidates.length).onClick(()=>{this.page++;render();list.scrollTop=0;}));
    };
    const status = this.contentEl.createEl('p', {text:this.completionStatus,cls:'knowledge-seed-completion-status', attr: { role: 'status','aria-live':'polite' } });
    new Setting(this.contentEl.createDiv({cls:'knowledge-seed-actions'})).addButton(button => {saveButton=button; button.setButtonText('保存并打开原生关系图').setCta().onClick(async () => {
      if (this.saving||this.completing) return;
      this.saving = true; button.setDisabled(true); toolbar.inert=true;list.inert=true;pagination.inert=true; status.setText('正在保存…');
      try { const filtered = previewSelectionSummary(this.graph, this.selected).graph; await this.plugin.persist(filtered); this.saving = false; this.close(); }
      catch (e) { status.setText(friendlyError(e)); new Notice(friendlyError(e)); }
      finally { this.saving = false; toolbar.inert=false;list.inert=false;pagination.inert=false;refresh(); }
    });}).addButton(button=>{selectedCompletionButton=button;button.setButtonText('补全已选概念').setTooltip('只读取已勾选且没有正文的概念；筛选不会改变读取范围。').setDisabled(this.completing||!canComplete||!selectedCompletionTargets(this.graph,this.selected).length).onClick(()=>this.complete(selectedCompletionTargets(this.graph,this.selected)));})
      .addButton(button=>button.setButtonText('继续探索全部候选').setTooltip('继续读取所有候选，包括尚未勾选的概念。').setDisabled(this.completing||!unreadCount||!canComplete).onClick(()=>this.complete()))
      .addButton(button=>button.setButtonText('停止补充，保留已读').setDisabled(!this.completing||this.finishRequested).onClick(()=>{
        this.finishRequested=true;button.setDisabled(true);status.setText('正在整理已读取内容，保留当前结果…');
      })).addButton(button => button.setButtonText('放弃本次结果').onClick(() => { if (!this.saving) this.close(); }));
    render();
  }
  close(): void { if (!this.saving) super.close(); }
  onClose(): void {this.closed=true;clearTimeout(this.searchTimer);clearInterval(this.completionTimer);if(this.completing)this.plugin.activeController?.abort();this.contentEl.empty(); }
}

class KnowledgeSeedSettings extends PluginSettingTab {
  constructor(app: App, private plugin: KnowledgeSeedPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl('h2', { text: 'Knowledge Seed · 发现范围' });
    new Setting(containerEl).setName('输出目录').setDesc('节点保存为普通 Markdown 笔记；重复发现复用节点，每次保留独立证据记录。').addText(text => {
      text.inputEl.setAttribute('aria-label','输出目录');
      const error=text.inputEl.parentElement!.createEl('small',{cls:'knowledge-seed-error',attr:{'aria-live':'polite'}});
      text.setValue(this.plugin.settings.outputFolder).onChange(async value=>{
        let folder:string;try{folder=safeFolder(value);}catch(e){error.setText(friendlyError(e));text.inputEl.setAttribute('aria-invalid','true');return;}
        error.setText('');text.inputEl.setAttribute('aria-invalid','false');this.plugin.settings.outputFolder=folder;
        try{await this.plugin.saveSettings();}catch(e){error.setText(`设置未保存：${friendlyError(e)}`);}
      });
    });
    new Setting(containerEl).setName('同时导出 Canvas').setDesc('可选辅助视图；默认使用 Obsidian 自带局部关系图。').addToggle(toggle => toggle.setValue(this.plugin.settings.exportCanvas).onChange(async value => { this.plugin.settings.exportCanvas = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('开始后直接显示关系图').setDesc('默认先打开原生图，再在后台增加概念与正文。关闭可保留先预览再保存的流程。').addToggle(toggle=>toggle.setValue(this.plugin.settings.liveGraph).onChange(async value=>{this.plugin.settings.liveGraph=value;await this.plugin.saveSettings();}));
    new Setting(containerEl).setName('我的知识图谱').setDesc('按起点找回图谱和保存进度，无需重新搜索。').addButton(button=>button.setButtonText('打开图谱列表').onClick(()=>this.plugin.openGraphLibrary()));
    new Setting(containerEl).setName('后台补充概念正文').setDesc('动态探索中的空概念自动排队，点开的空概念也会检查；保留原节点和双链。公开检索发送概念名称和补充检索词。').addToggle(toggle => toggle.setValue(this.plugin.settings.backgroundReading).onChange(async value => {
      this.plugin.settings.backgroundReading = value;
      if (!value) this.plugin.backgroundReader?.cancelAll();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName('后台正文任务').setDesc('查看读取进度和失败原因，暂停、取消或重新尝试。').addButton(button=>button.setButtonText('查看任务').onClick(()=>this.plugin.openBackgroundTasks()));
    readingPaceControl(containerEl,this.plugin.settings,()=>this.plugin.saveSettings());
    keywordControl(containerEl,this.plugin.settings,'searchTerms',()=>this.plugin.saveSettings());
    containerEl.createEl('h3',{text:'实时图谱的探索策略'});
    renderExplorationStrategyControls(containerEl,this.plugin.settings,()=>this.plugin.saveSettings());
    const advanced=containerEl.createEl('details',{cls:'knowledge-seed-options'});advanced.createEl('summary',{text:'高级选项（范围、语言和手动限制）'});
    new Setting(advanced).setName('读取方式').setDesc('自适应优先读取相关正文。手动模式按数量和深度限制。').addDropdown(dropdown=>dropdown.addOptions({adaptive:'自适应读取',manual:'手动限制'}).setValue(this.plugin.settings.readingMode??'adaptive').onChange(async value=>{this.plugin.settings.readingMode=value as Options['readingMode'];await this.plugin.saveSettings();}));
    discoveryControls(advanced, this.plugin.settings, () => this.plugin.saveSettings(),false);
    new Setting(containerEl).setName('整理旧生成节点名称').setDesc('预览并移除旧文件名中的百科后缀和内部编号。只整理带所有权标识的生成节点。').addButton(button => button.setButtonText('预览名称整理').onClick(() => new NameCleanupModal(this.app, this.plugin).open()));
    new Setting(containerEl).setName('合并重复节点').setDesc('同一证据支持的概念与正文节点合为一个，保留内容并重定向内部链接。执行前完整备份。').addButton(button=>button.setButtonText('预览去重合并').onClick(()=>new DuplicateMergeModal(this.app,this.plugin).open()));
    new Setting(containerEl).setName('排除的笔记文件夹').setDesc('每行一个库内路径；普通检索跳过输出目录，从生成笔记出发可沿双链扩展。').addTextArea(text => text.setValue(this.plugin.settings.excludeFolders.join('\n')).onChange(async value => { this.plugin.settings.excludeFolders = value.split('\n').map(s => s.trim().replace(/\\/g, '/').replace(/\/$/, '')).filter(Boolean); await this.plugin.saveSettings(); }));
    containerEl.createEl('p', { text: '本版无需模型配置。关系来自原始文本与已有链接；语义定义、因果关系和全网研究仍需后续核验与扩展。', cls: 'knowledge-seed-note' });
  }
}
