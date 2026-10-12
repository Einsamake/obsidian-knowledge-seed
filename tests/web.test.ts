import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
import { extractWebDocument, fetchWebDocument, publicUrl } from "../src/web";
import { articleBodyTextChars } from '../src/article';

Object.assign(globalThis, { DOMParser });

// This local regression reconstructs the five-row navigation block observed in
// native QR分解 reading.json (lead, topic title/list, matrix illustration, 查/论/编).
// The saved reading contains text/rows, not the original HTML classes.
const qrLead = 'QR分解法是一种将矩阵分解的方式。这种方式，把矩阵分解成一个正交矩阵与一个上三角矩阵的积。QR分解经常用来解线性最小二乘法问题。QR分解也是特定特征值算法即QR算法的基础。';
const qrTopics = ['向量', '向量空间', '基底', '行列式', '矩阵', '标量', '向量投影', '外积', '七维向量积', '内积',
  '线性方程组', '单位矩阵', '初等矩阵', '分块矩阵', '共轭转置', '正定矩阵', '幂零矩阵', '拉普拉斯展开', '克罗内克积', '对偶空间'];
const qrNavbar = '<div class="navbar"><a href="/wiki/Template:线性代数">查</a> <a href="/wiki/Template_talk:线性代数">论</a> <a href="/w/index.php?title=Template:线性代数&amp;action=edit">编</a></div>';
const qrNavigation = `<table class="infobox nowraplinks"><tr><th>线性代数</th></tr>
  <tr><td><math alttext="N_{nav}"><mi>N</mi></math></td></tr>
  <tr><td>向量 · 向量空间 · 基底 · 行列式 · 矩阵</td></tr>
  <tr><td>${qrTopics.map(topic=>`<a href="/wiki/${topic}">${topic}</a>`).join(' · ')}</td></tr>
  <tr><td>${qrNavbar}</td></tr></table>`;

test('legacy single-column wiki topic navigation is excluded from body, formulas and expansion evidence', () => {
  const html=`<html><head><title>QR分解</title></head><body><h1 id="firstHeading">QR分解</h1>
    <div class="mw-parser-output">${qrNavigation}<p>${qrLead}</p><h2>类别及定义</h2>
    <p>任何方块矩阵都可以分解为 <math alttext="A=QR"><mi>A</mi><mo>=</mo><mi>Q</mi><mi>R</mi></math>。
    其中 <a href="/wiki/正交矩阵">正交矩阵</a> 与上三角矩阵相乘，保留这段真实正文和数学定义作为可复核证据。</p></div></body></html>`;
  const result=extractWebDocument(html,'https://zh.wikipedia.org/wiki/QR分解');
  assert.ok(result.text.startsWith(qrLead));
  assert.doesNotMatch(result.text,/七维向量积|拉普拉斯展开|克罗内克积|查 论 编|N_\{nav\}/);
  assert.equal(result.article.blocks.filter(block=>block.type==='table').length,0);
  assert.deepEqual(result.article.formulas,['A=QR']);
  assert.match(result.text,/A=QR/);
  assert.deepEqual(result.links.map(link=>link.label),['正交矩阵']);
  assert.ok(result.headings.includes('类别及定义'));
});

test('wiki fact infoboxes and explicit wikitable data retain labels, values and formulas even with template controls', () => {
  const facts=`<table class="infobox"><tr><th colspan="2">QR 分解信息</th></tr>
    <tr><th>输出</th><td>正交矩阵与上三角矩阵</td></tr><tr><th>恒等式</th><td><math alttext="Q^{T}Q=I"><mi>Q</mi></math></td></tr>
    <tr><td colspan="2">${qrNavbar}</td></tr></table>`;
  // Even a dense one-column data table is not rejected merely because it has
  // many links and a template footer. Its explicit data class wins.
  const data=`<table class="wikitable"><tr><th>矩阵分解方法比较</th></tr>
    <tr><td>${qrTopics.map(topic=>`<a href="/wiki/${topic}">${topic}</a>`).join(' · ')}</td></tr>
    <tr><td>算法定义的数值样例 <math alttext="R_{11}=1"><mi>R</mi></math></td></tr><tr><td>${qrNavbar}</td></tr></table>`;
  const html=`<html><head><title>QR分解</title></head><body><div class="mw-parser-output"><p>${qrLead}</p>${facts}${data}</div></body></html>`;
  const result=extractWebDocument(html,'https://zh.wikipedia.org/wiki/QR分解');
  const tables=result.article.blocks.filter(block=>block.type==='table');
  assert.equal(tables.length,2);
  assert.match(result.text,/输出 正交矩阵与上三角矩阵/);
  assert.match(result.text,/矩阵分解方法比较/);
  assert.match(result.text,/Q\^\{T\}Q=I/);assert.match(result.text,/R_\{11\}=1/);
  assert.ok(result.article.formulas?.includes('Q^{T}Q=I'));assert.ok(result.article.formulas?.includes('R_{11}=1'));
  assert.ok(result.text.includes(qrLead));
  assert.doesNotMatch(result.text,/查 论 编/,'template administration controls are removed while factual rows remain');
});

test('wiki collapsed sidebar variants are discarded without dropping adjacent data tables or mathematical prose', () => {
  for(const className of ['sidebar-collapse','sidebar-navbox']){
    const html=`<html><head><title>QR分解</title></head><body><div class="mw-parser-output"><p>${qrLead}</p>
      <table class="${className}"><tr><th>导航盒只供跳转</th></tr><tr><td>不应读取的跳转清单</td></tr></table>
      <table class="wikitable"><tr><th>误差</th><th>结果</th></tr><tr><td>实际实验</td><td>0.001</td></tr></table>
      <p>公式 <math alttext="A=QR"><mi>A</mi><mo>=</mo><mi>Q</mi><mi>R</mi></math> 与紧随其后的推导正文必须保留。</p></div></body></html>`;
    const result=extractWebDocument(html,'https://zh.wikipedia.org/wiki/QR分解');
    assert.doesNotMatch(result.text,/导航盒只供跳转|不应读取的跳转清单/);
    assert.equal(result.article.blocks.filter(block=>block.type==='table').length,1);
    assert.match(result.text,/实际实验 0\.001/);assert.match(result.text,/推导正文必须保留/);
    assert.deepEqual(result.article.formulas,['A=QR']);
  }
});

const article = `<!doctype html><html><head><title>知识图谱基础</title></head><body>
<nav><a href="https://example.com/menu">导航链接</a>这些菜单项不应当构成知识证据。</nav>
<article><h1>知识图谱基础</h1><h2>关系与证据</h2>
<p>知识图谱使用实体和关系组织知识。这是一段真实的中文正文，它将概念之间的关系与可追溯的原始来源连接起来。为了避免把语义相似性误当成事实关系，每一条知识关系都应该保留能够供读者检查的证据。</p>
<p>关于<a href="/evidence#section">证据核查</a>的说明进一步讨论了来源判断的方法，并且给出了可复核的知识关系。</p>
<p>这些链接不应被保留：<a href="http://127.0.0.1/admin">内网</a>、<a href="javascript:alert(1)">脚本</a>、<a href="https://user:pass@example.org">凭据</a>。</p>
<script>globalThis.remoteScriptExecuted = true;</script></article>
<footer><a href="https://example.com/privacy">隐私政策</a></footer></body></html>`;

test("public URL normalizes hash, host and common encoded IP forms", () => {
  assert.equal(publicUrl(" HTTPS://EXAMPLE.COM/article#section "), "https://example.com/article");
  assert.equal(publicUrl("https://8.8.8.8/"), "https://8.8.8.8/");
  assert.equal(publicUrl("https://[2606:4700:4700::1111]/"), "https://[2606:4700:4700::1111]/");
  for (const url of ["http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1"]) {
    assert.throws(() => publicUrl(url), /不允许/);
  }
});

test("rejects private and special hosts, credentials and unsupported schemes", () => {
  for (const url of ["file:///a", "javascript:alert(1)", "https://u:p@example.com", "http://localhost", "http://localhost.", "http://server", "http://site.local", "http://a.localhost", "http://192.168.2.1", "http://10.2.0.1", "http://172.31.0.1", "http://169.254.169.254", "http://100.64.0.1", "http://0.0.0.0", "http://224.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fd00::1]", "http://[fe80::1]", "http://[2001:db8::1]", "http://[2002:a00:1::]"]) {
    assert.throws(() => publicUrl(url), Error, url);
  }
});

test("extracts CJK article, title, headings and evidence-bearing links without scripts or menus", () => {
  const result = extractWebDocument(article, "https://example.com/article#start");
  assert.equal(result.url, "https://example.com/article");
  assert.match(result.title, /知识图谱基础/);
  assert.match(result.text, /每一条知识关系/);
  assert.doesNotMatch(result.text, /菜单项|隐私政策|remoteScriptExecuted/);
  assert.ok(result.headings.includes("关系与证据"));
  assert.deepEqual(result.links.map((link) => link.url), ["https://example.com/evidence"]);
  assert.match(result.links[0].quote, /来源判断的方法/);
  assert.equal(result.truncated, false);
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.equal((globalThis as Record<string, unknown>).remoteScriptExecuted, undefined);
});

test("truncation is explicit and later evidence is excluded", () => {
  const first = '第一段保留原始知识信息。'.repeat(100), second = '第二段完整知识正文。'.repeat(120);
  const html = `<html><head><title>正文</title></head><body class="mw-parser-output"><p>${first}</p><p>${second}</p><h2>不能留下的孤立标题</h2>
    <p>这个后续<a href="https://example.com/late">排除的知识链接</a>仅在没有保留的第三段正文中出现。${'后续正文。'.repeat(500)}</p></body></html>`;
  const result = extractWebDocument(html, "https://example.com/article", 2000);
  assert.ok(articleBodyTextChars(result.article) >= 2000);
  assert.equal(result.text, `${first}\n\n${second}`);
  assert.equal(result.truncated, true);
  assert.equal(result.links.length, 0);
  assert.ok(!result.headings.includes('不能留下的孤立标题'));
});

test("fails closed for oversized, short and invalid extraction input", () => {
  assert.throws(() => extractWebDocument("a".repeat(2 * 1024 * 1024 + 1), "https://example.com"), /2 MB/);
  assert.throws(() => extractWebDocument("<html><body>请登录</body></html>", "https://example.com"), /登录.*动态/);
  assert.throws(() => extractWebDocument(article, "https://example.com", 0), /正文长度/);
  for (const target of [80, 1999, 1000001, 2000.5, Infinity]) {
    assert.throws(() => extractWebDocument(article, "https://example.com", target), /2000.*1000000/);
  }
});

test("fetch validates host before transport and rejects HTTP/MIME failures", async () => {
  let called = false;
  await assert.rejects(fetchWebDocument("http://10.0.0.1", async () => { called = true; return { text: article, status: 200 }; }), /不允许/);
  assert.equal(called, false);
  await assert.rejects(fetchWebDocument("https://example.com", async () => ({ text: article, status: 403 })), /HTTP 403/);
  await assert.rejects(fetchWebDocument("https://example.com", async () => ({ text: article, status: 302 })), /HTTP 302/);
  await assert.rejects(fetchWebDocument("https://example.com", async () => ({ text: article, status: 200, headers: { "Content-Type": "application/pdf" } })), /仅支持 HTML/);
  await assert.rejects(fetchWebDocument("https://example.com", async () => ({ text: "not html", status: 200 })), /HTML/);
  const document = await fetchWebDocument("https://example.com", async () => ({ text: article, status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  assert.match(document.text, /知识图谱/);
});

test("abort is checked before and after injected transport", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(fetchWebDocument("https://example.com", async () => { assert.fail("transport must not run"); }, before.signal), { name: "AbortError" });
  const during = new AbortController();
  await assert.rejects(fetchWebDocument("https://example.com", async () => { during.abort(); return { status: 200, text: article }; }, during.signal), { name: "AbortError" });
  const hanging = new AbortController();
  await assert.rejects(fetchWebDocument("https://example.com", () => {
    queueMicrotask(() => hanging.abort());
    return new Promise(() => {});
  }, hanging.signal), { name: "AbortError" });
});

const wikiArticle = `<!doctype html><html><head><title>神经网络（生物学） - 维基百科，自由的百科全书</title></head><body>
<nav><a href="https://de.wikipedia.org/wiki/Neuronales_Netz">Deutsch</a></nav><h1 id="firstHeading">神经网络（生物学）</h1>
<div id="mw-content-text"><div class="mw-parser-output">
<div class="hatnote">请查看另一个同名主题，这个消歧导航不属于正文。</div>
<table class="infobox"><tr><td><a href="/wiki/Noise">模板噪声</a>这些信息不属于本次选择的正文证据。</td></tr></table>
<div class="toc"><a href="#History">1 历史</a></div><div class="ambox">维护提示需要编辑。</div>
<p>生物学中的神经网络由互相连接的神经元组成，通过<a href="/wiki/突触#结构">突触</a>传递信息。它是研究神经系统组织方式与功能的重要概念，不能与同名人工计算模型混为一谈。这些结构能够支持信息加工以及学习和记忆等生物过程。<sup class="reference"><a href="#cite_note-1">[1]</a></sup></p>
<p>知识正文中出现<a href="/wiki/Special:Search">检索</a>、<a href="/wiki/Category:Neuroscience">分类</a>、<a href="/wiki/帮助:目录">帮助</a>、<a href="/w/index.php?title=Neuron&action=edit">编辑内容</a>、<a href="/wiki/Neuron?oldid=7">旧版</a>和<a href="/wiki/Arbitrary">123</a>，这些站点资源与编号不能成为知识节点。</p>
<div class="mw-heading mw-heading2"><h2>参考文献</h2><span class="mw-editsection">[编辑]</span></div>
<ol><li><a href="https://example.org/reference">参考书目噪声</a>这一书目段落不能被误识别为正文关系证据。</li></ol>
<div class="mw-heading mw-heading2"><h2>References in linguistics</h2><span class="mw-editsection">[edit]</span></div>
<p>References in linguistics is a genuine explanatory section. Its actual contents remain available despite sharing a prefix with an ancillary heading.</p>
<h2>外部链接</h2><ul><li><a href="https://example.org/external">资源导航噪声</a>这段导航说明不属于文章正文关系。</li></ul>
<div class="navbox">导航盒噪声与其他语言 English Français</div><div class="license">版权页脚噪声</div>
</div><div>非文章容器中的噪声</div></div></body></html>`;

test("MediaWiki uses article root, clean h1 title and knowledge links, preserving a real next section", () => {
  const out = extractWebDocument(wikiArticle, "https://zh.wikipedia.org/wiki/神经网络_(生物学)");
  assert.equal(out.title, "神经网络(生物学)");
  assert.equal(out.sourceTitle, "神经网络（生物学） - 维基百科，自由的百科全书");
  assert.ok(out.text.startsWith("生物学中的神经网络"));
  assert.match(out.text, /actual contents remain available/);
  assert.doesNotMatch(out.text, /模板噪声|参考书目噪声|资源导航噪声|导航盒噪声|版权页脚噪声|非文章容器|维护提示|消歧导航|\[1\]|\[edit\]/);
  assert.deepEqual(out.headings, ["References in linguistics"]);
  assert.deepEqual(out.links.map((link) => link.label), ["突触"]);
  assert.equal(out.links[0].url, "https://zh.wikipedia.org/wiki/%E7%AA%81%E8%A7%A6");
  assert.match(out.links[0].quote, /神经网络.*突触.*研究神经系统/);
});

test("Parsoid nested ancillary sections are removed without consuming genuine subsections", () => {
  const html = `<html><head><title>Brain - Wikipedia</title></head><body class="mw-parser-output">
  <section data-mw-section-id="0"><p>The brain is studied by neuroscience. This opening explanatory paragraph contains sufficient real prose for a bounded knowledge extraction test.</p></section>
  <section data-mw-section-id="1"><h2>Neural systems</h2><section><h3>Circuits</h3><p>These real circuits and explanatory paragraphs must remain present in the retained article text and are useful to the reader.</p></section></section>
  <section data-mw-section-id="2"><h2>References</h2><section><h3>Books</h3><p>Book reference noise must disappear with its ancestor ancillary section.</p></section></section>
  <section data-mw-section-id="3"><h2>Applications</h2><p>This genuine section appears after the reference section and must not accidentally disappear during section cleanup.</p></section></body></html>`;
  const out = extractWebDocument(html, "https://en.wikipedia.org/wiki/Brain");
  assert.equal(out.title, "Brain");
  assert.match(out.text, /real circuits.*explanatory paragraphs/);
  assert.match(out.text, /genuine section appears after/);
  assert.doesNotMatch(out.text, /Book reference noise|Books|References/);
  assert.deepEqual(out.headings, ["Neural systems", "Circuits", "Applications"]);
});

test("real Wikipedia fixtures retain source-backed knowledge without skin, language or reference noise", () => {
  for (const [file, page, first, expected] of [
    ["wikipedia-knowledge-graph", "Knowledge_Graph", /^A knowledge graph/, "knowledge graph"],
    ["wikipedia-google-knowledge-graph", "Knowledge_Graph_(Google)", /^The Knowledge Graph/, "knowledge base"],
    ["wikipedia-neuroscience", "Neuroscience", /^Neuroscience is/, "nervous system"],
  ] as const) {
    const html = readFileSync(new URL(`./fixtures/${file}.html`, import.meta.url), "utf8");
    const out = extractWebDocument(html, `https://en.wikipedia.org/wiki/${page}`, 24000);
    assert.doesNotMatch(out.title, /Wikipedia/);
    assert.match(out.sourceTitle!, /Wikipedia/);
    assert.match(out.text, first);
    assert.doesNotMatch(out.text, /Jump to content|Create account|Toggle the table of contents|move to sidebar|Privacy policy|\[edit\]/);
    assert.ok(out.links.some((link) => link.label.toLowerCase() === expected), file);
    assert.ok(out.links.every((link) => !/^\[?\d+\]?$/.test(link.label) && !/Deutsch|Français|Español|العربية|日本語|中文/.test(link.label)), file);
    assert.ok(out.links.every((link) => !/(?:Special|Help|File|Category|Wikipedia|Template):/i.test(decodeURIComponent(link.url))), file);
    const retained = out.text.replace(/\s+/g, " ");
    assert.ok(out.links.every((link) => retained.includes(link.quote) && link.quote.includes(link.label)), file);
    assert.ok(out.links.length > 0 && out.links.length <= 100);
  }
});

test("fetch fourth argument controls retained evidence length while default remains compatible", async () => {
  const transport = async () => ({ status: 200, text: wikiArticle, headers: { "Content-Type": "text/html" } });
  const out = await fetchWebDocument("https://zh.wikipedia.org/wiki/神经网络", transport, undefined, 2000);
  const full = extractWebDocument(wikiArticle, "https://zh.wikipedia.org/wiki/神经网络");
  assert.equal(out.text, full.text, 'a short source stays complete without invented padding');
  assert.equal(out.truncated, false);
  assert.equal(out.links.length, 1);
  await assert.rejects(fetchWebDocument("https://example.com", transport, undefined, 0), /正文长度/);
});

test('a 2000-character target preserves real article paragraphs rather than a short preview', () => {
  const html = readFileSync(new URL('./fixtures/wikipedia-neuroscience.html', import.meta.url), 'utf8');
  const out = extractWebDocument(html, 'https://en.wikipedia.org/wiki/Neuroscience', 2000);
  const full = extractWebDocument(html, 'https://en.wikipedia.org/wiki/Neuroscience', 200000);
  assert.ok(articleBodyTextChars(out.article) >= 2000);
  assert.ok(out.truncated);
  assert.deepEqual(out.article.blocks, full.article.blocks.slice(0, out.article.blocks.length));
  assert.notEqual(out.article.blocks.at(-1)?.type, 'heading');
  assert.ok(full.text.startsWith(out.text));
  assert.ok(out.links.every(link => out.text.replace(/\s+/g, ' ').includes(link.quote)));
});

test('a long first paragraph stays complete and short originals keep all paragraphs', () => {
  const long = '源网页单个长段落也必须完整。'.repeat(180);
  const html = `<html><head><title>长段</title></head><body class="mw-parser-output"><p>${long}</p><h2>后续标题</h2><p>后续正文。</p></body></html>`;
  const out = extractWebDocument(html, 'https://example.com/long', 2000);
  assert.equal(out.text, long);
  assert.ok(out.article.textChars > 2000);
  assert.ok(out.article.textChars <= 1_000_000);
  assert.ok(out.truncated);
  const short = extractWebDocument(article, 'https://example.com/short', 2000);
  assert.equal(short.truncated, false);
  assert.equal(short.article.textChars, short.article.totalTextChars);
  assert.ok(articleBodyTextChars(short.article) < 2000);
  assert.match(short.text, /这些链接不应被保留/);
});

test('hard capacity cannot silently turn a page into an empty or subminimum success', async () => {
  const prose = '完整段落知识内容。'.repeat(250);
  const html = `<html><head><title>容量</title></head><body class="mw-parser-output"><h2>这不应成为空正文</h2><p>${prose}</p></body></html>`;
  assert.throws(() => extractWebDocument(html, 'https://example.com/capacity', 2000, 2000), /完整段落.*2000.*容量/);
  const transport = async () => ({ status: 200, text: html, headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchWebDocument('https://example.com/capacity', transport, undefined, 2000, 2000), /完整段落.*容量/);
  const source = `<html><head><title>超长</title></head><body class="mw-parser-output"><p>${'x'.repeat(1_000_001)}</p></body></html>`;
  assert.throws(() => extractWebDocument(source, 'https://example.com/oversized-paragraph', 2000), /完整段落.*容量/);
  assert.throws(() => extractWebDocument(html, 'https://example.com/capacity', 2000, 1_000_001), /正文容量上限/);
});

test('headings alone cannot pass readable-source or minimum-body checks', () => {
  const html = `<html><head><title>目录</title></head><body class="mw-parser-output"><h2>${'目录'.repeat(1200)}</h2><p>请登录。</p></body></html>`;
  assert.throws(() => extractWebDocument(html, 'https://example.com/login', 2000), /可提取正文不足/);
});

test('empty structural separators cannot pass readable-source checks or produce an empty success', () => {
  const empty = `<html><head><title>空表格</title></head><body class="mw-parser-output"><table><tr>${'<td> </td>'.repeat(2500)}</tr></table><pre>${' \n '.repeat(1000)}</pre></body></html>`;
  assert.throws(() => extractWebDocument(empty, 'https://example.com/empty-structures', 2000), /可提取正文不足/);
  const sparse = `<html><head><title>稀疏表格</title></head><body class="mw-parser-output"><table><tr><td>唯一正文</td>${'<td></td>'.repeat(2500)}</tr></table></body></html>`;
  assert.throws(() => extractWebDocument(sparse, 'https://example.com/sparse-table', 2000), /可提取正文不足/);
});

test('leading list and table separators do not satisfy the minimum source body', () => {
  for (const structure of [`<ul>${'<li>x</li>'.repeat(1001)}</ul>`, `<table><tr>${'<td>x</td>'.repeat(1001)}</tr></table>`]) {
    const html = `<html><head><title>原文阅读</title></head><body class="mw-parser-output">${structure}<blockquote>${'补'.repeat(1000)}</blockquote><p>后续段落。</p></body></html>`;
    const result = extractWebDocument(html, 'https://example.com/structured-body', 2000);
    assert.equal(articleBodyTextChars(result.article), 2001);
    assert.equal(result.article.blocks.length, 2);
    assert.equal(result.article.blocks[1].type, 'quote');
    assert.equal(result.article.totalBodyTextChars, 2001 + '后续段落。'.length);
    assert.ok(result.truncated);
    assert.doesNotMatch(result.text, /后续段落/);
  }
});

test('a short page with an empty final section keeps all prose without a truncation warning', () => {
  const prose = '短源正文应当完整保留。'.repeat(20);
  const html = `<html><head><title>短文</title></head><body class="mw-parser-output"><p>${prose}</p><h2>没有正文的小节</h2><h3>空子标题</h3></body></html>`;
  const result = extractWebDocument(html, 'https://example.com/short-empty-section', 2000);
  assert.equal(result.text, prose);
  assert.equal(articleBodyTextChars(result.article), prose.length);
  assert.equal(result.article.totalBodyTextChars, prose.length);
  assert.equal(result.article.textChars, result.article.totalTextChars);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.headings, []);
});

test('Chinese citation sections and consent overlays are cleaned without deleting genuine explanation', () => {
  const prose = '真实知识正文解释定义与应用，保留详细说明供读者核查。'.repeat(8);
  const html = `<html><head><title>引文</title></head><body><h1 id="firstHeading">引文</h1><div class="mw-parser-output">
    <div role="dialog">接受 Cookie <a href="https://example.org/consent">追踪许可</a></div>
    <p>${prose}</p><h2>引用</h2><p>ISBN 978-1-234567-89-0 与 DOI 编号只属于书目记录。</p>
    <h2>引用的学术意义</h2><p>本节说明学术引用如何帮助读者追踪证据，这是正常的知识内容。</p></div></body></html>`;
  const result = extractWebDocument(html, 'https://zh.wikipedia.org/wiki/引文');
  assert.doesNotMatch(result.text, /Cookie|ISBN|DOI|书目记录/);
  assert.match(result.text, /学术引用如何帮助读者追踪证据/);
  assert.deepEqual(result.headings, ['引用的学术意义']);
});
