import { relationLabels, stableId, type GraphNode, type KnowledgeGraph, type NodeReading } from './graph';
import { cleanKnowledgeTitle } from './titles';
import { articleGuide, articleOutline, articleBodyTextChars, renderArticleContent, inertMarkdownText } from './article';
import { publicUrl } from './web';
import { managedHeader, managedValue } from './ownership';

export interface OutputFile { path: string; content: string }
export interface ManagedArticle { contentKey: string; markdown: string }
export interface ManagedUpdate { path: string; ownerId: string; lines: string[]; article?: ManagedArticle; mergedIds?: string[]; sourceUrl?: string; reading?: NodeReading; assignSource?: boolean }
export interface ExportOptions { nodePaths?: Record<string, string>; existing?: Record<string, string>; canvas?: boolean; rootFileTitle?: string }
export interface ExportBundle {
  folder: string; files: OutputFile[]; rootPath: string; nodePaths: Record<string, string>;
  search: string; overviewPath: string; canvasPath?: string; updates: ManagedUpdate[];
}
export function safeName(name: string): string {
  // Generated names must be visible vault files. Keep the original knowledge
  // title in its metadata/body, but do not allocate a hidden dot-prefixed path.
  const normalized = name.normalize('NFKC').replace(/[\x00-\x1f<>:"/\\|?*\[\]#^%]/g, '-')
    .trim().replace(/^[. ]+/, '');
  // Preserve the existing 64-code-unit limit without splitting an emoji or
  // supplementary character; encoded native links require valid Unicode.
  const limit = /^[\uD800-\uDBFF]$/.test(normalized[63]??'')&&/^[\uDC00-\uDFFF]$/.test(normalized[64]??'') ? 63 : 64;
  const cleaned = normalized.slice(0, limit).replace(/[. ]+$/g, '') || 'Untitled';
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(cleaned) ? `Note-${cleaned}` : cleaned;
}
export function safeFolder(input: string): string {
  const path = input.trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part.startsWith('.') || safeName(part) !== part))
    throw new Error('输出目录必须是库内普通目录，例如 Knowledge Seed；不能含隐藏目录或路径跳转。');
  return path;
}
// Source labels, excerpts, evidence and errors share the detailed body's inert
// serialization. In particular, %% and code fences cannot hide real graph links.
export function plainMarkdown(input: string): string {
  return inertMarkdownText(input);
}
const cell = (text: string) => plainMarkdown(text).replace(/\r?\n/g, ' ');
function uriLiteral(text: string): string {
  const value = text.replace(/\r?\n/g, ' ');
  const fence = '`'.repeat((value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0) + 1);
  return `${fence} ${value} ${fence}`;
}
function evidenceQuote(text: string): string {
  // A whole URI is evidence text, not another automatic link. Ordinary quoted
  // paragraphs keep the existing serialization, including multiline structure.
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)\S+$/i.test(text.trim()) ? uriLiteral(text) : plainMarkdown(text);
}
function sourceLocator(text: string, label: string): string {
  try {
    // An explicit external target keeps adjacent Chinese punctuation out of the
    // link. Do not escape the destination as visible text (notably _ and %).
    const url = publicUrl(text).replace(/[()]/g, ch => ch === '(' ? '%28' : '%29');
    return `[${label}](${url})`;
  } catch {
    // Invalid/non-public URI text must not become a clickable automatic link.
    // A code span stays inert even when the original URI contains Markdown.
    const value = text.replace(/\r?\n/g, ' ');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(value.trim())) {
      return uriLiteral(value);
    }
    return cell(text); // Vault paths remain visible text, never new graph links.
  }
}
const scalar = (text: string) => JSON.stringify(text.replace(/\[/g, '［').replace(/\]/g, '］'));
const regexPath = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const nativeSearch = (paths: string[]) => 'path:/^(?:' + [...new Set(paths)].map(regexPath).join('|') + ')$/';
function vaultMarkdownPath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path) || /[\x00-\x1f]/.test(path)
    || !path.endsWith('.md') || path.split('/').some(part => !part || part.startsWith('.')))
    throw new Error(`无效的库内笔记路径：${path}`);
  return path;
}
export function encodedMarkdown(path: string, title?: string): string {
  vaultMarkdownPath(path);
  const target = path.split('/').map(part => encodeURIComponent(part)
    .replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return `[${plainMarkdown(title ?? path.split('/').pop()!.replace(/\.md$/, ''))}](${target})`;
}
export function nativeLink(path: string, title?: string): string {
  vaultMarkdownPath(path);
  if (/[#|^:\[\]%]/.test(path) || /[&%<>`$*_]/.test(title ?? '')) return encodedMarkdown(path, title);
  const alias = title?.replace(/[\[\]|\r\n]/g, ' ').trim();
  return `[[${path.replace(/\.md$/, '')}${alias ? '|' + alias : ''}]]`;
}
function markers(ownerId: string): { start: string; end: string } {
  if (!/^[a-z0-9_-]+$/i.test(ownerId)) throw new Error('生成笔记的所有权标识无效。');
  return { start: `<!-- knowledge-seed:links:${ownerId} -->`, end: `<!-- /knowledge-seed:links:${ownerId} -->` };
}
function ownedBy(content: string, ownerId: string): boolean {
  try {
    const header = managedHeader(content);
    return Boolean(header && managedValue(header, 'knowledge_seed_id') === ownerId);
  } catch { return false; }
}
function linkChunks(lines: string[]): string[] {
  if (lines.some(line => typeof line !== 'string' || /<!--[ \t]*\/?knowledge-seed:links/.test(line)))
    throw new Error('关系区块包含无效的控制标记。');
  return [...new Set(lines.map(line => line.trim()).filter(Boolean))];
}
/** Append new managed blocks only. Existing content and manual edits stay byte-for-byte intact. */
export function mergeManagedLinks(content: string, ownerId: string, lines: string[]): string {
  const { start, end } = markers(ownerId);
  if (!ownedBy(content, ownerId)) throw new Error('该笔记不属于此生成节点，拒绝更新已有用户笔记。');
  const blocks: string[] = [];
  let position = 0;
  while (true) {
    const a = content.indexOf(start, position), strayEnd = content.indexOf(end, position);
    if (a < 0) { if (strayEnd >= 0) throw new Error('生成关系区块标记不完整，拒绝更新。'); break; }
    if (strayEnd >= 0 && strayEnd < a) throw new Error('生成关系区块标记不完整，拒绝更新。');
    const b = content.indexOf(end, a + start.length);
    if (b < 0 || content.slice(a + start.length, b).includes(start)) throw new Error('生成关系区块标记不完整，拒绝更新。');
    blocks.push(content.slice(a + start.length, b)); position = b + end.length;
  }
  const additions = linkChunks(lines).filter(line => !blocks.some(block => block.includes(line)));
  if (!additions.length) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return content + (content.endsWith(newline + newline) ? '' : content.endsWith(newline) ? newline : newline + newline)
    + start + newline + additions.join('\n\n').replace(/\r?\n/g, newline) + newline + end + newline;
}

/** Keep source availability distinct from definitions and human-written content. */
export function mergeManagedReading(content: string, ownerId: string, reading: NodeReading): string {
  mergeManagedLinks(content, ownerId, []);
  const labels: Record<NodeReading['state'], string> = { pending: '待补正文', reading: '待补正文', ready: '正文已读取', failed: '读取失败，可重试', no_match: '未找到可确认的来源', excluded: '已排除' };
  if (!Object.hasOwn(labels, reading.state)) throw new Error('正文读取状态无效。');
  const state = reading.state === 'reading' ? 'pending' : reading.state;
  const start = `<!-- knowledge-seed:reading:${ownerId} -->`, end = `<!-- /knowledge-seed:reading:${ownerId} -->`;
  const a = content.indexOf(start), b = content.indexOf(end);
  if ((a < 0) !== (b < 0) || (a >= 0 && (b <= a || content.indexOf(start, a + start.length) >= 0 || content.indexOf(end, b + end.length) >= 0)))
    throw new Error('读取状态区块标记不完整，拒绝更新。');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const block = [start, `> [!info] ${labels[state]}`, `> ${plainMarkdown(reading.reason ?? (state === 'ready' ? '已保留来源正文，可继续阅读。' : '保留来源中的提及证据；可从此节点继续补充正文。')).replace(/\r?\n/g, '\n> ')}`, end].join('\n').replace(/\r?\n/g, newline);
  let next = a >= 0 ? content.slice(0, a) + block + content.slice(b + end.length) : content + (content.endsWith(newline) ? newline : newline + newline) + block + newline;
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/.exec(next)!;
  const fields = [...header[1].matchAll(/^reading_state:[ \t]*.*$/gm)];
  if (fields.length > 1) throw new Error('读取状态属性重复，拒绝更新。');
  const field = `reading_state: ${state}`;
  const metadata = fields.length ? header[1].replace(/^reading_state:[ \t]*.*$/m, field) : header[1] + newline + field;
  next = next.replace(header[0], header[0].replace(header[1], metadata));
  return next;
}

/** Refresh only intact plugin-owned reading blocks. Preserve edits and legacy excerpts. */
export function mergeManagedArticle(content: string, ownerId: string, article: ManagedArticle): string {
  mergeManagedLinks(content, ownerId, []); // Atomic ownership and existing relationship marker checks.
  if (!/^[a-f0-9]{16}$/.test(article.contentKey)) throw new Error('网页正文版本标识无效。');
  const normalize = (body: string) => body.replace(/\r\n/g, '\n');
  const prefix = `<!-- knowledge-seed:article:${ownerId}:`, end = `<!-- /knowledge-seed:article:${ownerId} -->`;
  const pattern = new RegExp(`<!-- knowledge-seed:article:${ownerId}:([a-f0-9]{16}):([a-f0-9]{16}) -->\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'g');
  const blocks = [...content.matchAll(pattern)];
  if (blocks.some(block => block[3].includes(prefix) || block[3].includes(end)))
    throw new Error('网页正文区块标记嵌套，拒绝更新。');
  const remainder = content.replace(pattern, '');
  if (remainder.includes(prefix) || remainder.includes(end)) throw new Error('网页正文区块标记不完整，拒绝更新。');
  const intact = blocks.filter(block => stableId(normalize(block[3])) === block[2]);
  if (intact.some(block => block[1] === article.contentKey)) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  // Imported code can contain comments; never let it forge our local control markers.
  const markdown = normalize(article.markdown).trim().replace(/<!--[ \t]*\/?knowledge-seed:/g, '&lt;!-- knowledge-seed:');
  const replacement = `${prefix}${article.contentKey}:${stableId(markdown)} -->${newline}`
    + markdown.replace(/\n/g, newline) + newline + end;
  const replaceable = intact.at(-1);
  if (replaceable) return content.slice(0, replaceable.index!) + replacement + content.slice(replaceable.index! + replaceable[0].length);
  const notice = blocks.length ? '> [!info] 保留人工编辑\n> 之前的正文区块含有修改，已完整保留；下方是本次重新获取的阅读版本。\n\n' : '';
  return content + (content.endsWith(newline + newline) ? '' : content.endsWith(newline) ? newline : newline + newline)
    + notice.replace(/\n/g, newline) + replacement + newline;
}

/** Upgrade only a URL-identified placeholder; preserve manual metadata and all old text. */
export function mergeManagedWebMetadata(content: string, ownerId: string, url: string, assignSource = false): string {
  mergeManagedLinks(content, ownerId, []);
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!header) throw new Error('生成笔记属性不完整。');
  const parsed = managedHeader(content)!;
  const field = (name: string) => managedValue(parsed,name);
  if (field('kind') !== 'concept') return content;
  const source = field('source') || undefined;
  const normalized = publicUrl(url), identity = (field('entity_url') || undefined) ?? source;
  const unassigned = assignSource && field('kind') === 'concept' && identity === undefined && source === undefined;
  if (!unassigned && (typeof identity !== 'string' || publicUrl(identity) !== normalized)) throw new Error('概念来源与新正文网址不一致，拒绝覆盖。');
  if (source !== undefined && (typeof source !== 'string' || publicUrl(source) !== normalized)) throw new Error('已有来源属性冲突，拒绝改写。');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let metadata = header[1].replace(/^kind:[ \t]*.*$/m, 'kind: web');
  if (field('status') === 'derived') metadata = metadata.replace(/^status:[ \t]*.*$/m, 'status: retrieved');
  if (source === undefined) {
    const sourceField = `source: ${JSON.stringify(normalized)}`;
    metadata = parsed.fields.has('source') ? metadata.replace(/^source:[ \t]*.*$/m, sourceField) : metadata + newline + sourceField;
  }
  return content.replace(header[0],header[0].replace(header[1],metadata));
}

export function webReading(node: GraphNode): ManagedArticle | undefined {
  if (node.kind !== 'web' || !node.article) return undefined;
  const article = node.article;
  let source = plainMarkdown(node.locator ?? '');
  if (node.locator) {
    const url = publicUrl(node.locator).replace(/[()]/g, ch => ch === '(' ? '%28' : '%29');
    source = `[打开原始网页](${url})`;
  }
  const range = article.truncated ? `保留 ${article.textChars} / ${article.totalTextChars} 个正文字符；按完整段落或结构块截断，未保留部分未参与本图分析。`
    : `保留 ${article.textChars} 个正文字符；已读取可提取的清理后正文。`;
  const markdown = `> [!info]- 来源与阅读范围\n> ${source}\n> 获取时间：${plainMarkdown(node.retrievedAt ?? '未记录')}\n`
    + (node.sourceTitle ? `> 原始标题：${plainMarkdown(node.sourceTitle)}\n` : '')
    + `> ${range}\n`
    + (!article.truncated && articleBodyTextChars(article) < 2000 ? '> 原文不足 2000 字，已完整保留可提取正文，没有补写内容。\n' : '')
    + '> 已过滤网页导航与辅助章节，图片不下载。历史关系仍需按各自证据核验。\n\n'
    + '## 导读（原文摘录）\n\n' + articleGuide(article) + '\n\n'
    + '## 目录\n\n' + articleOutline(article) + '\n\n'
    + '## 正文\n\n' + renderArticleContent(article)
    + (article.truncated ? '\n\n> [!note] 正文按段落保留\n> 已保留达到读取目标的完整段落或结构块。可提高“每网页正文字符数”后重新探索；当前目录仅包含本次保留的章节。' : '');
  // Retrieval time is intentionally excluded: the same source body is not another version.
  return { contentKey: stableId(JSON.stringify({ url: node.locator, title: node.title, sourceTitle: node.sourceTitle, article })), markdown };
}
export function exportGraph(graph: KnowledgeGraph, outputFolder: string, runId: string, options: ExportOptions = {}): ExportBundle {
  graph = { ...graph, nodes: graph.nodes.map(node => (node.kind === 'note' || node.locator?.endsWith('.md')) && !node.managedId
    ? node : { ...node, title: cleanKnowledgeTitle(node.title) }) };
  const base = safeFolder(outputFolder), folder = `${base}/Runs/${safeName(runId)}`;
  const root = graph.nodes.find(node => node.kind === 'seed');
  if (!root) throw new Error('知识地图缺少起点节点。');
  const files: OutputFile[] = [], updates: ManagedUpdate[] = [], nodePaths: Record<string, string> = {};
  const originalPaths = new Set<string>(), originalIds = new Set<string>();
  for (const node of graph.nodes) {
    if ((node.kind === 'note' || node.kind === 'concept') && node.locator?.endsWith('.md')) {
      nodePaths[node.id] = vaultMarkdownPath(node.locator); originalPaths.add(node.locator); originalIds.add(node.id);
    }
  }
  const generatedPaths = new Set<string>();
  for (const node of graph.nodes) {
    if (originalIds.has(node.id)) continue;
    const category = node.kind === 'seed' ? '起点' : node.kind === 'web' ? '网页' : '概念';
    // The entry file has a navigation role; its filename does not redefine the
    // seed entity or migrate a path retained by an earlier exploration.
    const fileTitle=node.kind==='seed'?options.rootFileTitle??node.title:node.title;
    let candidate = `${base}/${category}/${safeName(fileTitle)}.md`, counter = 2;
    while (generatedPaths.has(candidate) || originalPaths.has(candidate)) candidate = `${base}/${category}/${safeName(fileTitle)} (${counter++}).md`;
    const path = vaultMarkdownPath(options.nodePaths?.[node.id] ?? candidate);
    if (originalPaths.has(path) || generatedPaths.has(path)) throw new Error(`生成节点路径冲突，原笔记未被修改：${path}`);
    generatedPaths.add(path); nodePaths[node.id] = path;
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.evidence.some(item => !nodes.has(item.sourceId)))
      throw new Error('知识关系包含缺失节点或缺失证据来源，无法导出。');
  }
  const relationLines = (node: GraphNode): string[] => graph.edges
    .filter(edge => edge.from === node.id || edge.to === node.id)
    .filter(edge => nodePaths[edge.from] !== nodePaths[edge.to])
    .map(edge => {
      const other = nodes.get(edge.from === node.id ? edge.to : edge.from)!;
      return `- ${edge.from === node.id ? '→' : '←'} ${relationLabels[edge.relation]} ${nativeLink(nodePaths[other.id], other.title)}\n`
        + edge.evidence.map(item => {
          const source = nodes.get(item.sourceId)!;
          // External sources are bounded links; vault sources remain plain text
          // so evidence cannot introduce extra native graph edges.
          return `  - 来源：${cell(source.title)}（${sourceLocator(source.locator ?? nodePaths[source.id], '原始网页')}）；${cell(item.method)}${item.locator ? '；检索接口：' + sourceLocator(item.locator, '检索接口') : ''}\n`
            + `    > ${evidenceQuote(item.quote).replace(/\r?\n/g, '\n    > ')}`;
        }).join('\n');
    });
  for (const node of graph.nodes) {
    const path = nodePaths[node.id], ownerId = node.managedId ?? node.id, lines = relationLines(node), article = webReading(node);
    // Existing user notes are immutable. A generated concept with independently
    // verified ownership can retain its path while receiving status and links.
    const controlledConcept = node.kind === 'concept' && Boolean(node.managedId)
      && path.startsWith(base + '/') && options.existing?.[path] === node.managedId;
    if (originalIds.has(node.id) && !controlledConcept) continue;
    const reading: NodeReading | undefined = node.reading ?? (node.kind === 'concept' && (!node.locator?.endsWith('.md') || node.bodyAvailable === false)
      ? { state: 'pending', reason: '已保留来源中的提及证据，尚未读取对应正文。' } : undefined);
    markers(ownerId);
    if (Object.hasOwn(options.existing ?? {}, path)) {
      if (options.existing![path] !== ownerId) throw new Error(`已有文件不属于此生成节点，停止导出：${path}`);
      const prior = updates.find(update => update.path === path);
      if (prior) {
        if (prior.ownerId !== ownerId) throw new Error(`同一笔记存在不同所有权，停止导出：${path}`);
        if (article && prior.article && article.contentKey !== prior.article.contentKey) throw new Error(`同一笔记包含冲突的正文版本：${path}`);
        prior.lines = [...new Set([...prior.lines, ...lines])];
        prior.mergedIds = [...new Set([...(prior.mergedIds ?? []), ...(node.mergedIds ?? [])])].filter(id => id !== ownerId);
        const severity = { pending: 0, reading: 0, ready: 1, excluded: 2, no_match: 3, failed: 4 };
        if (reading && (!prior.reading || severity[reading.state] > severity[prior.reading.state])) prior.reading = reading;
        if (article) { prior.article = article; prior.sourceUrl = node.locator; prior.assignSource = Boolean(prior.assignSource || node.sourceResolution); }
      } else updates.push({ path, ownerId, lines, ...(article ? { article, sourceUrl:node.locator, ...(node.sourceResolution ? {assignSource:true} : {}) } : {}), ...(reading ? {reading} : {}), ...(node.mergedIds?.length ? { mergedIds: node.mergedIds } : {}) });
      continue;
    }
    if (!path.startsWith(base + '/')) throw new Error(`新生成笔记必须位于输出目录：${path}`);
    const metadata = ['---', `knowledge_seed_id: ${JSON.stringify(ownerId)}`, `title: ${scalar(node.title)}`,
      'tags: [knowledge-seed, unreviewed]', `kind: ${node.kind}`, `status: ${node.status}`, `created: ${JSON.stringify(graph.createdAt)}`];
    if (node.mergedIds?.length) metadata.push(`knowledge_seed_merged_ids: ${JSON.stringify(node.mergedIds)}`);
    if (node.entityUrl) metadata.push(`entity_url: ${scalar(node.entityUrl)}`);
    if (node.locator) metadata.push(`source: ${scalar(node.locator)}`);
    if (node.sourceTitle) metadata.push(`source_title: ${scalar(node.sourceTitle)}`);
    if (node.retrievedAt) metadata.push(`retrieved_at: ${JSON.stringify(node.retrievedAt)}`);
    metadata.push('---');
    let content = `${metadata.join('\n')}\n\n# ${plainMarkdown(node.title)}\n\n`;
    if(node.kind==='seed'&&options.rootFileTitle) {
      const seed=graph.request?.seed;
      content+='> [!info] 图谱入口\n> 这里保存图谱关系与探索记录；原笔记正文保留在原位置。'
        +(seed?.kind==='note'?`正文位于 ${nativeLink(vaultMarkdownPath(seed.value),node.title)}。\n\n`:'请打开图中的来源笔记阅读全文。\n\n');
    }
    if (article) content = mergeManagedArticle(content, ownerId, article);
    else {
      const excerpt = (node.kind === 'web' && node.locator ? `原始网页：${sourceLocator(node.locator, '打开原始网页')}\n\n以下为检索时的原文节选，尚未人工核验。\n\n` : '')
      + `> ${plainMarkdown(node.excerpt).replace(/\r?\n/g, '\n> ')}\n\n`
      + (node.truncated ? '> [!note] 读取范围有限\n> 仅分析部分正文；未分析的内容不在本图证据范围内。\n\n' : '');
      // A discovery snippet is useful context, but is not a fetched article or
      // manual prose. Its fingerprint lets eligibility distinguish untouched
      // generated context from an excerpt the user has edited themselves.
      content += `<!-- knowledge-seed:excerpt:${ownerId}:${stableId(excerpt.replace(/\r\n/g,'\n'))} -->\n${excerpt}\n<!-- /knowledge-seed:excerpt:${ownerId} -->\n\n`;
    }
    content += '\n## 关系与证据\n';
    if (reading) content = mergeManagedReading(content, ownerId, reading);
    files.push({ path, content: mergeManagedLinks(content, ownerId, lines) });
  }
  const overviewPath = `${folder}/Overview.md`;
  files.push({ path: `${folder}/graph.json`, content: JSON.stringify(graph, null, 2) });
  files.push({ path: overviewPath, content: `# ${plainMarkdown(root.title)} · 发现记录\n\n生成时间：${graph.createdAt}\n\n`
    + `${graph.nodes.length} 个节点，${graph.edges.length} 条关系。网页尝试 ${graph.stats.pagesAttempted} 次，扫描笔记 ${graph.stats.notesScanned} 篇，请求 ${graph.stats.requests} 次。\n\n`
    + '> [!info] 如何理解本图\n> 笔记中的内部链接构成 Obsidian 原生关系图。检索候选与关键词匹配需要确认相关性；正文提及不证明因果、包含、反驳或定义关系。\n\n'
    + '## 节点路径\n\n' + graph.nodes.map(node => `- ${cell(node.title)}：${cell(nodePaths[node.id])}`).join('\n')
    + '\n\n## 关系证据\n\n' + graph.edges.map(edge => `- ${cell(nodes.get(edge.from)!.title)} → ${relationLabels[edge.relation]} → ${cell(nodes.get(edge.to)!.title)}\n`
      + edge.evidence.map(item => `  - 来源：${cell(nodes.get(item.sourceId)!.title)}；${cell(item.method)}\n    > ${evidenceQuote(item.quote).replace(/\r?\n/g, '\n    > ')}`).join('\n')).join('\n')
    + '\n\n## 读取范围与问题\n\n' + (graph.warnings.length ? graph.warnings.map(warning => `- ${plainMarkdown(warning)}`).join('\n') : '- 本次没有读取错误。')
    + '\n\n已有笔记保持原内容；再次发现复用生成节点，保留人工编辑并安全补充正文与关系。\n'
    + (updates.length ? '\n## 保存与恢复\n\n本次要更新的生成笔记会先完成全文预检并保存原文 .bak。run-status.json 记录实际保存进度；Recovery.md 说明如何核对备份。只有 COMPLETE.json 存在且状态为 complete 时，本次探索才算完整保存。\n' : '') });
  let canvasPath: string | undefined;
  if (options.canvas) {
    const indices = { seed: 0, source: 0, concept: 0 };
    const canvasNodes = graph.nodes.map(node => {
      const column = node.kind === 'seed' ? 'seed' : node.kind === 'concept' ? 'concept' : 'source';
      return { id: node.id, type: 'file', file: nodePaths[node.id], x: column === 'seed' ? 0 : column === 'source' ? 530 : 1080,
        y: indices[column]++ * 300, width: 420, height: 240, color: node.kind === 'seed' ? '6' : node.kind === 'web' ? '5' : node.kind === 'note' ? '4' : '2' };
    });
    canvasPath = `${folder}/knowledge-map.canvas`;
    files.push({ path: canvasPath, content: JSON.stringify({ nodes: canvasNodes, edges: graph.edges.map(edge => ({ id: edge.id, fromNode: edge.from, toNode: edge.to,
      fromSide: 'right', toSide: 'left', toEnd: 'arrow', label: relationLabels[edge.relation] })) }, null, 2) });
  }
  // Anchors keep same-named notes elsewhere in the vault out of this run.
  const search = nativeSearch(Object.values(nodePaths));
  files.push({ path: `${folder}/native.json`, content: JSON.stringify({ rootPath: nodePaths[root.id], nodePaths, search }, null, 2) });
  return { folder, files, rootPath: nodePaths[root.id], nodePaths, search, overviewPath, ...(canvasPath ? { canvasPath } : {}), updates };
}
export interface Writer {
  mkdir(path: string): Promise<void>; exists(path: string): Promise<boolean>; create(path: string, content: string): Promise<void>;
  /** Must atomically recheck ownership with mergeManagedLinks before updating. */
  update?(path: string, ownerId: string, lines: string[], article?: ManagedArticle): Promise<void>;
  /** Validate the entire replacement without mutations, then return exact old bytes.
   * The update callback must compare these bytes again and refuse intervening edits.
   */
  prepareUpdate?(update: ManagedUpdate): Promise<string>;
  /** Atomically update only the status document created by this save operation. */
  journal?(path: string, expected: string, content: string): Promise<void>;
}
export async function saveBundle(bundle: ExportBundle, writer: Writer): Promise<void> {
  // Accept one immutable plan before any asynchronous storage operation.
  bundle={...bundle,files:bundle.files.map(file=>({...file})),updates:bundle.updates.map(update=>({...update,
    lines:[...update.lines],...(update.mergedIds?{mergedIds:[...update.mergedIds]}:{}),
    ...(update.article?{article:{...update.article}}:{}),...(update.reading?{reading:{...update.reading}}:{})}))};
  if (await writer.exists(bundle.folder)) throw new Error('本次输出目录已经存在；请重新生成，已有文件未被覆盖。');
  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (paths.has(file.path) || await writer.exists(file.path)) throw new Error(`文件已存在或输出重复，停止写入：${file.path}`);
    paths.add(file.path);
  }
  for (const update of bundle.updates) {
    if (!writer.update) throw new Error('当前写入器不支持安全更新生成笔记，停止写入。');
    if (paths.has(update.path) || !(await writer.exists(update.path))) throw new Error(`待更新笔记不存在或输出重复：${update.path}`);
    paths.add(update.path);
  }
  const originals: Array<{path:string;ownerId:string;backup:string;content:string}> = [];
  // A malformed last node must not leave all earlier nodes partly updated.
  if(writer.prepareUpdate)for(const [index,update]of bundle.updates.entries()){
    const content=await writer.prepareUpdate(update);
    if(typeof content!=='string')throw new Error(`无法备份待更新笔记原文：${update.path}`);
    originals.push({path:update.path,ownerId:update.ownerId,backup:`backup/update-${index+1}.bak`,content});
  }
  const folders = new Set<string>([bundle.folder]);
  if(originals.length)folders.add(`${bundle.folder}/backup`);
  for (const file of bundle.files) {
    const parts = file.path.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  for (const folder of [...folders].sort((a, b) => a.split('/').length - b.split('/').length))
    if (!(await writer.exists(folder))) await writer.mkdir(folder);
  const statusPath=`${bundle.folder}/run-status.json`;
  const created:string[]=[],updated:string[]=[],backups:Array<{path:string;ownerId:string;backup:string;contentHash:string}>=[];
  let status:'writing'|'complete'|'partial'='writing',failure:string|undefined,journalText:string|undefined;
  const document=()=>JSON.stringify({version:2,status,expectedFiles:bundle.files.map(file=>file.path),
    expectedUpdates:bundle.updates.map(update=>({path:update.path,ownerId:update.ownerId})),
    backups,created,updated,...(failure?{error:failure}:{})},null,2);
  const log=async()=>{
    if(journalText===undefined||!writer.journal)return;
    const next=document();await writer.journal(statusPath,journalText,next);journalText=next;
  };
  try{
    const initial=document();await writer.create(statusPath,initial);journalText=initial;
    if(originals.length){
      await writer.create(`${bundle.folder}/Recovery.md`,[
        '# 本次保存的原文备份','',
        '以下仅备份本次要修改的生成笔记。每份 .bak 保留原文、属性、关系与人工编辑；它们不会成为原生图谱节点。','',
        'run-status.json 的 backups 列表记录已经成功写入的备份，updated 列表记录已经修改的笔记。COMPLETE.json 标记本次整体保存完成；缺少它时，请先核对日志。','',
        ...originals.map(item=>`- ${plainMarkdown(item.path)} ← ${plainMarkdown(item.backup)}`),'',
        '需要恢复时，先停止探索并关闭 Obsidian，保留当前笔记副本，再核对原文备份与保存后的人工编辑，将需要的内容恢复到对应路径。不能直接覆盖后来新增的人工内容。此目录不会自动回滚笔记。',''
      ].join('\n'));
      for(const original of originals){
        await writer.create(`${bundle.folder}/${original.backup}`,original.content);
        backups.push({path:original.path,ownerId:original.ownerId,backup:original.backup,contentHash:stableId(original.content)});
      }
      await log();
    }
    for(const file of bundle.files){await writer.create(file.path,file.content);created.push(file.path);}
    await log();
    for(const update of bundle.updates){await writer.update!(update.path,update.ownerId,update.lines,update.article);updated.push(update.path);await log();}
    status='complete';await log();
    await writer.create(`${bundle.folder}/COMPLETE.json`,JSON.stringify({status:'complete',fileCount:bundle.files.length,
      updateCount:bundle.updates.length,backupCount:backups.length,completedAt:new Date().toISOString()},null,2));
  }catch(error){
    status='partial';failure=error instanceof Error?error.message:String(error);
    try{await log();}catch{/* Keep the original error and all saved backups. */}
    throw error;
  }
}
