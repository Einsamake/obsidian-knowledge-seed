import { clampOptions, type Options, type Seed } from './engine';
import { addEdge, normalizeText, stableId, type GraphEdge, type GraphNode, type KnowledgeGraph, type Relation } from './graph';
import { safeFolder } from './export';
import { publicUrl } from './web';

export interface LiveMapRecord {
  id: string; title: string; rootPath: string; createdAt: string; updatedAt: string;
  state: 'running' | 'paused' | 'complete' | 'cancelled' | 'failed' | 'interrupted';
  graph: KnowledgeGraph; nodePaths: Record<string, string>; excludedIds: string[];
  options: Options; seed: Seed; folder: string; message?: string;
}

const states = new Set(['running', 'paused', 'complete', 'cancelled', 'failed', 'interrupted']);
const kinds = new Set(['seed', 'web', 'note', 'concept']);
const statuses = new Set(['retrieved', 'discovered', 'derived']);
const readings = new Set(['pending', 'reading', 'ready', 'failed', 'no_match', 'excluded']);
const relations = new Set(['seed_source', 'links_to', 'mentions', 'search_match', 'keyword_match', 'wiki_link']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^[a-z0-9_-]+$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number, required = false): string | undefined => {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return;
  const result = value.slice(0, max);
  return required && !result.trim() ? undefined : result;
};
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const notePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024
  && value.endsWith('.md') && !/[<>:"\\|?*\u0000-\u001f]/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && !part.startsWith('.') && !/[. ]$/.test(part));
function folder(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1024) return;
  try { return safeFolder(value); } catch { return; }
}
const identities = (node: GraphNode): string[] => [...new Set([node.id, node.managedId, ...(node.mergedIds ?? [])].filter(identity))];
function url(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try { return publicUrl(value); } catch { return; }
}

/** Persist a bounded structural graph. Article bodies remain in their actual notes. */
function structuralGraph(raw: unknown, projectLiveEvidence = false): KnowledgeGraph | undefined {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 1500
    || !Array.isArray(raw.edges) || raw.edges.length > 20000 || !date(raw.createdAt)) return;
  const seed = text(raw.seed, 2048, true); if (!seed) return;
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const item of raw.nodes) {
    if (!object(item) || !identity(item.id) || ids.has(item.id) || !kinds.has(String(item.kind))
      || !statuses.has(String(item.status)) || !integer(item.depth, 10000)) return;
    const title = text(item.title, 512, true); if (!title) return;
    if (item.managedId !== undefined && !identity(item.managedId)) return;
    if (item.mergedIds !== undefined && (!Array.isArray(item.mergedIds) || item.mergedIds.length > 1500 || !item.mergedIds.every(identity))) return;
    let locator: string | undefined;
    if (item.locator !== undefined) {
      if (notePath(item.locator)) locator = item.locator;
      else locator = url(item.locator);
      if (!locator) return;
    }
    const entityUrl = item.entityUrl !== undefined ? url(item.entityUrl) : undefined;
    if (item.entityUrl !== undefined && !entityUrl) return;
    let reading: GraphNode['reading'];
    if (item.reading !== undefined) {
      if (!object(item.reading) || !readings.has(String(item.reading.state))) return;
      reading = {state: item.reading.state as NonNullable<GraphNode['reading']>['state'], ...(text(item.reading.reason, 600) ? {reason:text(item.reading.reason, 600)} : {})};
    }
    const resolution = object(item.sourceResolution) && text(item.sourceResolution.term, 180, true) && url(item.sourceResolution.queryUrl)
      ? {term:text(item.sourceResolution.term, 180, true)!, queryUrl:url(item.sourceResolution.queryUrl)!} : undefined;
    const bodyAvailable = typeof item.bodyAvailable === 'boolean' ? item.bodyAvailable
      : object(item.article) ? true : undefined;
    nodes.push({id:item.id,kind:item.kind as GraphNode['kind'],title,excerpt:text(item.excerpt, 400) ?? '',
      status:item.status as GraphNode['status'],depth:item.depth,
      ...(item.managedId ? {managedId:item.managedId as string} : {}),
      ...(Array.isArray(item.mergedIds) ? {mergedIds:[...new Set(item.mergedIds as string[])]} : {}),
      ...(locator ? {locator} : {}), ...(entityUrl ? {entityUrl} : {}),
      ...(bodyAvailable !== undefined ? {bodyAvailable} : {}), ...(reading ? {reading} : {}),
      ...(resolution ? {sourceResolution:resolution} : {}),
      ...(typeof item.truncated === 'boolean' ? {truncated:item.truncated} : {}),
      ...(text(item.sourceTitle, 512) ? {sourceTitle:text(item.sourceTitle, 512)} : {}),
      ...(date(item.retrievedAt) ? {retrievedAt:item.retrievedAt} : {})});
    ids.add(item.id);
  }
  if (nodes.filter(node => node.kind === 'seed').length !== 1) return;
  const graph: KnowledgeGraph = {version:1,seed,createdAt:raw.createdAt,nodes,edges:[],warnings:[],
    stats:{pagesAttempted:0,notesScanned:0,requests:0}};
  const edgeIndex = new Map<string, GraphEdge>();
  for (const item of raw.edges) {
    if (!object(item) || !identity(item.from) || !identity(item.to) || !ids.has(item.from) || !ids.has(item.to)
      || !relations.has(String(item.relation)) || !Array.isArray(item.evidence)
      || (!projectLiveEvidence && item.evidence.length > 100)) return;
    // Repeated live exploration can accumulate more evidence than the persisted
    // payload permits. Project its existing bounded view without dropping the map;
    // untrusted restored records retain the strict input size limit above.
    for (const source of item.evidence.slice(0, 8)) {
      if (!object(source) || !identity(source.sourceId) || !ids.has(source.sourceId)) return;
      const quote = text(source.quote, 600), method = text(source.method, 400, true);
      if (quote === undefined || !method) return;
      const locator = text(source.locator, 4096);
      const edgeId = stableId(`${item.from}|${item.relation}|${item.to}`);
      const prior = edgeIndex.get(edgeId);
      // Keep addEdge's identity, self-link and evidence deduplication rules, but
      // limit its linear search to the one indexed candidate instead of the graph.
      const candidate = {...graph,edges:prior ? [prior] : []};
      addEdge(candidate, item.from, item.to, item.relation as Relation, {sourceId:source.sourceId,quote,method,...(locator ? {locator} : {})});
      if (!prior && candidate.edges.length) {
        const edge = candidate.edges[0];
        graph.edges.push(edge);edgeIndex.set(edge.id,edge);
      }
    }
  }
  graph.warnings = Array.isArray(raw.warnings) ? raw.warnings.slice(0, 100).map(item => text(item, 600)).filter((item):item is string => item !== undefined) : [];
  if (object(raw.stats)) for (const key of ['pagesAttempted','notesScanned','requests'] as const)
    if (integer(raw.stats[key], 10000000)) graph.stats[key] = raw.stats[key];
  if (integer(raw.displayDepth, 5)) graph.displayDepth = raw.displayDepth;
  return graph;
}

function boundedOptions(value: unknown): Options | undefined {
  if (!object(value)) return;
  // Project known options explicitly; persisted extension fields cannot introduce executable payloads.
  const keys = ['readingMode','readingPace','web','wikiLanguage','maxPages','depth','maxNotes','maxConcepts','scanLimit',
    'searchLimit','linkLimit','maxBodyChars','maxNoteChars','relevance','searchLanguageMode',
    'explorationStrategy','breadthDecay','directionDepthBoost','offDirectionDepth'] as const;
  const input: Record<string, unknown> = {};
  for (const key of keys) input[key] = value[key];
  for (const [key, limit] of [['searchTerms',20],['excludeTerms',100],['excludeFolders',Infinity]] as const) {
    const list = value[key];
    if (list !== undefined && (!Array.isArray(list) || list.length > limit || !list.every(item => text(item, 1024, true) !== undefined))) return;
    input[key] = Array.isArray(list) ? list.map(item => text(item, key === 'excludeFolders' ? 1024 : 180, true)!) : [];
  }
  if (value.generatedFolder !== undefined) {
    const generated = folder(value.generatedFolder); if (!generated) return; input.generatedFolder = generated;
  }
  if (value.directionRules !== undefined) {
    if (!Array.isArray(value.directionRules) || value.directionRules.length > 20) return;
    const seen = new Set<string>(), rules: NonNullable<Options['directionRules']> = [];
    for (const rule of value.directionRules) {
      if (!object(rule) || typeof rule.term !== 'string' || rule.term.trim().length > 180 || !text(rule.term,180,true)
        || !integer(rule.weight,10) || rule.weight < 1 || rule.depth !== undefined && !integer(rule.depth,20)) return;
      const term = rule.term.trim(), key = normalizeText(term);
      if (seen.has(key)) return; seen.add(key);
      rules.push({term,weight:rule.weight,...(rule.depth !== undefined ? {depth:rule.depth as number} : {})});
    }
    input.directionRules = rules;
  }
  return clampOptions(input as Partial<Options>);
}

function record(raw: unknown, restored: boolean): LiveMapRecord | undefined {
  if (!object(raw) || !identity(raw.id) || !states.has(String(raw.state)) || !date(raw.createdAt) || !date(raw.updatedAt)
    || !notePath(raw.rootPath) || !object(raw.nodePaths) || !Array.isArray(raw.excludedIds) || raw.excludedIds.length > 3000
    || !raw.excludedIds.every(identity) || !object(raw.seed) || !['url','topic','note'].includes(String(raw.seed.kind))) return;
  const title = text(raw.title, 512, true), targetFolder = folder(raw.folder), graph = structuralGraph(raw.graph, !restored), options = boundedOptions(raw.options);
  const seedValue = text(raw.seed.value, 2048, true);
  if (!title || !targetFolder || !graph || !options || !seedValue) return;
  if (raw.seed.kind === 'note' && !notePath(seedValue) || raw.seed.kind === 'url' && !url(seedValue)) return;
  const known = new Set(graph.nodes.flatMap(identities));
  const nodePaths: Record<string, string> = Object.create(null);
  if (Object.keys(raw.nodePaths).length > 3000) return;
  for (const [id, path] of Object.entries(raw.nodePaths)) {
    if (!identity(id) || !known.has(id) || !notePath(path)) return;
    nodePaths[id] = path;
  }
  const root = graph.nodes.find(node => node.kind === 'seed')!;
  if (nodePaths[root.id] !== raw.rootPath) return;
  const rootIds = new Set(identities(root));
  return {id:raw.id,title,rootPath:raw.rootPath,createdAt:raw.createdAt,updatedAt:raw.updatedAt,
    state:restored && (raw.state === 'running' || raw.state === 'paused') ? 'interrupted' : raw.state as LiveMapRecord['state'],
    graph,nodePaths,excludedIds:[...new Set((raw.excludedIds as string[]).filter(id => !rootIds.has(id)))],
    options,seed:{kind:raw.seed.kind as Seed['kind'],value:seedValue},folder:targetFolder,
    ...(text(raw.message, 1000) ? {message:text(raw.message, 1000)} : {})};
}

/** Untrusted saved work is a library entry, never an instruction to resume networking. */
export function readLiveMaps(value: unknown): LiveMapRecord[] {
  if (!Array.isArray(value)) return [];
  const result: LiveMapRecord[] = [], seen = new Set<string>();
  for (const raw of value.slice(0, 20)) {
    const next = record(raw, true);
    if (next && !seen.has(next.id)) {result.push(next); seen.add(next.id);}
  }
  return result;
}

export function serializeLiveMaps(value: readonly LiveMapRecord[]): LiveMapRecord[] {
  return value.slice(0, 20).flatMap(item => {
    const projected = record(item, false);
    if (projected) return [projected];
    if (item.rootPath) {
      const reason = item.graph.edges.length > 20000 ? '关系数量超过 20000 条上限' : '图谱结构或参数无效或超过可保存限制';
      throw new Error(`图谱“${text(item.title,80,true) ?? '未命名'}”无法保存：${reason}；本次设置未写入，原有图库记录保留。`);
    }
    // A newly created map has no root until its first successful checkpoint.
    return [];
  });
}

/** Caller must verify the current root file's owner on disk first. A path-based
 * note view of that same file is a reference to the root, not another entity.
 * Its transient note ID is never retained as a permanent entity alias. */
export function foldOwnedRootFileViews(graph: KnowledgeGraph, rootPath: string, ownerId: string): KnowledgeGraph {
  const root = graph.nodes.find(node => node.kind === 'seed');
  if (!root || !notePath(rootPath) || !identity(ownerId) || (root.managedId ?? root.id) !== ownerId)
    throw new Error('起点文件与当前图谱的所有权不一致，停止合并。');
  const duplicates = graph.nodes.filter(node => node !== root && (node.kind === 'note' || node.kind === 'concept') && node.locator === rootPath);
  if (!duplicates.length) return graph;
  for (const node of duplicates) {
    if (node.managedId && node.managedId !== ownerId || node.entityUrl && (!url(node.entityUrl) || url(node.entityUrl) !== url(root.entityUrl)))
      throw new Error('起点文件视图声明了不同所有权或来源，停止合并。');
  }
  const moved = new Set(duplicates.map(node => node.id));
  const result: KnowledgeGraph = {...graph,nodes:graph.nodes.filter(node => !moved.has(node.id)),edges:[]};
  for (const edge of graph.edges) for (const evidence of edge.evidence)
    addEdge(result,moved.has(edge.from)?root.id:edge.from,moved.has(edge.to)?root.id:edge.to,edge.relation,
      {...evidence,sourceId:moved.has(evidence.sourceId)?root.id:evidence.sourceId});
  return result;
}

/** A pruning mask belongs only to this map. It never changes any note or other map. */
export function visibleLiveGraph(record: LiveMapRecord): KnowledgeGraph {
  const excluded = new Set(record.excludedIds);
  const nodes = record.graph.nodes.filter(node => node.kind === 'seed' || !identities(node).some(id => excluded.has(id)));
  const retained = new Set(nodes.map(node => node.id));
  const edges = record.graph.edges.filter(edge => retained.has(edge.from) && retained.has(edge.to))
    .map(edge => ({...edge,evidence:edge.evidence.filter(item => retained.has(item.sourceId)).map(item => ({...item}))}))
    .filter(edge => edge.evidence.length > 0);
  return {...record.graph,nodes:nodes.map(node => ({...node,...(node.mergedIds ? {mergedIds:[...node.mergedIds]} : {})})),edges,warnings:[...record.graph.warnings],stats:{...record.graph.stats}};
}

export function pruneLiveMap(record: LiveMapRecord, path: string, branch: boolean): LiveMapRecord {
  if (!notePath(path)) throw new Error('要剪除的节点路径无效。');
  const graph = visibleLiveGraph(record), byId = new Map(graph.nodes.map(node => [node.id,node]));
  const targets = graph.nodes.filter(node => identities(node).some(id => record.nodePaths[id] === path));
  if (!targets.length) throw new Error('该节点不在当前图谱中。');
  if (targets.some(node => node.kind === 'seed') || path === record.rootPath) throw new Error('不能剪除图谱起点。');
  const targetIds = new Set(targets.map(node => node.id)), candidates = new Set(targetIds);
  const children = (id:string) => graph.edges.filter(edge => edge.from === id && byId.get(edge.to)!.depth > byId.get(id)!.depth).map(edge => edge.to);
  if (branch) {
    const frontier = [...targetIds];
    for (let index=0;index<frontier.length;index++) for (const child of children(frontier[index]))
      if (!candidates.has(child)) {candidates.add(child);frontier.push(child);}
    const root = graph.nodes.find(node => node.kind === 'seed')!;
    // A second parent can preserve a descendant only when its surviving edge
    // still has evidence. Recompute after each unique subtree is removed.
    let removed = new Set(targetIds);
    while (true) {
      const reachable = new Set([root.id]), remaining = [root.id];
      for (let index=0;index<remaining.length;index++) for (const edge of graph.edges.filter(edge => edge.from === remaining[index]
        && !removed.has(edge.to) && byId.get(edge.to)!.depth > byId.get(edge.from)!.depth
        && edge.evidence.some(evidence => !removed.has(evidence.sourceId)))) {
        if (!reachable.has(edge.to)) {reachable.add(edge.to);remaining.push(edge.to);}
      }
      const next = new Set([...candidates].filter(id => targetIds.has(id) || !reachable.has(id)));
      if (next.size === removed.size && [...next].every(id => removed.has(id))) {removed=next;break;}
      removed=next;
    }
    candidates.clear();for (const id of removed) candidates.add(id);
  }
  const cut = graph.nodes.filter(node => candidates.has(node.id)).flatMap(identities);
  return {...record,excludedIds:[...new Set([...record.excludedIds,...cut])],updatedAt:new Date().toISOString()};
}

/** Merge explicit identities only. Equal labels never merge separate files or sources. */
export function mergeLiveGraph(base: KnowledgeGraph, next: KnowledgeGraph, attachToId?: string): KnowledgeGraph {
  const root = base.nodes.find(node => node.kind === 'seed'), incomingRoot = next.nodes.find(node => node.kind === 'seed');
  if (!root || !incomingRoot) throw new Error('知识图谱缺少起点。');
  const attach = attachToId ? base.nodes.find(node => identities(node).includes(attachToId)) : root;
  if (!attach) throw new Error('探索分支的节点已经不在图谱中。');
  const graph: KnowledgeGraph = {...base,nodes:base.nodes.map(node => ({...node,...(node.mergedIds ? {mergedIds:[...node.mergedIds]} : {})})),edges:[],
    warnings:[...new Set([...base.warnings,...next.warnings])],stats:{...base.stats}};
  // A later source snapshot can reveal the page's human title. Update only a
  // matching main root's display label; a branch seed must never rename it.
  if(!attachToId&&incomingRoot.id===root.id) graph.nodes.find(node=>node.id===root.id)!.title=incomingRoot.title;
  const canonical = new Map<string,string>();
  for (const node of graph.nodes) for (const id of identities(node)) {
    const prior = canonical.get(id);
    if (prior && prior !== node.id) throw new Error('图谱中存在冲突的概念身份，请先审阅去重。');
    canonical.set(id,node.id);
  }
  const moved = new Map<string,string>([[incomingRoot.id,attach.id]]);
  const offset = attach.depth - incomingRoot.depth;
  for (const incoming of next.nodes.filter(node => node.id !== incomingRoot.id)) {
    const matches = new Set(identities(incoming).map(id => canonical.get(id)).filter((id):id is string => Boolean(id)));
    if (matches.size > 1) throw new Error('新探索关联了多个已有身份，请先审阅合并。');
    const existingId = [...matches][0];
    if (existingId) {
      const existing = graph.nodes.find(node => node.id === existingId)!;
      const explicitSource = (node:GraphNode) => url(node.entityUrl) ?? (node.locator && !node.locator.endsWith('.md') ? url(node.locator) : undefined);
      const oldSource = explicitSource(existing), newSource = explicitSource(incoming);
      if (oldSource && newSource && oldSource !== newSource) throw new Error('同一概念身份声明了不同网页来源，停止合并。');
      if (existing.kind !== 'seed') {
        const promoted = incoming.article || incoming.bodyAvailable === true || incoming.status === 'retrieved';
        const preservedBody = existing.article;
        const updated = promoted ? {...existing,...incoming,id:existing.id,depth:Math.min(existing.depth,incoming.depth+offset),
          ...(preservedBody && !incoming.article ? {article:preservedBody} : {})} : {...existing,depth:Math.min(existing.depth,incoming.depth+offset)};
        updated.managedId = existing.managedId ?? incoming.managedId;
        // A new discovery prefix is not a newer body revision. Keep content
        // availability and its source when the incoming node carries no body.
        if ((existing.article || existing.bodyAvailable) && !incoming.article) {
          updated.kind=existing.kind;updated.locator=existing.locator;updated.bodyAvailable=true;
          updated.status=existing.status;updated.reading=existing.reading;updated.truncated=existing.truncated;
        }
        updated.mergedIds = [...new Set([...identities(existing),...identities(incoming)])].filter(id => id !== (updated.managedId ?? updated.id));
        graph.nodes[graph.nodes.indexOf(existing)] = updated;
      }
      moved.set(incoming.id,existingId);
      for (const id of identities(incoming)) canonical.set(id,existingId);
    } else {
      if (graph.nodes.length >= 1500) throw new Error('图谱已达到可保存的节点上限。');
      const copy = {...incoming,depth:Math.max(0,incoming.depth+offset),...(incoming.mergedIds ? {mergedIds:[...incoming.mergedIds]} : {})};
      graph.nodes.push(copy);moved.set(incoming.id,copy.id);
      for (const id of identities(copy)) canonical.set(id,copy.id);
    }
  }
  for (const edge of base.edges) for (const evidence of edge.evidence) addEdge(graph,edge.from,edge.to,edge.relation,{...evidence});
  const known = new Set(graph.nodes.map(node => node.id));
  for (const edge of next.edges) for (const evidence of edge.evidence) {
    const from = moved.get(edge.from), to = moved.get(edge.to), sourceId = moved.get(evidence.sourceId);
    if (!from || !to || !sourceId || !known.has(sourceId)) throw new Error('新探索包含缺失的关系或证据来源。');
    addEdge(graph,from,to,edge.relation,{...evidence,sourceId});
  }
  // Same-root snapshots carry cumulative figures; a branch expansion has its
  // own work counters and adds them once to the original exploration.
  for (const key of ['pagesAttempted','notesScanned','requests'] as const)
    graph.stats[key] = attachToId ? base.stats[key]+next.stats[key] : Math.max(base.stats[key],next.stats[key]);
  return graph;
}
