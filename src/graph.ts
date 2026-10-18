import { isNoiseLabel } from './titles';
import type { DiscoveryConfig } from './workflow';
import type { ArticleContent } from './article';
export type NodeKind = 'seed' | 'web' | 'note' | 'concept';
export const NO_RETRIEVED_SOURCE_WARNING = '尚未读取到可核验的来源正文；已有概念与候选来源仍保留。';
export type Relation = 'seed_source' | 'links_to' | 'mentions' | 'search_match' | 'keyword_match' | 'wiki_link';
export interface NodeReading {
  state: 'pending' | 'reading' | 'ready' | 'failed' | 'no_match' | 'excluded';
  reason?: string;
}
export interface GraphNode {
  id: string; kind: NodeKind; title: string; excerpt: string;
  locator?: string; managedId?: string; retrievedAt?: string; status: 'retrieved' | 'discovered' | 'derived';
  depth: number; truncated?: boolean;
  sourceTitle?: string;
  article?: ArticleContent;
  /** Existing vault content is readable; false identifies an unfilled generated placeholder. */
  bodyAvailable?: boolean;
  /** Explicit webpage identity of a mention, never inferred from its label. */
  entityUrl?: string;
  mergedIds?: string[];
  reading?: NodeReading;
  /** An exact public title/redirect match used to fill a previously source-less owned placeholder. */
  sourceResolution?: { term: string; queryUrl: string };
}
export interface Evidence { sourceId: string; quote: string; method: string; locator?: string }
export interface GraphEdge { id: string; from: string; to: string; relation: Relation; evidence: Evidence[] }
export interface KnowledgeGraph {
  version: 1; seed: string; createdAt: string; nodes: GraphNode[]; edges: GraphEdge[];
  warnings: string[]; stats: { pagesAttempted: number; notesScanned: number; requests: number };
  displayDepth?: number;
  request?: DiscoveryConfig;
  reading?: { mode: 'adaptive'; stopReason: 'complete' | 'time' | 'requested' | 'capacity'; elapsedMs: number };
}
export const relationLabels: Record<Relation, string> = {
  seed_source: '起点来源', links_to: '正文链接到', mentions: '正文提及',
  search_match: '检索候选', keyword_match: '关键词匹配', wiki_link: '已有双链'
};
export function stableId(value: string): string {
  let a = 2166136261, b = 5381;
  for (const ch of value) { const n = ch.codePointAt(0)!; a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function nodeId(kind: NodeKind, locator: string): string {
  const identity = kind === 'concept' ? normalizeText(locator) : locator.normalize('NFKC');
  return `${kind}-${stableId(identity)}`;
}
export function addNode(graph: KnowledgeGraph, node: GraphNode): GraphNode {
  const prior = graph.nodes.find(n => n.id === node.id);
  if (prior) { if (prior.status !== 'retrieved' && node.status === 'retrieved') Object.assign(prior, node); return prior; }
  graph.nodes.push(node); return node;
}
export function addEdge(graph: KnowledgeGraph, from: string, to: string, relation: Relation, evidence: Evidence): void {
  if (from === to) return;
  const id = stableId(`${from}|${relation}|${to}`);
  const prior = graph.edges.find(e => e.id === id);
  if (prior) { if (!prior.evidence.some(e => e.sourceId === evidence.sourceId && e.quote === evidence.quote && e.method === evidence.method && e.locator === evidence.locator)) prior.evidence.push(evidence); }
  else graph.edges.push({ id, from, to, relation, evidence: [evidence] });
}
export function normalizeText(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
export function terms(query: string): string[] {
  const result = new Set<string>();
  for (const match of normalizeText(query).matchAll(/[a-z0-9][a-z0-9+.-]{1,}|[\u3400-\u9fff]{2,}/g)) {
    const token = match[0]; result.add(token);
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 3)
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2));
  }
  return [...result].filter(x => !['the','and','for','with','from','https','http','www'].includes(x));
}
export function matchScore(query: string, title: string, text: string): number {
  const t = normalizeText(title), body = normalizeText(text);
  return terms(query).reduce((sum, term) => sum + (t.includes(term) ? 5 : body.includes(term) ? 1 : 0), 0);
}
export function excerptAt(text: string, query: string, limit = 240): string {
  const normalized = text.toLowerCase();
  const positions = terms(query).map(t => normalized.indexOf(t)).filter(i => i >= 0);
  const position = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, position - 70);
  return text.slice(start, start + limit).trim();
}
export function usefulConcept(label: string): boolean {
  return label.length >= 2 && label.length <= 65 && /[a-z\u3400-\u9fff]/i.test(label)
    && !isNoiseLabel(label)
    && !/^(home|about|contact|read more|learn more|edit|contents|references|introduction|overview|see also|外部链接|参考文献|编辑|目录|首页|简介|更多|登录|注册|来源)$/i.test(label.trim());
}
export function filterGraph(graph: KnowledgeGraph, selected: Set<string>): KnowledgeGraph {
  let nodes = graph.nodes.filter(n => n.kind === 'seed' || selected.has(n.id));
  const ids = new Set(nodes.map(n => n.id));
  let edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to))
    .map(e => ({ ...e, evidence: e.evidence.filter(x => ids.has(x.sourceId)) }))
    .filter(e => e.evidence.length > 0);
  // A derived concept needs a retained connection backed by a retained source.
  // Iterate because a removed concept can itself be another edge's evidence.
  while (true) {
    const connected = new Set(edges.flatMap(e => [e.from, e.to]));
    const unsupported = nodes.filter(n => n.kind === 'concept' && !connected.has(n.id));
    if (!unsupported.length) break;
    const remove = new Set(unsupported.map(n => n.id));
    nodes = nodes.filter(n => !remove.has(n.id));
    edges = edges.filter(e => !remove.has(e.from) && !remove.has(e.to))
      .map(e => ({ ...e, evidence: e.evidence.filter(x => !remove.has(x.sourceId)) }))
      .filter(e => e.evidence.length > 0);
  }
  return { ...graph, nodes, edges };
}
