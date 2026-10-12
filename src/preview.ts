import { filterGraph, normalizeText, type Evidence, type GraphNode, type KnowledgeGraph, type NodeKind, type Relation } from './graph';
import { articleBodyTextChars, type ArticleContent } from './article';

export type PreviewReadingFilter = 'all' | 'readable' | 'pending' | 'issues' | 'excluded';
export type PreviewSort = 'discovery' | 'reading' | 'depth' | 'title';

/** Reading a search result or a generated placeholder is not the same as having its body. */
export function hasPreviewBody(node: GraphNode): boolean {
  if (node.reading?.state === 'excluded' || node.bodyAvailable === false && !node.article) return false;
  return Boolean(node.article && articleBodyTextChars(node.article) > 0 || node.bodyAvailable && node.locator?.endsWith('.md')
    || node.kind === 'note' && node.status === 'retrieved'
    || node.kind === 'concept' && node.locator?.endsWith('.md') && node.bodyAvailable !== false);
}

export function previewReadingState(node: GraphNode): Exclude<PreviewReadingFilter, 'all'> {
  if (node.reading?.state === 'excluded') return 'excluded';
  if (hasPreviewBody(node)) return 'readable';
  if (node.reading?.state === 'failed' || node.reading?.state === 'no_match') return 'issues';
  return 'pending';
}

export function previewReadingSummary(graph: KnowledgeGraph): { readable: number; pending: number; issues: number; excluded: number } {
  const counts = { readable: 0, pending: 0, issues: 0, excluded: 0 };
  for (const node of graph.nodes) if (node.kind !== 'seed') counts[previewReadingState(node)]++;
  return counts;
}

/** Interest is the saved selection, regardless of the temporary list filter or current page. */
export function selectedCompletionTargets(graph: KnowledgeGraph, selected: ReadonlySet<string>): string[] {
  return graph.nodes.filter(node => node.kind === 'concept' && selected.has(node.id)
    && node.reading?.state !== 'excluded' && !hasPreviewBody(node)).map(node => node.id);
}

/** Full-text finding leaves the original paragraphs and structure intact. */
export function articleSearchMatches(article: ArticleContent, query: string): number[] {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return article.blocks.flatMap((block, index) => {
    const text = normalizeText(block.type === 'list' ? block.items.join(' ') : block.type === 'table' ? block.rows.flat().join(' ') : block.text);
    return words.every(word => text.includes(word)) ? [index] : [];
  });
}

/** Explicit deselection survives source upgrades and identity coalescing. */
export function inheritPreviewSelection(previous: KnowledgeGraph, next: KnowledgeGraph, selected: ReadonlySet<string>): Set<string> {
  const identities = (node: GraphNode) => [node.id, node.managedId, ...node.mergedIds ?? []].filter((id): id is string => Boolean(id));
  const choices = new Map<string, boolean>();
  for (const node of previous.nodes) for (const id of identities(node)) choices.set(id, choices.get(id) !== false && selected.has(node.id));
  const defaults = defaultPreviewSelection(next);
  return new Set(next.nodes.filter(node => {
    if (node.reading?.state === 'excluded') return false;
    if (node.kind === 'seed') return true;
    const prior = identities(node).filter(id => choices.has(id));
    return prior.length ? prior.every(id => choices.get(id)) : defaults.has(node.id);
  }).map(node => node.id));
}

export interface PreviewFilter {
  query?: string;
  kind?: NodeKind | 'all';
  minDepth?: number;
  maxDepth?: number;
  reading?: PreviewReadingFilter;
  sort?: PreviewSort;
}

/** Mentioned concepts carry evidence even before a definition has been read. */
export function defaultPreviewSelection(graph: KnowledgeGraph): Set<string> {
  return new Set(graph.nodes.filter(node => node.reading?.state !== 'excluded'
    && (node.kind === 'seed' || node.kind === 'concept' || node.status === 'retrieved')).map(node => node.id));
}

/** An explicit optional filter for readers who want only completed source content. */
export function readablePreviewSelection(graph: KnowledgeGraph): Set<string> {
  return new Set(graph.nodes.filter(node => node.reading?.state !== 'excluded' && (node.kind === 'seed' || hasPreviewBody(node)))
    .map(node => node.id));
}

/** Search display content, rather than internal identifiers that never describe knowledge. */
export function filterPreviewNodes(graph: KnowledgeGraph, filter: PreviewFilter = {}): GraphNode[] {
  const words = normalizeText(filter.query ?? '').split(' ').filter(Boolean);
  const nodes = graph.nodes.filter(node => {
    if (filter.kind && filter.kind !== 'all' && node.kind !== filter.kind) return false;
    if (Number.isFinite(filter.minDepth) && node.depth < filter.minDepth!) return false;
    if (Number.isFinite(filter.maxDepth) && node.depth > filter.maxDepth!) return false;
    if (filter.reading && filter.reading !== 'all' && (node.kind === 'seed' || previewReadingState(node) !== filter.reading)) return false;
    const content = normalizeText([node.title, node.excerpt, node.locator ?? ''].join(' '));
    return words.every(word => content.includes(word));
  });
  const order = { readable: 0, pending: 1, issues: 2, excluded: 3 };
  if (filter.sort && filter.sort !== 'discovery') nodes.sort((a, b) => {
    if (a.kind === 'seed' || b.kind === 'seed') return Number(b.kind === 'seed') - Number(a.kind === 'seed');
    if (filter.sort === 'title') return a.title.localeCompare(b.title, 'zh');
    if (filter.sort === 'depth') return a.depth - b.depth;
    return order[previewReadingState(a)] - order[previewReadingState(b)] || a.depth - b.depth;
  });
  return nodes;
}

/** Batch changes apply to the current results; choices outside those results survive. */
export function selectVisibleNodes(
  graph: KnowledgeGraph, selected: ReadonlySet<string>, filter: PreviewFilter, checked: boolean
): Set<string> {
  const next = new Set(selected);
  for (const node of filterPreviewNodes(graph, filter)) {
    if (node.kind === 'seed') continue;
    if (node.reading?.state === 'excluded') { next.delete(node.id); continue; }
    if (checked) next.add(node.id); else next.delete(node.id);
  }
  for (const node of graph.nodes) if (node.kind === 'seed') next.add(node.id);
  return next;
}

export interface PreviewSelectionSummary {
  graph: KnowledgeGraph;
  /** Existing selected nodes plus the mandatory seed, before evidence closure. */
  selectedCount: number;
  nodeCount: number;
  edgeCount: number;
  /** Checked candidates that cannot be saved after their supporting source was removed. */
  droppedSelectedCount: number;
  newCount: number;
  reusedCount: number;
  pendingCount: number;
}

/** The save preview uses precisely the same evidence closure as the exported graph. */
export function previewSelectionSummary(graph: KnowledgeGraph, selected: ReadonlySet<string>): PreviewSelectionSummary {
  const eligible = new Set(graph.nodes.filter(node => node.reading?.state !== 'excluded' && selected.has(node.id)).map(node => node.id));
  const filtered = filterGraph(graph, eligible);
  const retained = new Set(filtered.nodes.map(node => node.id));
  const chosen = graph.nodes.filter(node => node.kind === 'seed' || eligible.has(node.id));
  return {
    graph: filtered,
    selectedCount: chosen.length,
    nodeCount: filtered.nodes.length,
    edgeCount: filtered.edges.length,
    droppedSelectedCount: chosen.filter(node => !retained.has(node.id)).length,
    reusedCount: filtered.nodes.filter(node => node.kind !== 'seed' && node.locator?.endsWith('.md')).length,
    newCount: filtered.nodes.filter(node => node.kind !== 'seed' && !node.locator?.endsWith('.md')).length,
    pendingCount: filtered.nodes.filter(node => node.kind === 'concept' && !hasPreviewBody(node)).length
  };
}

export interface PreviewEvidence extends Evidence {
  sourceTitle: string;
  edgeId: string;
  relation: Relation;
  fromTitle: string;
  toTitle: string;
}

/** Evidence is grouped at its candidate, including edges for which this node is the source. */
export function nodeEvidence(graph: KnowledgeGraph, nodeId: string): PreviewEvidence[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (!nodes.has(nodeId)) return [];
  const result: PreviewEvidence[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    for (const evidence of edge.evidence) {
      if (edge.from !== nodeId && edge.to !== nodeId && evidence.sourceId !== nodeId) continue;
      const identity = JSON.stringify([edge.id, evidence.sourceId, evidence.quote, evidence.method, evidence.locator]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push({
        ...evidence, sourceTitle: nodes.get(evidence.sourceId)?.title ?? evidence.sourceId,
        edgeId: edge.id, relation: edge.relation,
        fromTitle: nodes.get(edge.from)?.title ?? edge.from,
        toTitle: nodes.get(edge.to)?.title ?? edge.to
      });
    }
  }
  return result;
}
