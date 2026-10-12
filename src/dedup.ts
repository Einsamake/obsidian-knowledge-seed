import { addEdge, nodeId, normalizeText, stableId, type KnowledgeGraph } from './graph';
import { mergeManagedLinks } from './export';
import { cleanKnowledgeTitle } from './titles';
import { publicUrl } from './web';
import { managedAliases, managedHeader } from './ownership';

export interface MergeNote { path: string; ownerId: string; title: string; kind: string; source?: string; content: string }
export interface MergeCandidate {
  from: string; to: string; fromId: string; toId: string; title: string; reason: string; fromHash: string; toHash: string;
}
const titleKey = (title: string) => normalizeText(cleanKnowledgeTitle(title));
const urlKey = (value?: string): string | undefined => { try { return value ? publicUrl(value) : undefined; } catch { return undefined; } };
const identities = (id: string, merged?: string[]) => [...new Set([id, ...(merged ?? [])].filter(item => /^[a-z0-9_-]+$/i.test(item)))];

/** Fold only mentions with a verified source identity, never same-label user files. */
export function coalesceGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const web = graph.nodes.filter(node => node.kind === 'web' && node.status === 'retrieved' && (node.article?.textChars || node.excerpt.trim()));
  const moved = new Map<string, string>();
  for (const concept of graph.nodes.filter(node => node.kind === 'concept')) {
    const identity = urlKey(concept.entityUrl);
    const targets = web.filter(node => {
      const owner = node.managedId ?? node.id;
      if (concept.entityUrl && (!identity || identity !== urlKey(node.locator))) return false;
      if (concept.managedId && concept.managedId === owner) return true;
      if (concept.locator?.endsWith('.md')) return false;
      return Boolean(identity && identity === urlKey(node.locator));
    });
    if (targets.length === 1) moved.set(concept.id, targets[0].id);
  }
  if (!moved.size) return graph;
  const nodes = graph.nodes.filter(node => !moved.has(node.id)).map(node => ({ ...node,
    ...([...moved].some(([, id]) => id === node.id) ? { mergedIds: identities(node.id, [
      ...(node.mergedIds ?? []), ...graph.nodes.filter(item => moved.get(item.id) === node.id).flatMap(item => identities(item.managedId ?? item.id, item.mergedIds))
    ]).filter(id => id !== (node.managedId ?? node.id)) } : {}) }));
  const result: KnowledgeGraph = { ...graph, nodes, edges: [], warnings: [...graph.warnings, `已将 ${moved.size} 个提及概念合并到同一来源的正文节点，保留关系与证据。`] };
  for (const edge of graph.edges) for (const evidence of edge.evidence)
    addEdge(result, moved.get(edge.from) ?? edge.from, moved.get(edge.to) ?? edge.to, edge.relation,
      { ...evidence, sourceId: moved.get(evidence.sourceId) ?? evidence.sourceId });
  return result;
}

const regularPath = (path: string) => !/^(?:\/|[a-z]:)/i.test(path) && !/[\\\x00-\x1f]/.test(path)
  && path.endsWith('.md') && path.split('/').every(part => part && !part.startsWith('.')) && !path.includes('/Runs/');
const owned = (note: MergeNote) => { try { mergeManagedLinks(note.content, note.ownerId, []); return true; } catch { return false; } };
/** A live, explicit entity URL is stronger than a label or a historical guess.
 * Require a single actual web file with a managed reading; the user still reviews
 * paths before the same backed-up merge transaction performs any changes.
 */
export function planSourceMerges(notes: MergeNote[]): MergeCandidate[] {
  const eligible=notes.filter(note=>regularPath(note.path)&&owned(note));
  const result:MergeCandidate[]=[];
  for(const from of eligible.filter(note=>note.kind==='concept')){
    const identity=urlKey(from.source);if(!identity)continue;
    const targets=eligible.filter(note=>note.kind==='web'&&urlKey(note.source)===identity
      &&note.path!==from.path&&note.content.includes(`<!-- knowledge-seed:article:${note.ownerId}:`));
    if(targets.length!==1)continue;
    const to=targets[0];
    result.push({from:from.path,to:to.path,fromId:from.ownerId,toId:to.ownerId,title:to.title,
      reason:'概念与正文笔记具有同一明确网页来源，正文目标唯一；将保留全部内容和关系',fromHash:stableId(from.content),toHash:stableId(to.content)});
  }
  return result;
}
/** Conservative legacy evidence pairing; the user reviews exact paths before applying. */
export function planLegacyMerges(graph: KnowledgeGraph, nodePaths: Record<string, string>, notes: MergeNote[]): MergeCandidate[] {
  const byPath = new Map(notes.filter(note => regularPath(note.path) && owned(note)).map(note => [note.path, note]));
  const result: MergeCandidate[] = [];
  for (const concept of graph.nodes.filter(node => node.kind === 'concept' && !node.locator?.endsWith('.md') && node.id === nodeId('concept', node.title))) {
    const from = byPath.get(nodePaths[concept.id]);
    if (!from || from.kind !== 'concept' || from.ownerId !== (concept.managedId ?? concept.id)) continue;
    const targets = graph.nodes.filter(node => node.kind === 'web' && node.status === 'retrieved' && titleKey(node.title) === titleKey(concept.title));
    if (targets.length !== 1) continue;
    const target = targets[0], to = byPath.get(nodePaths[target.id]);
    if (!to || to.kind !== 'web' || to.ownerId !== (target.managedId ?? target.id) || from.path === to.path
      || !to.content.includes(`<!-- knowledge-seed:article:${to.ownerId}:`) || !urlKey(to.source ?? target.locator)
      || (to.source && urlKey(to.source) !== urlKey(target.locator))
      || (from.source && urlKey(from.source) !== urlKey(target.locator))
      || (concept.entityUrl && urlKey(concept.entityUrl) !== urlKey(target.locator))
      || titleKey(from.title) !== titleKey(concept.title) || titleKey(to.title) !== titleKey(target.title)) continue;
    const paired = graph.edges.filter(edge => edge.to === concept.id && edge.relation === 'mentions').some(mention =>
      graph.edges.some(link => link.from === mention.from && link.to === target.id && link.relation === 'links_to'
        && mention.evidence.some(a => link.evidence.some(b => a.sourceId === b.sourceId && a.quote.trim() && a.quote === b.quote))));
    if (!paired) continue;
    result.push({ from: from.path, to: to.path, fromId: from.ownerId, toId: to.ownerId, title: target.title,
      reason: '同名概念与正文网页具有同一来源、相同原文的提及和链接证据', fromHash: stableId(from.content), toHash: stableId(to.content) });
  }
  return result;
}

function mergedHeader(content: string, extra: string[]): string {
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!header) throw new Error('合并目标的笔记属性不完整。');
  const parsed = managedHeader(content)!;
  const prior = managedAliases(parsed), fieldRange = parsed.fields.get('knowledge_seed_merged_ids');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const field = `knowledge_seed_merged_ids: ${JSON.stringify([...new Set([...prior, ...extra])])}`;
  const body = fieldRange ? header[1].slice(0,fieldRange.start) + field + header[1].slice(fieldRange.end) : header[1] + newline + field;
  return content.replace(header[0], header[0].replace(header[1], body));
}
export function mergeGeneratedAliases(content: string, ownerId: string, extra: string[]): string {
  mergeManagedLinks(content, ownerId, []);
  if (extra.some(id => !/^[a-z0-9_-]+$/i.test(id))) throw new Error('合并身份标识无效。');
  return extra.length ? mergedHeader(content, extra.filter(id => id !== ownerId)) : content;
}
/** Append the complete source body; ownership markers now belong to the retained file. */
export function mergeDuplicateContent(target: string, source: string, candidate: MergeCandidate): string {
  mergeManagedLinks(target, candidate.toId, []); mergeManagedLinks(source, candidate.fromId, []);
  if (stableId(source) !== candidate.fromHash || stableId(target) !== candidate.toHash) throw new Error('笔记在预览后发生了变化，请重新预览合并。');
  const copyMarker = `<!-- knowledge-seed:merged:${candidate.fromId}:${stableId(source)} -->`;
  const copyEnd = `<!-- /knowledge-seed:merged:${candidate.fromId} -->`;
  const sourceAliases = managedAliases(managedHeader(source)!);
  const inherited = [candidate.fromId,...sourceAliases].filter(id=>id!==candidate.toId);
  if (target.includes(copyMarker) && target.includes(copyEnd)) return mergeGeneratedAliases(target,candidate.toId,inherited);
  const sourceHeader = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!sourceHeader) throw new Error('来源属性不完整。');
  let fenceState: {character:string;length:number} | undefined;
  const body = source.slice(sourceHeader[0].length).split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fenceState) { if (marker && marker[1][0] === fenceState.character && marker[1].length >= fenceState.length && !marker[2].trim()) fenceState = undefined; return line; }
    if (marker) { fenceState = {character:marker[1][0],length:marker[1].length}; return line; }
    const trimmed = line.trim();
    return trimmed === `<!-- knowledge-seed:links:${candidate.fromId} -->` || trimmed === `<!-- /knowledge-seed:links:${candidate.fromId} -->`
      ? line.replace(`knowledge-seed:links:${candidate.fromId}`,`knowledge-seed:links:${candidate.toId}`) : line;
  }).join('');
  // A code fence preserves source metadata as inert text, including custom fields.
  const fence = '`'.repeat(Math.max(3, ...[...sourceHeader[1].matchAll(/`+/g)].map(match => match[0].length + 1)));
  const result = mergedHeader(target, inherited) + '\n\n' + copyMarker + '\n\n## 合并保留的内容与证据\n\n'
    + body + '\n\n### 原概念笔记属性（合并时保留）\n\n' + fence + 'text\n' + sourceHeader[1] + '\n' + fence + '\n\n' + copyEnd + '\n';
  mergeManagedLinks(result,candidate.toId,[]);
  return result;
}
