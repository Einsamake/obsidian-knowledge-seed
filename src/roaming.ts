import type { GraphNode, KnowledgeGraph } from './graph';

/** View state only. Never changes graph membership, evidence, or note content. */
export interface RoamingState {
  enabled: boolean;
  fog: boolean;
  radius: number;
  limit: number;
  overviewJumps: number;
  center: string;
  back: string[];
  forward: string[];
  visited: string[];
  revealed: string[];
}
export type RoamingAction =
  | { type: 'enter'; node: string }
  | { type: 'enabled' | 'fog'; value: boolean }
  | { type: 'radius' | 'limit'; value: number }
  | { type: 'back' | 'forward' | 'home' | 'reveal' };
export interface RoamingProjection {
  state: RoamingState;
  nodes: GraphNode[];
  total: number;
  nearby: number;
  frontier: { node: GraphNode; hidden: number; next: GraphNode[] }[];
}
const object = (raw: unknown): raw is Record<string, unknown> => Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

function index(graph: KnowledgeGraph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const aliases = new Map<string, string>();
  for (const node of graph.nodes) for (const id of [node.managedId, ...(node.mergedIds ?? [])])
    if (id && !nodes.has(id)) {
      const prior = aliases.get(id);
      aliases.set(id, aliases.has(id) && prior !== node.id ? '' : node.id);
    }
  const canonical = (id: unknown): string | undefined => typeof id === 'string'
    ? (nodes.has(id) ? id : aliases.get(id) || undefined) : undefined;
  const neighbors = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of graph.edges) if (nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to) {
    neighbors.get(edge.from)!.add(edge.to); neighbors.get(edge.to)!.add(edge.from);
  }
  return { nodes, canonical, neighbors, root: graph.nodes.find(node => node.kind === 'seed')?.id ?? graph.nodes[0]?.id ?? '' };
}

export function normalizeRoaming(raw: unknown, graph: KnowledgeGraph): RoamingState {
  const input = object(raw) ? raw : {}, ix = index(graph);
  const list = (value: unknown, cap: number, unique = true): string[] => {
    if (!Array.isArray(value)) return [];
    const ids = value.slice(-cap).map(ix.canonical).filter((id): id is string => Boolean(id));
    return unique ? [...new Set(ids)] : ids;
  };
  const state: RoamingState = {
    enabled: input.enabled === true, fog: input.fog !== false,
    radius: bounded(input.radius, 1, 1, 3), limit: bounded(input.limit, 40, 10, 100),
    overviewJumps: bounded(input.overviewJumps, 5, 0, 5),
    center: ix.canonical(input.center) ?? ix.root,
    back: list(input.back, 50, false), forward: list(input.forward, 50, false),
    visited: list(input.visited, 1500), revealed: list(input.revealed, 1500),
  };
  if (state.center) {
    state.visited = [...new Set([...state.visited, state.center])];
    // A visited place also shows its newly discovered immediate neighbors.
    const revealed = new Set(state.revealed);
    for (const id of state.visited) {
      revealed.add(id); for (const neighbor of ix.neighbors.get(id) ?? []) revealed.add(neighbor);
    }
    state.revealed = [...revealed].slice(0, 1500);
  }
  return state;
}

export function projectRoaming(graph: KnowledgeGraph, raw?: unknown): RoamingProjection {
  const state = normalizeRoaming(raw, graph), ix = index(graph), revealed = new Set(state.revealed);
  const queue: { id: string; distance: number }[] = state.center ? [{ id: state.center, distance: 0 }] : [];
  const seen = new Set(queue.map(item => item.id));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { id, distance } = queue[cursor];
    if (distance >= state.radius) continue;
    for (const next of ix.neighbors.get(id) ?? []) if (!seen.has(next) && (!state.fog || revealed.has(next))) {
      seen.add(next); queue.push({ id: next, distance: distance + 1 });
    }
  }
  const nodes = queue.slice(0, state.limit).map(item => ix.nodes.get(item.id)!);
  const visible = new Set(nodes.map(node => node.id));
  const frontier = nodes.map(node => {
    const hidden=[...(ix.neighbors.get(node.id) ?? [])].filter(id=>!visible.has(id));
    return {node,hidden:hidden.length,next:hidden.slice(0,3).map(id=>ix.nodes.get(id)!)};
  })
    .filter(item => item.hidden > 0);
  return { state, nodes, total: graph.nodes.length, nearby: queue.length, frontier };
}

export function moveRoaming(graph: KnowledgeGraph, raw: unknown, action: RoamingAction): RoamingState {
  let state = normalizeRoaming(raw, graph);
  const ix = index(graph);
  const enter = (id: string) => {
    if (!id || id === state.center) return;
    state.back = [...state.back, state.center].filter(Boolean).slice(-50);
    state.forward = []; state.center = id;
  };
  switch (action.type) {
    case 'enabled': state.enabled = action.value; break;
    case 'fog': state.fog = action.value; break;
    case 'radius': state.radius = bounded(action.value, state.radius, 1, 3); break;
    case 'limit': state.limit = bounded(action.value, state.limit, 10, 100); break;
    case 'enter': {
      const id = ix.canonical(action.node);
      if (!id) throw new Error('该节点已不在当前图谱中，请重新选择。');
      state.enabled = true; enter(id); break;
    }
    case 'home': enter(ix.root); break;
    case 'back': case 'forward': {
      const from = action.type === 'back' ? state.back : state.forward;
      const to = action.type === 'back' ? state.forward : state.back;
      const next = from.pop();
      if (next) { to.push(state.center); if (to.length > 50) to.shift(); state.center = next; }
      break;
    }
    case 'reveal': {
      const revealed = new Set(state.revealed);
      // Expand the currently visible frontier; moving on remains possible at radius 3.
      for (const node of projectRoaming(graph, state).nodes)
        for (const id of ix.neighbors.get(node.id) ?? []) revealed.add(id);
      state.revealed = [...revealed]; state.radius = Math.min(3, state.radius + 1); break;
    }
  }
  return normalizeRoaming(state, graph);
}

export function readRoaming(value: unknown, maps: { id: string; graph: KnowledgeGraph }[]): Map<string, RoamingState> {
  const result = new Map<string, RoamingState>();
  if (!Array.isArray(value)) return result;
  for (const item of value.slice(0, 20)) {
    if (!object(item) || typeof item.mapId !== 'string' || result.has(item.mapId)) continue;
    const map = maps.find(map => map.id === item.mapId);
    if (map) result.set(map.id, normalizeRoaming(item.state, map.graph));
  }
  return result;
}
