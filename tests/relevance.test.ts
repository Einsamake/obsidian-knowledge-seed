import test from 'node:test';
import assert from 'node:assert/strict';
import { excludedContent, plainSearchSnippet, scoreCandidate, searchQueries } from '../src/relevance';

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
