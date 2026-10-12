import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { articleBodyTextChars, articlePlainText, articleTextSegments, extractArticleContent, renderArticleContent, safeArticleFormula } from '../src/article';
import { extractWebDocument } from '../src/web';

Object.assign(globalThis, { DOMParser });
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const page = (body: string) => `<html><head><title>方差 - 维基百科，自由的百科全书</title></head><body><h1 id="firstHeading">方差</h1><div class="mw-parser-output">${body}</div></body></html>`;
const lead = '方差描述随机变量相对均值的离散程度，公式是定义和概率分布表格不可缺少的原始内容。'.repeat(3);
const image = (source: string) => `<img class="mwe-math-fallback-image-inline" src="https://assets.example.com/math.svg" srcset="https://assets.example.com/math@2x.svg 2x" alt="${escape(source)}">`;
const formula = (source: string) => `<span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none" aria-hidden="true"><math alttext="${escape(source)}"><semantics><mrow><mi>duplicated-rendering</mi></mrow><annotation encoding="application/x-tex">${escape(source)}</annotation></semantics></math></span>${image(source)}</span>`;
const parse = (body: string) => new DOMParser().parseFromString(`<html><body><article>${body}</article></body></html>`, 'text/html').querySelector('article')! as unknown as Element;

test('hidden MediaWiki MathML and its image fallback preserve exactly one readable native formula', () => {
  const source = '\\operatorname{Var}(X)=\\operatorname{E}[(X-\\mu)^2]';
  const out = extractWebDocument(page(`<p>${lead}</p><p>方差的定义是 ${formula(source)}。</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.equal(out.text.split(source).length - 1, 1);
  assert.doesNotMatch(out.text, /duplicated-rendering|assets\.example\.com|math@2x/);
  assert.ok(articleBodyTextChars(out.article) >= lead.length + source.length);
  assert.equal(out.truncated, false);
  const rendered = renderArticleContent(out.article);
  assert.ok(rendered.includes(`$${source}$`));
  assert.deepEqual(out.article.formulas, [source]);
  assert.doesNotMatch(rendered, /<math|<img|display:|aria-hidden/);
});

test('only source formula spans render, plain prose and unknown TeX remain inert', () => {
  const source = '\\frac{a}{b}';
  const article = extractArticleContent(parse(`<p>公式 <math alttext="${escape(source)}"></math>；普通 $x$ 和 [[笔记]] 仍是原文。<math alttext="\\unknown{v}"></math></p>`), 2000);
  const output = renderArticleContent(article);
  assert.ok(output.includes(`$${source}$`));
  assert.ok(output.includes('\\$x\\$'));
  assert.ok(output.includes('\\[\\[笔记\\]\\]'));
  assert.ok(output.includes('\\\\unknown\\{v\\}'));
  assert.deepEqual(articleTextSegments('extra x xylophone x2', ['x']), [
    {text:'extra '}, {text:'x',math:true}, {text:' xylophone x2'},
  ]);
});

test('formula macros, resources, links, delimiters and oversized inputs fall back to source text', () => {
  for (const source of ['\\href{https://example.org}{click}', '\\url{file:///secret}', '\\require{html}',
    '\\def\\x{content}', '\\includegraphics{https://example.org/image}', '\\htmlClass{hidden}{x}',
    '\\begin{html}x\\end{html}', 'x$y', 'x%%hidden', '<script>bad</script>', '\\frac{a}{b', 'x'.repeat(4097)]) {
    assert.equal(safeArticleFormula(source), false, source.slice(0, 100));
    assert.deepEqual(articleTextSegments(`原文 ${source}`, [source]), [{text:`原文 ${source}`}]);
  }
  assert.equal(safeArticleFormula('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), true);
  assert.equal(safeArticleFormula('\\operatorname{Var}(X)=\\frac{1}{n}\\sum_{i=1}^{n}(x_i-\\mu)^2'), true);
});

test('formula table pipes cannot break Markdown columns and excluded formulas stay out of metadata', () => {
  const source = '|x|';
  const out = extractWebDocument(page(`<p>${lead}</p><table><tr><th>定义</th><th>公式</th></tr><tr><td>绝对值</td><td>${formula(source)}</td></tr></table>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.match(renderArticleContent(out.article), /\| 绝对值 \| \$\\vert x\\vert \$ \|/);
  const prefix = '前段。'.repeat(800);
  const excluded = extractWebDocument(page(`<p>${prefix}</p><p>${formula('\\sigma^2')} 未保留。</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.equal(excluded.article.formulas, undefined);
  assert.equal(articleBodyTextChars(excluded.article), prefix.length);
});

test('formula cells remain populated while ordinary image alt and tracker resources are omitted', () => {
  const source = '\\sigma^{2}';
  const out = extractWebDocument(page(`<p>${lead}</p><img src="https://assets.example.com/ad.png" alt="广告和不应生成的节点">
    <table><tr><th>概率分布</th><th>方差</th></tr><tr><td>正态分布</td><td>${formula(source)}</td></tr><tr><td>泊松分布</td><td>${image('\\lambda')}</td></tr></table>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  const table = out.article.blocks.find(block => block.type === 'table');
  assert.ok(table && table.type === 'table');
  assert.deepEqual(table.rows, [['概率分布', '方差'], ['正态分布', source], ['泊松分布', '\\lambda']]);
  assert.doesNotMatch(out.text, /广告|assets\.example\.com/);
  assert.match(renderArticleContent(out.article), /正态分布.*sigma/);
});

test('TeX annotations require the right encoding and take precedence over MathML display duplicates', () => {
  const source = '\\frac{1}{n}\\sum_{i=1}^{n}(x_i-\\mu)^2';
  const dom = parse(`<p>计算 <math><semantics><mrow><mi>duplicate</mi></mrow><annotation encoding="text/html">错误的 HTML 元数据</annotation><annotation encoding="APPLICATION/X-TEX; charset=utf-8">${escape(source)}</annotation></semantics></math> 的结果。</p>`);
  const before = dom.outerHTML;
  const out = extractArticleContent(dom, 2000);
  assert.equal(articlePlainText(out), `计算 ${source} 的结果。`);
  assert.equal(dom.outerHTML, before, 'direct article extraction is still read-only');
  assert.doesNotMatch(articlePlainText(out), /duplicate|错误的 HTML/);
  const withoutTeX = extractArticleContent(parse('<p>公式 <math><semantics><mfrac><mi>a</mi><mi>b</mi></mfrac><annotation encoding="text/html">不是公式</annotation></semantics></math>。</p>'), 2000);
  assert.equal(articlePlainText(withoutTeX), '公式 \\frac{a}{b} 。');
});

test('Parsoid extension source metadata and math image alternatives are retained without external assets', () => {
  const source = '\\mathbb{V}(X)';
  const metadata = escape(JSON.stringify({ name: 'math', body: { extsrc: source } }));
  const out = extractWebDocument(page(`<p>${lead}</p><p>符号 <span typeof="mw:Extension/math" data-mw="${metadata}"><span aria-hidden="true"></span></span>，另一个符号 ${image('s^{2}')}。</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.ok(out.text.includes(source));
  assert.ok(out.text.includes('s^{2}'));
  assert.doesNotMatch(out.text, /extsrc|data-mw|assets\.example\.com/);
});

test('formula attribute text containing src assignments or angle signs is not stripped as an asset', () => {
  const source = 'x > y, \\operatorname{src}=value';
  const out = extractWebDocument(page(`<p>${lead}</p><p>${image(source)}</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.ok(out.text.includes(source));
  assert.doesNotMatch(out.text, /assets\.example\.com/);
});

test('untrusted formula metadata is literal text and cannot introduce vault links, comments or live math', () => {
  const source = 'x$ + [[私密笔记]] + ![资源](file:///secret) + <script>alert(1)</script> + %%隐藏%% + ```dataviewjs';
  const out = extractWebDocument(page(`<p>${lead}</p><p>${formula(source)}</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.ok(out.text.includes(source));
  const markdown = renderArticleContent(out.article);
  assert.doesNotMatch(markdown, /(?<!\\)\[\[|(?<!\\)\$|<script>|%%|```dataviewjs/);
  assert.ok(markdown.includes('\\[\\[私密笔记\\]\\]'));
  assert.ok(markdown.includes('&lt;script&gt;'));
  assert.ok(markdown.includes('&#37;&#37;隐藏&#37;&#37;'));
  assert.ok(markdown.includes('x\\$'));
  assert.equal(out.links.length, 0);
});

test('formula-bearing paragraphs stay complete when crossing the body target', () => {
  const source = '\\operatorname{Var}(X)=\\operatorname{Cov}(X,X)';
  const first = '方差正文。'.repeat(390);
  const out = extractWebDocument(page(`<p>${first}</p><p>这个完整段落包含不可丢失的定义 ${formula(source)}，并在结尾保留全部说明。</p><h2>后续标题</h2><p>未保留的后续正文。</p>`), 'https://zh.wikipedia.org/wiki/方差', 2000);
  assert.ok(articleBodyTextChars(out.article) >= 2000);
  assert.ok(out.text.includes(source));
  assert.match(out.text, /并在结尾保留全部说明。$/);
  assert.ok(out.truncated);
  assert.doesNotMatch(out.text, /后续标题|未保留的后续正文/);
});
