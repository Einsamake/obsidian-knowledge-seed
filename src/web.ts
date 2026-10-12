import Defuddle from "defuddle";
import { cleanKnowledgeTitle, isNoiseLabel } from "./titles";
import { extractArticleContent, articleBodyTextChars, articlePlainText, preserveMathText, type ArticleContent } from './article';

export interface WebDocument {
  url: string;
  title: string;
  /** Original HTML title, before presentation-only site suffix cleanup. */
  sourceTitle?: string;
  text: string;
  links: Array<{ url: string; label: string; quote: string }>;
  headings: string[];
  retrievedAt: string;
  truncated: boolean;
  /** Bounded, structured source content. excerpt previews never replace this body. */
  article: ArticleContent;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MIN_TEXT_CHARS = 80;
const NON_CONTENT = "script,style,noscript,template,iframe,object,embed,form,nav,footer,aside,[role=navigation],[role=banner],[role=dialog],.sidebar,.navigation,.menu,.comments,.advertisement,.cookie-consent,.cookie-banner,.consent-banner,[hidden],[aria-hidden=true]";
const WIKI_NON_CONTENT = "#toc,.toc,.mw-editsection,.editsection,.navbox,.vertical-navbox,table.sidebar-collapse,table.sidebar-navbox,.sidebar-container,.metadata,.ambox,.tmbox,.ombox,.fmbox,.cmbox,.imbox,.hatnote,.shortdescription,.sistersitebox,.portal,.authority-control,.catlinks,.reflist,.references,.reference,.mw-ref,.mw-references-wrap,.mw-cite-backlink,.interlanguage-link,.interlanguage-link-target,.mw-interlanguage-link,.uls-language-list,.vector-language-dropdown,.mw-indicators,.mw-jump-link,.mw-navigation,.printfooter,.license,.licensetpl,.copyright,.navigation-not-searchable,.searchaux";
const ANCILLARY_SECTIONS = /^(?:references|notes|footnotes|citations|bibliography|sources|further reading|external links|see also|参考文献|參考文獻|参考资料|參考資料|参考来源|參考來源|引用|引用来源|引用來源|注释|註釋|脚注|腳註|外部链接|外部連結|延伸阅读|延伸閱讀|参见|參見|相关条目|相關條目)$/i;
const WIKI_NAMESPACE = /^(?:special|help|wikipedia|template|file|image|media|category|talk|user|user talk|portal|mediawiki|draft|module|book|timedtext|特殊|帮助|幫助|维基百科|維基百科|模板|文件|檔案|图像|圖像|媒体|媒體|分类|分類|讨论|討論|用户|用戶|使用者|主题|主題)(?:[ _]talk)?\s*:/i;

/** Literal-host validation. The transport must additionally prevent unsafe DNS/redirect targets. */
export function publicUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("请输入完整的公开网页地址（http 或 https）。");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("仅支持不含用户名和密码的 http/https 网页地址。");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host)) {
    throw new Error("不允许访问本地或私有网络地址。");
  }
  if (host.startsWith("[")) {
    // Accept only globally routable unicast IPv6. Reject mapped, local, multicast,
    // documentation and transition ranges rather than allowing encoded private IPv4.
    const ip = host.slice(1, -1);
    const first = parseInt(ip.split(":")[0], 16);
    if (!(first >= 0x2000 && first < 0x3fff) || /^2001:(?:db8|0|2|10|20)(?::|$)/.test(ip) || /^2002:/.test(ip)) {
      throw new Error("不允许访问本地、私有或特殊用途 IPv6 地址。");
    }
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) {
      throw new Error("不允许访问本地、私有或特殊用途 IPv4 地址。");
    }
  } else if (!host.includes(".") || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("网页地址必须使用公开域名，不能使用单标签主机名。");
  }
  parsed.hostname = host;
  parsed.hash = "";
  return parsed.href;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function removeNonContent(doc: Document | Element): void {
  doc.querySelectorAll(NON_CONTENT).forEach((node) => node.remove());
  doc.querySelectorAll("[style]").forEach((node) => {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute("style") ?? "")) node.remove();
  });
}

/** Older wiki topic sidebars can use infobox styling instead of a navigation class.
 * Their navbar controls, single-column layout and dense topic links distinguish
 * them from labelled fact rows. Explicit data tables remain reading content. */
function removeWikiNavigationTables(root: Element, pageUrl: string): void {
  const page = new URL(pageUrl);
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.matches('.wikitable') || !table.querySelector('.navbar,.tnavbar,.sidebar-navbar')) continue;
    const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table);
    if (rows.length < 3 || rows.some(row => Array.from(row.children).filter(cell => /^(?:TD|TH)$/.test(cell.tagName)).length > 1)) continue;
    const topicLinks = Array.from(table.querySelectorAll('a[href]')).filter(anchor => {
      if (anchor.closest('.navbar,.tnavbar,.sidebar-navbar')) return false;
      try {
        const target = new URL(anchor.getAttribute('href') ?? '', pageUrl);
        return target.hostname === page.hostname && (target.pathname.startsWith('/wiki/') || target.searchParams.has('title'))
          && isWikiArticleLink(target.href, anchor);
      } catch { return false; }
    });
    // Bullets and spacing vary across wiki templates; compare meaningful text
    // so long topic lists are not disguised as prose by their separators.
    const meaningfulChars = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '').length;
    const linkChars = topicLinks.reduce((sum, anchor) => sum + meaningfulChars(anchor.textContent ?? ''), 0);
    const totalChars = meaningfulChars(table.textContent ?? '');
    if (topicLinks.length >= 8 && totalChars > 0 && linkChars / totalChars >= 0.6) table.remove();
  }
}

/** Remove only exact ancillary section names, respecting the next heading's level. */
function removeWikiSections(root: Element): void {
  for (const heading of Array.from(root.querySelectorAll("h2,h3,h4,h5,h6"))) {
    if (!root.contains(heading) || !ANCILLARY_SECTIONS.test(cleanText(heading.textContent ?? ""))) continue;
    const section = heading.closest("section");
    if (section && section !== root && section.querySelector("h1,h2,h3,h4,h5,h6") === heading) {
      section.remove(); // Parsoid wraps sections; nested subsections belong to this section.
      continue;
    }
    const level = Number(heading.tagName.slice(1));
    const block = heading.parentElement?.classList.contains("mw-heading") ? heading.parentElement : heading;
    let next = block.nextSibling;
    block.remove();
    while (next) {
      const candidate = next.nodeType === 1 ? next as Element : undefined;
      const nextHeading = candidate?.matches("h1,h2,h3,h4,h5,h6") ? candidate : candidate?.querySelector("h1,h2,h3,h4,h5,h6");
      if (nextHeading && Number(nextHeading.tagName.slice(1)) <= level) break;
      const following = next.nextSibling;
      next.parentNode?.removeChild(next);
      next = following;
    }
  }
}

function isWikiArticleLink(url: string, anchor: Element): boolean {
  if (anchor.closest('.interlanguage-link,.interlanguage-link-target,.mw-interlanguage-link,[rel~="mw:PageProp/Language"]')) return false;
  const target = new URL(url);
  if (["action", "diff", "oldid", "search", "redlink"].some((key) => target.searchParams.has(key))) return false;
  let title = target.pathname.startsWith("/wiki/") ? target.pathname.slice(6) : target.searchParams.get("title");
  if (!title) return !target.pathname.startsWith("/w/");
  try { title = decodeURIComponent(title).replace(/_/g, " "); } catch { return false; }
  return !WIKI_NAMESPACE.test(title);
}

function plainText(root: Node): string {
  const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE", "BLOCKQUOTE", "TR", "BR"]);
  const collect = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    const tag = (node as Element).tagName;
    const content = Array.from(node.childNodes).map(collect).join("");
    return blockTags.has(tag) ? `\n${content}\n` : content;
  };
  return collect(root).split(/\n+/).map(cleanText).filter(Boolean).join("\n\n");
}

export function extractWebDocument(html: string, url: string, maxChars = 48000, hardLimitChars = 1_000_000): WebDocument {
  const normalizedUrl = publicUrl(url);
  if (typeof html !== "string" || new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new Error("网页超过 2 MB，暂不支持解析。");
  }
  if (!Number.isInteger(maxChars) || maxChars < 2000 || maxChars > 1000000) {
    throw new Error("正文长度目标必须是 2000 到 1000000 之间的整数。");
  }
  if (!Number.isInteger(hardLimitChars) || hardLimitChars < 0 || hardLimitChars > 1_000_000) {
    throw new Error("正文容量上限必须是 0 到 1000000 之间的整数。");
  }
  const parser = new DOMParser();
  // Detached DOMParser documents are never inserted into the live document.
  const inertHtml = html.replace(/<([a-z][a-z0-9:_-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (tag, name: string) => {
    if (/^(?:source|iframe|object|embed|link|meta|base)$/i.test(name)) return '';
    // Parse attribute tokens as a whole: source-like text within a formula's
    // quoted alt must not be mistaken for a resource attribute.
    return tag.replace(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g,
      (attribute: string, key: string) => /^(?:src|srcset|poster)$/i.test(key) ? '' : attribute);
  });
  const document = parser.parseFromString(inertHtml, "text/html");
  const originalTitle = cleanText(document.querySelector("title")?.textContent ?? document.querySelector("h1")?.textContent ?? "");
  const pageHeading = cleanText(document.querySelector(".mw-first-heading,#firstHeading,.firstHeading,h1")?.textContent ?? "");
  const formulas = preserveMathText(document);
  document.querySelectorAll('img,picture').forEach(node => node.remove());
  removeNonContent(document);
  // MediaWiki's article DOM is more reliable than generic template heuristics.
  // #mw-content-text can include unrelated elements, so prefer .mw-parser-output.
  const wikiRoot = document.querySelector("#mw-content-text .mw-parser-output")
    ?? document.querySelector(".mw-parser-output") ?? document.querySelector("#mw-content-text");
  let root: Element;
  let title: string;
  if (wikiRoot) {
    root = wikiRoot;
    root.querySelectorAll(WIKI_NON_CONTENT).forEach((node) => node.remove());
    removeWikiNavigationTables(root, normalizedUrl);
    // Factual infoboxes can also contain view/talk/edit controls: keep their
    // data rows but never present these template controls as source prose.
    root.querySelectorAll('.navbar,.tnavbar,.sidebar-navbar').forEach(node => node.remove());
    // Preserve labelled factual tables for reading; one-cell template banners are noise.
    root.querySelectorAll('.infobox').forEach(node => {
      if (node.querySelectorAll('tr').length < 2 || !node.querySelector('th')) node.remove();
    });
    removeWikiSections(root);
    // Some skins place illustration captions before the introductory prose.
    // Keep those captions, but prioritize the actual lead for bounded extraction.
    const lead = Array.from(root.querySelectorAll("p")).find((paragraph) =>
      cleanText(paragraph.textContent ?? "").length >= 20 && !paragraph.closest("figure,.thumb,table"));
    if (lead) root.insertBefore(lead, root.firstChild);
    title = pageHeading || originalTitle;
  } else {
    const result = new Defuddle(document, { url: normalizedUrl, useAsync: false }).parse();
    const extracted = parser.parseFromString(`<!doctype html><html><body>${result.content ?? ""}</body></html>`, "text/html");
    removeNonContent(extracted);
    root = extracted.body;
    // Defuddle is kept for ordinary sites; its empty result can be recovered
    // from an explicit article/main element without admitting the whole skin.
    if (cleanText(plainText(root)).length < MIN_TEXT_CHARS) root = document.querySelector("article,main,[role=main]") ?? root;
    title = cleanText(result.title || originalTitle || pageHeading);
  }
  const article = extractArticleContent(root, maxChars, hardLimitChars);
  const text = articlePlainText(article);
  const retainedFormulas = formulas.filter(source => text.includes(source));
  if (retainedFormulas.length) article.formulas = retainedFormulas;
  const totalBodyChars = article.totalBodyTextChars ?? article.totalTextChars;
  if (totalBodyChars < MIN_TEXT_CHARS) {
    throw new Error("网页可提取正文不足，可能需要登录、包含验证码或依赖动态加载。请将正文粘贴为笔记后再生成。");
  }
  if (articleBodyTextChars(article) < Math.min(2000, totalBodyChars)) {
    throw new Error(`网页正文的完整段落或结构块超出本页 ${hardLimitChars} 字符容量，无法保留至少 2000 字符（短于 2000 的原文需完整保留）。请缩小本次探索规模，或将正文保存为笔记后再生成。`);
  }
  const links: WebDocument["links"] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    const raw = anchor.getAttribute("href")?.trim() ?? "";
    if (anchor.closest('table.infobox')) continue; // Reading facts do not become expansion links.
    if (!raw || raw.startsWith("#")) continue;
    let target: string;
    try { target = publicUrl(new URL(raw, normalizedUrl).href); } catch { continue; }
    if (target === normalizedUrl || seen.has(target)) continue;
    if ((wikiRoot || /(?:^|\.)wikipedia\.org$/.test(new URL(target).hostname)) && !isWikiArticleLink(target, anchor)) continue;
    const rawLabel = cleanText(anchor.textContent ?? "");
    const label = cleanKnowledgeTitle(rawLabel);
    const paragraph = cleanText((anchor.closest("p,li,blockquote,td") ?? anchor.parentElement)?.textContent ?? "");
    // Standalone menu-like anchors are not evidence-bearing knowledge links.
    if (isNoiseLabel(rawLabel) || isNoiseLabel(label) || paragraph.length < Math.max(24, rawLabel.length + 8)) continue;
    // Never attach evidence from a paragraph outside the retained body text.
    if (!cleanText(text).includes(paragraph)) continue;
    seen.add(target);
    const quoteStart = Math.max(0, paragraph.indexOf(rawLabel) - Math.max(0, Math.floor((800 - rawLabel.length) / 2)));
    links.push({ url: target, label: label.slice(0, 200), quote: paragraph.slice(quoteStart, quoteStart + 800) });
    if (links.length >= 100) break;
  }
  const headings = article.blocks.filter(block => block.type === 'heading').map(block => block.text)
    .filter(heading => !isNoiseLabel(heading));
  return { url: normalizedUrl, title: cleanKnowledgeTitle(title || new URL(normalizedUrl).hostname), sourceTitle: originalTitle || undefined,
    text, article, links, headings: [...new Set(headings)].slice(0, 60), retrievedAt: new Date().toISOString(), truncated: article.truncated };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("网页抓取已取消。", "AbortError");
}

export async function fetchWebDocument(
  url: string,
  request: (url: string) => Promise<{ text: string; status: number; headers?: Record<string, string> }>,
  signal?: AbortSignal,
  maxChars = 48000,
  hardLimitChars = 1_000_000,
): Promise<WebDocument> {
  throwIfAborted(signal);
  const normalizedUrl = publicUrl(url);
  let onAbort: (() => void) | undefined;
  let response: Awaited<ReturnType<typeof request>>;
  try {
    if (signal) {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("网页抓取已取消。", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      // The injected transport has no cancellation argument: stop waiting and
      // discard its result, even though an already-issued request may finish.
      response = await Promise.race([request(normalizedUrl), aborted]);
    } else {
      response = await request(normalizedUrl);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`网页请求失败（HTTP ${response.status}），可能需要登录或被站点拒绝访问。`);
  }
  const mime = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.split(";")[0].trim().toLowerCase();
  if (mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
    throw new Error(`该地址返回 ${mime}，目前仅支持 HTML 网页。`);
  }
  if (!mime && !/<(?:!doctype\s+html|html|head|body|article|main|p)(?:\s|>)/i.test(response.text)) {
    throw new Error("该地址没有返回可识别的 HTML 网页。");
  }
  return extractWebDocument(response.text, normalizedUrl, maxChars, hardLimitChars);
}
