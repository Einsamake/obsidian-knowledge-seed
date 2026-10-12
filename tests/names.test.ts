import test from 'node:test';
import assert from 'node:assert/strict';
import { planNameCleanup } from '../src/names';

test('cleanup changes noisy generated names only and does not overwrite an occupied title', () => {
  const notes = [
    { path: 'Maps/网页/脑科学 - 维基百科-web-1234567812345678.md', title: '脑科学 - 维基百科', managedId: 'web-1234567812345678' },
    { path: 'Maps/概念/脑科学-2c6b95a5.md', title: '脑科学', managedId: 'concept-2c6b95a5' },
    { path: 'Maps/概念/我的自定义名称.md', title: '旧标题', managedId: 'concept-abcd' },
    { path: 'Maps/概念/神经网络（生物学）.md', title: '旧标题', managedId: 'concept-efgh' },
  ];
  const changes = planNameCleanup(notes, new Set([...notes.map(n => n.path), 'Maps/概念/脑科学.md']));
  assert.equal(changes.length, 2);
  assert.equal(changes.find(c => c.from.includes('/网页/'))?.to, 'Maps/网页/脑科学.md');
  assert.equal(changes.find(c => c.from.includes('/概念/'))?.to, 'Maps/概念/脑科学 (2).md');
  assert.ok(changes.every(c => !/[a-f0-9]{8}/i.test(c.to)));
});
