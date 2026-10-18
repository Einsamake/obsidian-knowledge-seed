import test from 'node:test';
import assert from 'node:assert/strict';
import { excludedContent, plainSearchSnippet, scoreCandidate, scoreSearchCandidate, searchQueries } from '../src/relevance';

test('brain-science relevance uses actual topic context and suppresses language navigation', () => {
  assert.equal(scoreCandidate('预测编码', '预测编码理论', '神经系统使用预测编码处理感觉信息', { relevance: 'strict' }).accepted, true);
  assert.equal(scoreCandidate('预测编码', '神经科学', '预测编码是神经科学中的一种理论', { relevance: 'balanced' }).accepted, true);
  assert.equal(scoreCandidate('预测编码', '神经科学', '预测编码是神经科学中的一种理论', { relevance: 'strict' }).accepted, false);
  assert.equal(scoreCandidate('预测编码', '神经科学', '脑科学介绍感觉输入', { relevance: 'balanced' }).accepted, false);
  for (const relevance of ['strict', 'balanced', 'broad'] as const)
    assert.equal(scoreCandidate('预测编码', 'English', '预测编码页面中的语言导航', { relevance }).accepted, false);
  assert.equal(scoreCandidate('脑科学', '英文', '脑科学定义附带英文名称', { relevance: 'balanced' }).accepted, false);
  assert.equal(scoreCandidate('语言学', '英语', '语言学研究英语的结构', { relevance: 'balanced' }).accepted, true);
});

test('English lexical scoring does not mistake substring lookalikes for related topics', () => {
  assert.equal(scoreCandidate('brain', 'Brainstorming', 'Creative group ideas', { relevance: 'balanced' }).accepted, false);
  assert.equal(scoreCandidate('brain', 'Brain stem', 'Neural anatomy', { relevance: 'strict' }).accepted, true);
});

test('cross-language matches require a supplied equivalent instead of invented translation', () => {
  assert.equal(scoreCandidate('预测编码', 'Predictive coding', 'A neuroscience theory', { relevance: 'balanced' }).accepted, false);
  assert.equal(scoreCandidate('预测编码', 'Predictive coding', 'A neuroscience theory', { relevance: 'strict', searchTerms: ['predictive coding'] }).accepted, true);
});

test('exclude words apply to candidate names without rejecting a relevant paragraph mentioning them', () => {
  assert.equal(excludedContent('神经科学食谱资料', ['食谱']), true);
  assert.equal(scoreCandidate('预测编码', '预测误差', '预测编码有别于烹饪和食谱', { excludeTerms: ['食谱'] }).accepted, true);
  assert.equal(scoreCandidate('预测编码', '预测编码食谱', '预测编码', { relevance: 'broad', excludeTerms: ['食谱'] }).accepted, false);
});

test('mode selection produces visibly different candidate sets on the same source context', () => {
  const candidates = [
    ['预测编码理论', '这段介绍预测编码'],
    ['预测误差', '预测编码理论明确引用预测误差'],
    ['烹饪方法', '这里说明烹饪方法'],
    ['English', '预测编码页面的语言入口'],
  ];
  const accepted = (relevance: 'strict' | 'balanced' | 'broad') => candidates
    .filter(([title, context]) => scoreCandidate('预测编码', title, context, { relevance }).accepted).map(([title]) => title);
  assert.deepEqual(accepted('strict'), ['预测编码理论']);
  assert.deepEqual(accepted('balanced'), ['预测编码理论', '预测误差']);
  assert.deepEqual(accepted('broad'), ['预测编码理论', '预测误差', '烹饪方法']);
});

test('search expansion is bounded, preserves user terms and makes snippets plain API text', () => {
  assert.deepEqual(searchQueries('predictive coding', ['预测编码', 'brain', 'perception', 'neural', 'ignored']),
    ['predictive coding', '"predictive coding"', '预测编码', 'brain', 'perception', 'neural']);
  assert.equal(plainSearchSnippet('<span class="searchmatch">预测编码</span>&nbsp;&amp; 感觉输入'), '预测编码 & 感觉输入');
});

test('balanced search recovers Chinese method topics without weakening exact entity matching', () => {
  for (const title of ['流形','流形学习']) {
    const ranked=scoreSearchCandidate('流形方法',title,'局部邻域与内在几何结构。');
    assert.equal(ranked.accepted,true);assert.equal(ranked.expandedTerm,'流形');
  }
  assert.equal(scoreSearchCandidate('流形技术','流形学习','').accepted,true);
  assert.equal(scoreSearchCandidate('流形方法','烹饪','').accepted,false);
  assert.equal(scoreSearchCandidate('流形方法','流形学习','',{relevance:'strict'}).accepted,false);
  assert.equal(scoreCandidate('流形方法','流形学习','').accepted,false,'exact body matching must remain unchanged');
  assert.equal(scoreSearchCandidate('流形方法','流形方法研究','').expandedTerm,undefined);
});

test('core matching preserves exclusions, navigation rejection and supplied language equivalents', () => {
  assert.equal(scoreSearchCandidate('流形方法','流形学习','',{excludeTerms:['学习']}).accepted,false);
  assert.equal(scoreSearchCandidate('英文方法','英文','').accepted,false);
  assert.equal(scoreSearchCandidate('Brain methods','Brain','').accepted,false);
  assert.equal(scoreSearchCandidate('流形方法','Manifold learning','').accepted,false);
});

test('inline search highlights preserve Chinese words and block tags retain boundaries', () => {
  assert.equal(plainSearchSnippet('微<span class="searchmatch">分</span>几何'),'微分几何');
  assert.equal(plainSearchSnippet('predic<strong>tive</strong> coding'),'predictive coding');
  assert.equal(plainSearchSnippet('first<p>second</p><p>third</p>'),'first second third');
});

test('highlighted context does not discard a related result for a multi-character Chinese topic', () => {
  assert.equal(scoreSearchCandidate('微分几何','数学','研究微<span class="searchmatch">分</span>几何的结构。').accepted,true);
});
