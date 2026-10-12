import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { articleBodyTextChars, articleGuide, articleOutline, articlePlainText, extractArticleContent, renderArticleContent } from '../src/article';

function root(html: string): Element {
  return new DOMParser().parseFromString(`<html><body><article>${html}</article></body></html>`, 'text/html').querySelector('article')! as unknown as Element;
}

test('structured extraction preserves later sections beyond the leading excerpt', () => {
  const introduction = '网页开头正文讨论知识来源。'.repeat(80);
  const article = extractArticleContent(root(`<h1>知识图谱</h1><p>${introduction}</p><h2>后半段验证</h2><p>后半段保留了关系推理的适用条件。</p>`), 20000);
  assert.equal(article.truncated, false);
  assert.equal(article.textChars, articlePlainText(article).length);
  assert.equal(article.totalTextChars, article.textChars);
  assert.ok(renderArticleContent(article).includes('后半段保留了关系推理的适用条件'));
  assert.ok(articleOutline(article).includes('后半段验证'));
  assert.ok(articleGuide(article).includes('网页开头正文讨论知识来源'));
  assert.ok(articleGuide(article).includes('并非自动总结'));
  assert.ok(!articleGuide(article).includes('关系推理的适用条件'));
});

test('Chinese heading levels, ordered and unordered lists, tables, quotes and code retain source structure', () => {
  const article = extractArticleContent(root(`<h1>标题</h1><h2>方法</h2><h4>子方法</h4><p>正文说明。</p>
    <ul><li>第一项</li><li>第二项</li></ul><ol><li>执行步骤</li><li>核验步骤</li></ol>
    <table><tr><th>条件</th><th>结论</th></tr><tr><td>有效证据</td><td>可追溯</td></tr></table>
    <blockquote><p>原文中的引用。</p></blockquote><pre><code>const 知识 = 1;\n  return 知识;</code></pre>`), 2000);
  assert.deepEqual(article.blocks.map(block => block.type), ['heading','heading','heading','paragraph','list','list','table','quote','code']);
  const markdown = renderArticleContent(article);
  assert.match(markdown, /^### 标题/m);
  assert.match(markdown, /^### 方法/m);
  assert.match(markdown, /^##### 子方法/m);
  assert.match(markdown, /^- 第一项\n- 第二项/m);
  assert.match(markdown, /^1\. 执行步骤\n2\. 核验步骤/m);
  assert.match(markdown, /\| 条件 \| 结论 \|\n\| --- \| --- \|\n\| 有效证据 \| 可追溯 \|/);
  assert.match(markdown, /^> 原文中的引用。/m);
  assert.match(markdown, /```text\nconst 知识 = 1;\n  return 知识;\n```/);
  assert.match(articlePlainText(article), /第一项\n第二项\n\n执行步骤\n核验步骤/);
  assert.match(articlePlainText(article), /条件 结论\n有效证据 可追溯/);
});

test('remote HTML, assets and link targets are omitted and webpage syntax is inert in prose', () => {
  const article = extractArticleContent(root(`<script>globalThis.executed = true;</script><style>.x{}</style><nav>菜单</nav>
    <iframe src="https://example.org/frame"></iframe><img src="https://example.org/tracker.png" alt="图片">
    <p>[[私密笔记]] ![图片](file:///secret) &lt;script&gt; 反斜线\\ %%注释%% &#96;&#96;&#96;dataviewjs</p>
    <p><a href="javascript:alert(1)">可见文字</a><a href="file:///secret">本地锚点</a></p>
    <div hidden>隐藏信息</div><div aria-hidden="true">辅助隐藏</div>`), 2000);
  const markdown = renderArticleContent(article);
  assert.doesNotMatch(markdown, /globalThis\.executed|tracker\.png|javascript:|<script>|<iframe|菜单|隐藏信息|辅助隐藏/);
  assert.ok(markdown.includes('\\[\\[私密笔记\\]\\]'));
  assert.ok(markdown.includes('\\!\\[图片\\]'));
  assert.ok(markdown.includes('&lt;script&gt;'));
  assert.ok(markdown.includes('&#37;&#37;注释&#37;&#37;'));
  assert.ok(markdown.includes('\\`\\`\\`dataviewjs'));
  assert.ok(markdown.includes('可见文字本地锚点'));
  assert.equal((globalThis as Record<string, unknown>).executed, undefined);
});

test('code fences exceed embedded backtick runs and never propagate executable language', () => {
  const code = '```dataviewjs\n[[私密笔记]]\n<script>alert(1)</script>\n````\nconst x = 1;';
  const article = extractArticleContent(root(`<pre><code class="language-dataviewjs">${code.replaceAll('<','&lt;').replaceAll('>','&gt;')}</code></pre>`), 2000);
  const markdown = renderArticleContent(article);
  assert.equal(markdown, `\`\`\`\`\`text\n${code}\n\`\`\`\`\``);
  assert.doesNotMatch(markdown, /^`````dataviewjs/m);
  assert.equal(articlePlainText(article), code);
});

test('target boundaries preserve a complete structural prefix and exact text accounting', () => {
  const html = '<h2>概述</h2><p>正文内容。</p><ul><li>列表甲</li><li>列表乙</li></ul><table><tr><th>术语名称</th><th>释义</th></tr><tr><td>知识 图谱</td><td>实体关系</td></tr></table><h2>未保留的小节</h2><p>后续说明。</p>';
  const full = extractArticleContent(root(html), 2000);
  const text = articlePlainText(full);
  for (let budget=0;budget<text.length;budget++) {
    const article = extractArticleContent(root(html),budget);
    const retained = articlePlainText(article);
    assert.ok(articleBodyTextChars(article) >= Math.min(budget, articleBodyTextChars(full)), `complete block crosses target ${budget}`);
    assert.ok(text.startsWith(retained),`retained text must be the structural prefix at budget ${budget}`);
    assert.deepEqual(article.blocks, full.blocks.slice(0, article.blocks.length));
    assert.notEqual(article.blocks.at(-1)?.type, 'heading', 'a retained title must have following content');
    assert.equal(article.textChars,retained.length);
    assert.equal(article.totalTextChars,text.length);
    assert.equal(article.truncated, retained.length < text.length);
    assert.equal(renderArticleContent(article).includes('正文受字符预算限制'), article.truncated);
    const headings = article.blocks.filter(block=>block.type==='heading');
    if(!headings.some(block=>block.text==='未保留的小节')) assert.ok(!articleOutline(article).includes('[未保留的小节]'));
  }
  assert.equal(extractArticleContent(root(html),text.length).truncated,false);
});

test('complete source blocks preserve surrogate pairs, including tables and guide excerpts', () => {
  const html='<p>中😀文</p><ul><li>甲😀乙</li></ul><table><tr><td>丙😀丁</td><td>😀戊</td></tr></table>';
  const full=articlePlainText(extractArticleContent(root(html),200));
  for(let budget=0;budget<full.length;budget++) {
    const article=extractArticleContent(root(html),budget), retained=articlePlainText(article);
    assert.ok(full.startsWith(retained));
    assert.equal(/[\uD800-\uDBFF]$/.test(retained),false);
  }
  const guide=articleGuide(extractArticleContent(root(`<p>${'中'.repeat(319)}😀结束</p>`),1000));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(guide),false);
});

test('a 2000-character target includes the complete paragraph crossing it and removes later titles', () => {
  const first = '首段正文。'.repeat(240), second = '第二段正文。'.repeat(180);
  const html = `<h1>原始标题</h1><p>${first}</p><h2>解释与条件</h2><p>${second}</p><h2>不应显示的尾部标题</h2><p>后续段落。</p>`;
  const article = extractArticleContent(root(html), 2000);
  assert.ok(articleBodyTextChars(article) >= 2000);
  assert.deepEqual(article.blocks.filter(block => block.type === 'paragraph').map(block => block.text), [first, second]);
  assert.equal(article.totalBodyTextChars, first.length + second.length + '后续段落。'.length);
  assert.ok(article.truncated);
  assert.doesNotMatch(articlePlainText(article), /不应显示的尾部标题|后续段落/);
  assert.doesNotMatch(articleOutline(article), /不应显示的尾部标题/);
  assert.match(renderArticleContent(article), /按完整段落或结构块截断/);
});

test('short originals are retained in full and headings do not satisfy the body target', () => {
  const prose = '短文也必须完整保留原文内容。'.repeat(20);
  const article = extractArticleContent(root(`<h1>${'标题'.repeat(1100)}</h1><p>${prose}</p><h2>次节</h2><p>尾部独有正文。</p>`), 2000);
  assert.equal(article.truncated, false);
  assert.equal(articleBodyTextChars(article), prose.length + '尾部独有正文。'.length);
  assert.match(articlePlainText(article), /尾部独有正文/);
});

test('long first paragraphs remain complete when they cross the target within the hard bound', () => {
  const paragraph = '长段完整正文。'.repeat(33000);
  const article = extractArticleContent(root(`<p>${paragraph}</p><h2>后续小节</h2><p>尾部说明。</p>`), 200000);
  assert.equal(article.textChars, paragraph.length);
  assert.ok(article.textChars > 200000 && article.textChars < 1_000_000);
  assert.deepEqual(article.blocks, [{ type: 'paragraph', text: paragraph }]);
  assert.ok(article.truncated);
});

test('the hard bound refuses half paragraphs and drops the headings of excluded sections', () => {
  const article = extractArticleContent(root(`<p>开头完整。</p><h2>无法保留的小节</h2><h3>子节</h3><p>${'段'.repeat(80)}</p>`), 2000, 50);
  assert.deepEqual(article.blocks, [{ type: 'paragraph', text: '开头完整。' }]);
  assert.ok(article.truncated);
  assert.ok(article.textChars <= 50);
  assert.doesNotMatch(articleOutline(article), /无法保留|子节/);
  const oversized = extractArticleContent(root(`<p>${'段'.repeat(1_000_001)}</p>`), 2000);
  assert.deepEqual(oversized.blocks, []);
  assert.equal(oversized.totalBodyTextChars, 1_000_001);
  assert.ok(oversized.truncated);
});

test('list items, table cells, quotes and code are never cut at the target or hard boundary', () => {
  const item = '完整列表项。'.repeat(180);
  const examples = [
    `<ul><li>${item}</li><li>${item}末项完整。</li></ul>`,
    `<table><tr><th>表头</th><th>解释</th></tr><tr><td>${item}</td><td>${item}末单元格完整。</td></tr></table>`,
    `<blockquote>${item.repeat(2)}引用结尾。</blockquote>`,
    `<pre>${item.repeat(2)}代码结尾。</pre>`,
  ];
  for (const html of examples) {
    const original = extractArticleContent(root(html), 10000);
    const retained = extractArticleContent(root(html + '<p>后续正文。</p>'), 2000);
    assert.deepEqual(retained.blocks, original.blocks);
    assert.ok(articleBodyTextChars(retained) >= 2000);
    assert.ok(retained.truncated);
    const denied = extractArticleContent(root(html), 2000, 1000);
    assert.deepEqual(denied.blocks, []);
  }
});

test('body targets count list and table source characters without serialization separators', () => {
  for (const structure of [
    `<ul>${'<li>x</li>'.repeat(1001)}</ul>`,
    `<table><tr>${'<td>x</td>'.repeat(1001)}</tr></table>`,
  ]) {
    const paragraph = '正文补充。'.repeat(200);
    const article = extractArticleContent(root(`${structure}<p>${paragraph}</p><p>下一段未保留。</p>`), 2000);
    assert.equal(articleBodyTextChars({ blocks: [article.blocks[0]] }), 1001);
    assert.equal(articleBodyTextChars(article), 1001 + paragraph.length);
    assert.equal(article.totalBodyTextChars, 1001 + paragraph.length + '下一段未保留。'.length);
    assert.equal(article.blocks.length, 2, 'generated separators cannot stop extraction before real body reaches the target');
    assert.equal(article.blocks[1].type, 'paragraph');
    assert.ok(article.textChars > articleBodyTextChars(article));
    assert.ok(article.truncated);
    assert.doesNotMatch(articlePlainText(article), /下一段未保留/);
  }
});

test('empty tables and whitespace-only code do not consume the body target or become reading content', () => {
  const paragraph = '真实正文。'.repeat(450);
  const article = extractArticleContent(root(`<table><tr>${'<td> </td>'.repeat(2500)}</tr></table><pre>${' \n '.repeat(1000)}</pre><p>${paragraph}</p>`), 2000);
  assert.deepEqual(article.blocks, [{ type: 'paragraph', text: paragraph }]);
  assert.equal(articleBodyTextChars(article), paragraph.length);
  assert.equal(article.totalBodyTextChars, paragraph.length);
  assert.equal(article.textChars, paragraph.length);
  assert.equal(article.truncated, false);
});

test('short source prose stays complete when empty final headings are removed during cleanup', () => {
  const paragraph = '短文完整正文。'.repeat(20);
  const article = extractArticleContent(root(`<h2>概述</h2><p>${paragraph}</p><h2>空章节</h2><h3>空子章节</h3>`), 2000);
  assert.equal(articleBodyTextChars(article), paragraph.length);
  assert.equal(article.totalBodyTextChars, paragraph.length);
  assert.equal(article.textChars, article.totalTextChars);
  assert.equal(article.truncated, false);
  assert.deepEqual(article.blocks, [{ type: 'heading', level: 2, text: '概述' }, { type: 'paragraph', text: paragraph }]);
  assert.doesNotMatch(renderArticleContent(article), /空章节|空子章节|预算限制/);
  assert.doesNotMatch(articleOutline(article), /空章节|空子章节/);
});

test('heading-only input is empty cleaned content without a false budget truncation', () => {
  const article = extractArticleContent(root('<h2>空章节</h2><h3>空子章节</h3>'), 2000);
  assert.deepEqual(article.blocks, []);
  assert.equal(article.textChars, 0);
  assert.equal(article.totalTextChars, 0);
  assert.equal(article.totalBodyTextChars, 0);
  assert.equal(article.truncated, false);
  assert.doesNotMatch(renderArticleContent(article), /预算限制/);
});

test('outline uses only current-page fragments, caps 60 entries and safely escapes labels', () => {
  const html=Array.from({length:65},(_,index)=>`<h2>第${index+1}节 [[节点]] &lt;标记&gt;</h2><p>正文${index+1}。</p>`).join('');
  const article=extractArticleContent(root(html),20000);
  const outline=articleOutline(article);
  assert.equal(article.outlineTruncated,true);
  assert.equal((outline.match(/\]\(#/g)??[]).length,60);
  assert.ok(outline.includes('其余标题仍在正文中'));
  assert.ok(!outline.includes('第61节'));
  assert.ok(renderArticleContent(article).includes('第65节'));
  assert.doesNotMatch(outline,/\]\((?:file:|https?:|[^#])/);
  assert.ok(outline.includes(encodeURIComponent('第1节 [[节点]] <标记>')));
  assert.ok(outline.includes('\\[\\[节点\\]\\] &lt;标记&gt;'));
});

test('MathML alt text is collected once instead of duplicate TeX annotations', () => {
  const article=extractArticleContent(root('<p>计算 <math alttext="x+y"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow><annotation encoding="application/x-tex">duplicate-latex</annotation></semantics></math> 的结果。</p>'),1000);
  assert.equal(articlePlainText(article),'计算 x+y 的结果。');
  assert.ok(!renderArticleContent(article).includes('duplicate-latex'));
});

test('empty or fully suppressed content reports an honest absent guide and outline', () => {
  const article=extractArticleContent(root('<script>body</script><img src="https://example.org/img"><p></p>'),1000);
  assert.deepEqual(article.blocks,[]); assert.equal(article.textChars,0); assert.equal(article.totalTextChars,0); assert.equal(article.truncated,false);
  assert.match(articleGuide(article),/没有可摘录/); assert.match(articleOutline(article),/没有小节标题/);
});

test('directory fragments encode unmatched parentheses and extraction leaves source DOM unchanged', () => {
  const dom=root('<h2>条件 (未闭合</h2><p>这是要保留的原文段落。</p>');
  const before=dom.outerHTML;
  const article=extractArticleContent(dom,100);
  assert.equal(dom.outerHTML,before);
  assert.equal(articleOutline(article),'  - [条件 (未闭合](#%E6%9D%A1%E4%BB%B6%20%28%E6%9C%AA%E9%97%AD%E5%90%88)');
  assert.equal(renderArticleContent(article),'### 条件 (未闭合\n\n这是要保留的原文段落。');
});

test('wide ragged tables preserve source cells without allocating a padding matrix', () => {
  const rows = [Array.from({length:40}, (_, index) => `列${index}`), ['末尾独有值']];
  const markdown = renderArticleContent({blocks:[{type:'table',rows}],textChars:190,totalTextChars:190,truncated:false});
  assert.match(markdown,/按原始行列顺序展开/);
  assert.match(markdown,/第 40 列：列39/);
  assert.match(markdown,/第 2 行/);
  assert.match(markdown,/末尾独有值/);
  assert.ok(markdown.length < 2000);
});
