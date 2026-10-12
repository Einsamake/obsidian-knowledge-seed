import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanKnowledgeTitle, isNoiseLabel } from '../src/titles';

test('generated titles strip known publisher suffixes and old IDs, preserving knowledge qualifiers', () => {
  for (const label of ['脑科学-2c6b95a5', '脑科学 - 维基百科，自由的百科全书-web-2c6b95a512345678', '脑科学 - 百度百科', '脑科学 | Wikipedia, the free encyclopedia'])
    assert.equal(cleanKnowledgeTitle(label), '脑科学');
  assert.equal(cleanKnowledgeTitle('神经网络（生物学）'), '神经网络(生物学)');
  assert.equal(cleanKnowledgeTitle('百科全书的历史'), '百科全书的历史');
  assert.equal(cleanKnowledgeTitle('Attention - A New Approach'), 'Attention - A New Approach');
  assert.equal(cleanKnowledgeTitle('IL-6'), 'IL-6');
});

test('navigation, source boilerplate and IDs are filtered without banning actual language topics', () => {
  for (const label of ['2c6b95a5', '维基百科', '参考文献', '编辑源代码', '[12]', 'Template:Navigation', '隐私政策']) assert.equal(isNoiseLabel(label), true, label);
  for (const label of ['英语', '神经科学', '中国科学院', '百科全书史', 'Web3']) assert.equal(isNoiseLabel(label), false, label);
});

test('resource and bibliographic IDs stay out of concept labels without banning identifier subjects', () => {
  for (const label of ['10.1038/s41583-020-00396-5', 'DOI: 10.1007/s00422-019-00812-4',
    'https://doi.org/10.1016/j.neuroimage.2020.116828', '123e4567-e89b-12d3-a456-426614174000',
    'urn:uuid:123e4567-e89b-12d3-a456-426614174000', 'https://example.org/article',
    'C:\\Users\\research\\file.pdf', '../assets/figure.png', '/articles/source.html', 'assets/figure.svg',
    'PMID: 12345678', 'PMCID: PMC1234567', 'PMC1234567', 'ISBN 978-0-321-12742-6', 'arXiv: 2301.12345v2', 'arXiv: cs/9901001'])
    assert.equal(isNoiseLabel(label), true, label);
  for (const label of ['DOI', 'UUID', 'PMID', 'ISBN', 'arXiv', 'HTTP/2', 'TCP/IP', 'IL-6', 'C++', '核糖核酸', 'DNA/RNA'])
    assert.equal(isNoiseLabel(label), false, label);
});
