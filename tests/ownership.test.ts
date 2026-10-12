import test from 'node:test';
import assert from 'node:assert/strict';
import { managedAliases, managedHeader, managedValue } from '../src/ownership';

test('managed identities accept native single quotes and comments without altering URL fragments',()=>{
  const header=managedHeader("---\r\nknowledge_seed_id: 'concept-a' # retained\r\n# Manual metadata comment\r\ntitle: 'A scientist''s result'\r\nsource: https://example.org/article#section\r\nkind: concept\r\n---\r\nbody")!;
  assert.equal(managedValue(header,'knowledge_seed_id'),'concept-a');
  assert.equal(managedValue(header,'title'),"A scientist's result");
  assert.equal(managedValue(header,'source'),'https://example.org/article#section');
});

test('managed merged IDs survive native property block lists and flow-style YAML string lists',()=>{
  for(const raw of ['["old-a", "old-b", "old-a"]',"['old-a', old-b, old-a] # approved",'\n  - old-a\n  - "old-b"\n  - \'old-a\'','\r\n- old-a\r\n- old-b']) {
    const header=managedHeader(`---\nknowledge_seed_id: owner\nknowledge_seed_merged_ids: ${raw}\ncustom_manual: keep\n---\nbody`)!;
    assert.deepEqual(managedAliases(header),['old-a','old-b']);
  }
});

test('duplicate properties, complex scalars and invalid alias identities cannot claim files',()=>{
  assert.throws(()=>managedHeader('---\nknowledge_seed_id: first\nknowledge_seed_id: second\n---\n'),/重复/);
  for(const raw of ['[owner]','|\n  owner','"owner" trailing',"'owner' trailing"]) {
    assert.throws(()=>managedValue(managedHeader(`---\nknowledge_seed_id: ${raw}\n---\n`)!,'knowledge_seed_id'),/无效|不支持/);
  }
  for(const raw of ['[old-a, https://example.org]','[old-a, null]','\n  - old-a\n  - "bad:id"']) {
    const header=managedHeader(`---\nknowledge_seed_id: owner\nknowledge_seed_merged_ids: ${raw}\n---\n`)!;
    assert.throws(()=>managedAliases(header),/无效/);
  }
});
