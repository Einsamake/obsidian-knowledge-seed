export type ArticleBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string };

export interface ArticleContent {
  blocks: ArticleBlock[];
  textChars: number;
  totalTextChars: number;
  /** Original prose/structure text, excluding headings and block separators. */
  totalBodyTextChars?: number;
  truncated: boolean;
  outlineTruncated?: boolean;
  /** Exact formula alternatives from the source DOM; ordinary prose is never parsed as TeX. */
  formulas?: string[];
}

const ignoredTags = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'form', 'nav', 'aside', 'footer', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'img', 'picture', 'video', 'audio', 'source', 'annotation', 'annotation-xml']);
const containerTags = new Set(['article', 'main', 'section', 'div', 'header', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'address']);
const whitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
const omitted = (element: Element) => ignoredTags.has(element.tagName.toLowerCase())
  || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
  || ['navigation', 'banner'].includes(element.getAttribute('role') ?? '');
const mathContainers = '.mwe-math-element,[typeof~="mw:Extension/math"],.mwe-math-mathml-inline,.mwe-math-mathml-display,.mwe-math-mathml-a11y,math,img.mwe-math-fallback-image-inline,img.mwe-math-fallback-image-display';
const texEncoding = (value: string) => /^(?:application|text)\/x-(?:tex|latex)$/.test(value.split(';')[0].trim().toLowerCase());

/** A textual transcription for MathML without supplied TeX metadata. */
function mathMLText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as Element, tag = element.tagName.toLowerCase();
  if (tag === 'annotation' || tag === 'annotation-xml' || ignoredTags.has(tag)) return '';
  const parts = [...element.children].map(mathMLText);
  if (tag === 'mfrac' && parts.length === 2) return `\\frac{${parts[0]}}{${parts[1]}}`;
  if (tag === 'msqrt') return `\\sqrt{${parts.join(' ')}}`;
  if (tag === 'mroot' && parts.length === 2) return `\\sqrt[${parts[1]}]{${parts[0]}}`;
  if (tag === 'msup' && parts.length === 2) return `{${parts[0]}}^{${parts[1]}}`;
  if (tag === 'msub' && parts.length === 2) return `{${parts[0]}}_{${parts[1]}}`;
  if (tag === 'msubsup' && parts.length === 3) return `{${parts[0]}}_{${parts[1]}}^{${parts[2]}}`;
  if (tag === 'munder' && parts.length === 2) return `{${parts[0]}}_{${parts[1]}}`;
  if (tag === 'mover' && parts.length === 2) return `\\overset{${parts[1]}}{${parts[0]}}`;
  if (tag === 'munderover' && parts.length === 3) return `{${parts[0]}}_{${parts[1]}}^{${parts[2]}}`;
  if (tag === 'mfenced') return (element.getAttribute('open') ?? '(') + parts.join(element.getAttribute('separators') ?? ',') + (element.getAttribute('close') ?? ')');
  if (tag === 'mtable') return `[${parts.join('; ')}]`;
  if (tag === 'mtr' || tag === 'mlabeledtr') return parts.join(', ');
  return [...element.childNodes].map(mathMLText).filter(text => text.trim()).join(' ').trim();
}

/** Read one formula from its alternative representations, never ordinary image alt. */
function mathSource(element: Element): string | undefined {
  if (!element.matches(mathContainers)) return undefined;
  const math = element.tagName.toLowerCase() === 'math' ? element : element.querySelector('math');
  const alternative = math?.getAttribute('alttext')?.trim();
  if (alternative) return alternative;
  const annotation = [...(math ?? element).querySelectorAll('annotation[encoding]')]
    .find(node => texEncoding(node.getAttribute('encoding') ?? '') && node.textContent?.trim());
  if (annotation) return annotation.textContent!.trim();
  try {
    const data = JSON.parse(element.getAttribute('data-mw') ?? 'null');
    if (data?.name === 'math' && typeof data.body?.extsrc === 'string' && data.body.extsrc.trim()) return data.body.extsrc.trim();
  } catch { /* Invalid source metadata does not hide other formula representations. */ }
  const image = element.tagName.toLowerCase() === 'img' ? element : element.querySelector('img[alt]');
  const imageAlt = image?.getAttribute('alt')?.trim();
  if (imageAlt) return imageAlt;
  const accessible = math?.getAttribute('aria-label')?.trim();
  if (accessible) return accessible;
  const fallback = math ? mathMLText(math).trim() : '';
  return fallback || undefined;
}

/** Preserve formula metadata before hidden accessibility DOM and all assets are removed. */
export function preserveMathText(root: Document | Element): string[] {
  const formulas = new Set<string>();
  const candidates = [...root.querySelectorAll(mathContainers)];
  if (root.nodeType === 1 && (root as Element).matches(mathContainers)) candidates.unshift(root as Element);
  for (const candidate of candidates) {
    if (candidate !== root && !root.contains(candidate)) continue;
    const source = mathSource(candidate);
    if (!source) continue;
    formulas.add(whitespace(source));
    candidate.replaceWith(candidate.ownerDocument.createTextNode(` ${source} `));
  }
  return [...formulas];
}

// Formula alternatives remain untrusted source data. Only this small, non-interactive
// TeX vocabulary may be rendered; macros, links, assets and unknown extensions stay text.
const mathCommands = new Set(('displaystyle text textnormal textrm textit textbf mathrm mathit mathbf mathsf mathtt mathbb mathcal mathscr boldsymbol operatorname ' +
  'frac dfrac tfrac sqrt binom dbinom tbinom overline underline overset underset vec hat widehat bar dot ddot tilde widetilde check breve acute grave ' +
  'left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr ' +
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega ' +
  'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega ' +
  'sum prod coprod int iint iiint oint lim min max inf sup arg det dim ker exp log ln sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan ' +
  'infty partial nabla ell hbar Re Im emptyset varnothing forall exists neg land lor wedge vee cap cup bigcap bigcup ' +
  'times cdot ast star circ bullet div pm mp le leq ge geq ne neq equiv approx sim simeq cong propto in notin ni subset supset subseteq supseteq ' +
  'to mapsto rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow uparrow downarrow longrightarrow longleftarrow ' +
  'ldots cdots vdots ddots dots perp parallel vert Vert lvert rvert lVert rVert langle rangle lfloor rfloor lceil rceil lt gt ' +
  'quad qquad thinspace medspace thickspace limits nolimits substack underbrace overbrace phantom hphantom vphantom ' +
  'begin end').split(/\s+/));

export function safeArticleFormula(source: string): boolean {
  if (!source.trim() || source.length > 4096 || /[$%`\u0000-\u001f]|\[\[|\]\]|<\/?[a-z]/i.test(source)) return false;
  let depth = 0;
  for (const character of source) {
    if (character === '{' && ++depth > 64) return false;
    if (character === '}' && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const match of source.matchAll(/\\([a-zA-Z]+|.)/g)) {
    if (/^[a-zA-Z]+$/.test(match[1]) ? !mathCommands.has(match[1]) : !/^[\\{}|!,; :_#&]$/.test(match[1])) return false;
  }
  for (const match of source.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g)) {
    if (!/^(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|cases|aligned|alignedat|gathered)$/.test(match[1])) return false;
  }
  return true;
}

const formulaPatterns = new WeakMap<string[], RegExp | null>();
/** Plain text and safe source formula spans for both native preview and Markdown export. */
export function articleTextSegments(text: string, formulas?: string[]): Array<{ text: string; math?: true }> {
  if (!formulas?.length) return [{ text }];
  let pattern = formulaPatterns.get(formulas);
  if (pattern === undefined) {
    let size = 0;
    const sources = [...new Set(formulas.slice(0, 512))].filter(source => {
      if (!safeArticleFormula(source) || size + source.length > 64000) return false;
      size += source.length;
      return true;
    }).sort((a, b) => b.length - a.length);
    pattern = sources.length ? new RegExp(sources.map(source => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
    formulaPatterns.set(formulas, pattern);
  }
  if (!pattern) return [{ text }];
  pattern.lastIndex = 0;
  const segments: Array<{ text: string; math?: true }> = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    // A source symbol x must not turn the x in explanatory prose into a formula.
    const before = text[match.index! - 1] ?? '', after = text[match.index! + match[0].length] ?? '';
    if ((/^[\p{L}\p{N}]/u.test(match[0]) && /[\p{L}\p{N}]/u.test(before)) ||
        (/[\p{L}\p{N}]$/u.test(match[0]) && /[\p{L}\p{N}]/u.test(after))) continue;
    if (match.index! > offset) segments.push({ text: text.slice(offset, match.index) });
    segments.push({ text: match[0], math: true });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset) });
  return segments.length ? segments : [{ text }];
}

/** Never leave a dangling half of a UTF-16 surrogate pair at a budget boundary. */
function sliceText(value: string, limit: number): string {
  let end = Math.min(value.length, Math.max(0, Math.floor(limit)));
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
  return value.slice(0, end);
}

function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  const formula = mathSource(element);
  if (formula) return ` ${formula} `;
  if (omitted(element)) return '';
  const tag = element.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  const text = [...element.childNodes].map(visibleText).join('');
  return text + (/^(?:p|li|tr|td|th|div|section|h[1-6])$/.test(tag) ? '\n' : '');
}

function blockText(block: ArticleBlock): string {
  if (block.type === 'list') return block.items.join('\n');
  if (block.type === 'table') return block.rows.map(row => row.join(' ')).join('\n');
  return block.text;
}

/** Count source characters, never serialization separators or empty structures. */
function blockBodyTextChars(block: ArticleBlock): number {
  if (block.type === 'heading') return 0;
  if (block.type === 'list') return block.items.reduce((total, item) => total + item.length, 0);
  if (block.type === 'table') return block.rows.reduce((total, row) => total + row.reduce((sum, cell) => sum + cell.length, 0), 0);
  return block.text.trim() ? block.text.length : 0;
}

/** Exact text used for both discovery and the detailed article's budget accounting. */
export function articlePlainText(article: Pick<ArticleContent, 'blocks'>): string {
  return article.blocks.map(blockText).join('\n\n');
}

/** Count retained source text without treating a directory of headings as body. */
export function articleBodyTextChars(article: Pick<ArticleContent, 'blocks'>): number {
  return article.blocks.reduce((total, block) => total + blockBodyTextChars(block), 0);
}

/** Serialize the cleaned DOM structurally; no remote HTML, assets or link targets survive. */
export function extractArticleContent(root: Element, targetChars: number, hardLimitChars = 1_000_000): ArticleContent {
  const formulas = [...new Set([...root.querySelectorAll(mathContainers)].map(mathSource).filter((source): source is string => Boolean(source)).map(whitespace))];
  const collected: ArticleBlock[] = [];
  const emit = (block: ArticleBlock) => {
    if (block.type === 'heading' ? Boolean(block.text) : blockBodyTextChars(block) > 0) collected.push(block);
  };
  const walk = (element: Element): void => {
    if (omitted(element)) return;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) { emit({ type: 'heading', level: Number(tag[1]), text: whitespace(visibleText(element)) }); return; }
    if (tag === 'p') { emit({ type: 'paragraph', text: whitespace(visibleText(element)) }); return; }
    if (tag === 'pre') { emit({ type: 'code', text: visibleText(element).replace(/\r\n?/g, '\n').replace(/^\n|\n$/g, '') }); return; }
    if (tag === 'blockquote') { emit({ type: 'quote', text: whitespace(visibleText(element)) }); return; }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...element.children].filter(child => child.tagName.toLowerCase() === 'li' && !omitted(child))
        .map(child => whitespace(visibleText(child))).filter(Boolean);
      if (items.length) emit({ type: 'list', ordered: tag === 'ol', items });
      return;
    }
    if (tag === 'table') {
      const rows = [...element.querySelectorAll('tr')].filter(row => row.closest('table') === element && !omitted(row))
        .map(row => [...row.children].filter(cell => /^(?:td|th)$/i.test(cell.tagName) && !omitted(cell)).map(cell => whitespace(visibleText(cell))))
        .filter(row => row.length > 0);
      if (rows.length) emit({ type: 'table', rows });
      return;
    }
    let inline = '';
    const flush = () => { const text = whitespace(inline); if (text) emit({ type: 'paragraph', text }); inline = ''; };
    for (const child of element.childNodes) {
      if (child.nodeType === 1) {
        const childElement = child as Element, childTag = childElement.tagName.toLowerCase();
        if (containerTags.has(childTag) || /^(?:h[1-6]|p|pre|blockquote|ul|ol|table)$/.test(childTag)) {
          flush(); walk(childElement); continue;
        }
      }
      inline += visibleText(child);
    }
    flush();
  };
  walk(root);
  // Empty final sections are cleanup, not a capacity truncation. Remove their
  // headings before calculating the cleaned source's totals.
  while (collected.at(-1)?.type === 'heading') collected.pop();
  const totalTextChars = articlePlainText({ blocks: collected }).length;
  const totalBodyTextChars = articleBodyTextChars({ blocks: collected });
  // The target is crossed at a complete source block. A separate hard limit
  // bounds oversized blocks and the remaining capacity of a multi-page run.
  const target = Number.isFinite(targetChars) ? Math.max(0, Math.floor(targetChars)) : 0;
  const hardLimit = Number.isFinite(hardLimitChars) ? Math.max(0, Math.floor(hardLimitChars)) : 0;
  const blocks: ArticleBlock[] = [];
  let used = 0, bodyUsed = 0;
  for (const block of collected) {
    if (bodyUsed >= target) break;
    const separator = blocks.length ? 2 : 0;
    const length = blockText(block).length;
    if (used + separator + length > hardLimit) break;
    blocks.push(block);
    used += separator + length;
    bodyUsed += blockBodyTextChars(block);
  }
  // A heading without any retained following content would promise a section
  // that the note cannot actually show, including when the hard limit is hit.
  while (blocks.at(-1)?.type === 'heading') blocks.pop();
  const textChars = articlePlainText({ blocks }).length;
  const retainedText = articlePlainText({ blocks });
  const retainedFormulas = formulas.filter(source => retainedText.includes(source));
  return { blocks, textChars, totalTextChars, totalBodyTextChars, truncated: textChars < totalTextChars,
    ...(retainedFormulas.length ? { formulas: retainedFormulas } : {}),
    ...(blocks.filter(block => block.type === 'heading').length > 60 ? { outlineTruncated: true } : {}) };
}

/** Entity-escape HTML/comment delimiters and escape Markdown syntax in visible text. */
export function inertMarkdownText(value: string): string {
  return value.replace(/[\\\[\]`*_{}#!|+\-=$]/g, character => '\\' + character)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/%/g, '&#37;');
}
const safeText = inertMarkdownText;

function renderBlock(block: ArticleBlock, formulas?: string[]): string {
  const readableText = (text: string) => articleTextSegments(text, formulas).map(segment =>
    segment.math ? `$${segment.text.replace(/\|/g, '\\vert ')}$` : safeText(segment.text)).join('');
  switch (block.type) {
    // The export's detailed正文 section is h2, so source headings live beneath it.
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(3, block.level + 1)))} ${safeText(block.text)}`;
    case 'paragraph': return readableText(block.text);
    case 'quote': return `> ${readableText(block.text)}`;
    case 'list': return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${readableText(item)}`).join('\n');
    case 'table': {
      const width = block.rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (!width) return '';
      // Wide/ragged tables must not allocate a rows × max-columns padding matrix.
      if (width > 12) return '表格列数较多，按原始行列顺序展开：\n\n' + block.rows.map((cells, rowIndex) =>
        `**第 ${rowIndex + 1} 行**\n\n` + cells.map((cell, columnIndex) => `- 第 ${columnIndex + 1} 列：${readableText(cell)}`).join('\n')).join('\n\n');
      const row = (cells: string[]) => '| ' + Array.from({ length: width }, (_, index) => readableText(cells[index] ?? '')).join(' | ') + ' |';
      return [row(block.rows[0] ?? []), '| ' + Array(width).fill('---').join(' | ') + ' |', ...block.rows.slice(1).map(row)].join('\n');
    }
    case 'code': {
      const runs = block.text.match(/`+/g) ?? [];
      const fence = '`'.repeat(runs.reduce((max, run) => Math.max(max, run.length + 1), 3));
      // Never propagate a webpage's executable language such as dataviewjs.
      return `${fence}text\n${block.text}\n${fence}`;
    }
  }
}

export function renderArticleContent(article: ArticleContent): string {
  const body = article.blocks.map(block => renderBlock(block, article.formulas)).filter(Boolean).join('\n\n');
  const notice = article.truncated ? `> 正文受字符预算限制，已按完整段落或结构块截断，保留 ${article.textChars} / ${article.totalTextChars} 个文本字符；后续内容未包含。` : '';
  return [body || '没有可保留的正文。', notice].filter(Boolean).join('\n\n');
}

/** The guide is an explicitly labelled verbatim leading paragraph, never an inferred summary. */
export function articleGuide(article: ArticleContent): string {
  const lead = article.blocks.find(block => block.type === 'paragraph');
  if (!lead || lead.type !== 'paragraph') return '没有可摘录的开头正文段落；请直接阅读下方已保留正文。';
  const excerpt = sliceText(lead.text, 320);
  return `以下为网页开头正文的原文摘录，并非自动总结：\n\n> ${safeText(excerpt)}${excerpt.length < lead.text.length ? '\n\n摘录仅显示本段前 320 个文本字符。' : ''}`;
}

export function articleOutline(article: ArticleContent): string {
  const headings = article.blocks.filter((block): block is Extract<ArticleBlock, { type: 'heading' }> => block.type === 'heading');
  if (!headings.length) return '已保留正文中没有小节标题。';
  const fragment = (title: string) => encodeURIComponent(title).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  const outline = headings.slice(0, 60).map(heading => `${'  '.repeat(Math.min(3, Math.max(0, heading.level - 1)))}- [${safeText(heading.text)}](#${fragment(heading.text)})`).join('\n');
  return outline + (headings.length > 60 ? '\n\n目录仅显示前 60 个已保留标题；其余标题仍在正文中。' : '');
}
