import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOptions, defaults, generateGraph, type EngineAdapter } from '../src/engine';
import { applyPreset, cloneDiscoveryConfig, cloneRunOptions, numericRules, presets, validateDiscovery, validateNumericInput, type RunOptions } from '../src/workflow';

const options = (): RunOptions => ({ ...defaults, graphDepth: 3, searchTerms: ['神经科学'], excludeTerms: ['学院'], excludeFolders: ['Templates'] });

test('adaptive URL tasks use a reading pace independently of legacy manual page limits', () => {
  const automatic = {...options(), readingMode:'adaptive' as const, readingPace:'fast' as const,maxPages:0};
  assert.deepEqual(validateDiscovery({kind:'url',value:'https://example.org/article'},automatic),[]);
  assert.ok(validateDiscovery({kind:'topic',value:'主题'},{...automatic,readingMode:'unknown'}).some(error=>error.includes('动态')));
  assert.ok(validateDiscovery({kind:'topic',value:'主题'},{...automatic,readingPace:['fast']}).some(error=>error.includes('读取节奏')));
  assert.equal(clampOptions({readingMode:'adaptive',readingPace:'deep'}).readingPace,'deep');
  assert.equal(clampOptions({readingMode:'unknown' as never,readingPace:'invalid' as never}).readingMode,'manual');
});

test('editing a run or copied saved configuration cannot mutate defaults or array values', () => {
  const current = { ...options(), outputFolder: 'My Maps', exportCanvas: false };
  const copy = cloneRunOptions(current);
  copy.searchTerms.push('睡眠'); copy.excludeTerms[0] = '公司'; copy.excludeFolders.push('Private'); copy.depth = 7;
  assert.deepEqual(current.searchTerms, ['神经科学']);
  assert.deepEqual(current.excludeTerms, ['学院']);
  assert.deepEqual(current.excludeFolders, ['Templates']);
  assert.equal(current.depth, 1); assert.equal(copy.outputFolder, 'My Maps');
  const source = { seed: { kind: 'topic' as const, value: '脑科学' }, options: current };
  const config = cloneDiscoveryConfig(source);
  config.seed.value = '语言学'; config.options.searchTerms.push('语言');
  assert.equal(source.seed.value, '脑科学'); assert.deepEqual(source.options.searchTerms, ['神经科学']);
  assert.equal(validateDiscovery(config.seed, JSON.parse(JSON.stringify(config.options))).length, 0);
});

test('strategy settings validate strictly and nested direction rules remain isolated between runs', () => {
  const current={...options(),explorationStrategy:'custom' as const,breadthDecay:0,directionDepthBoost:4,offDirectionDepth:1,
    directionRules:[{term:'Statistics',weight:8,depth:5},{term:'Applied research',weight:3}]};
  assert.deepEqual(validateDiscovery({kind:'topic',value:'Graph'},current),[]);
  const copy=cloneRunOptions(current);copy.directionRules[0].term='Changed';copy.directionRules[0].weight=2;copy.directionRules.push({term:'New',weight:1});
  assert.equal(current.directionRules[0].term,'Statistics');assert.equal(current.directionRules[0].weight,8);assert.equal(current.directionRules.length,2);
  for(const [key,value] of [['explorationStrategy',['custom']],['explorationStrategy','unknown'],['breadthDecay',5],['breadthDecay',0.5],
    ['directionDepthBoost',21],['offDirectionDepth',-1],['offDirectionDepth','2']] as const)
    assert.ok(validateDiscovery({kind:'topic',value:'Graph'},{...current,[key]:value}).length,`${key}: ${String(value)}`);
  for(const rules of [null,{},Array(21).fill({term:'T',weight:1}),[{term:'',weight:1}],[{term:'T',weight:0}],
    [{term:'T',weight:11}],[{term:'T',weight:2.5}],[{term:'T',weight:'2'}],[{term:'T',weight:1,depth:21}],
    [{term:'T',weight:1,depth:null}],[{term:'T',weight:1},{term:'ｔ',weight:2}]])
    assert.ok(validateDiscovery({kind:'topic',value:'Graph'},{...current,directionRules:rules}).some(error=>/方向规则/.test(error)));
  const old={...options()};delete old.explorationStrategy;delete old.breadthDecay;delete old.directionDepthBoost;delete old.offDirectionDepth;delete old.directionRules;
  assert.deepEqual(validateDiscovery({kind:'topic',value:'Graph'},old),[]);
  assert.equal(clampOptions(old).explorationStrategy,'radial');
});

test('all four presets respect limits and preserve user words, language and extension settings', () => {
  const current = { ...options(), wikiLanguage: 'en' as const, searchLanguageMode: 'both' as const, outputFolder: 'My Maps' };
  for (const preset of presets) {
    const run = applyPreset(current, preset.id);
    assert.deepEqual(validateDiscovery({ kind: 'topic', value: '脑科学' }, run), []);
    assert.deepEqual(run.searchTerms, current.searchTerms); assert.notEqual(run.searchTerms, current.searchTerms);
    assert.deepEqual(run.excludeTerms, current.excludeTerms); assert.notEqual(run.excludeTerms, current.excludeTerms);
    assert.deepEqual(run.excludeFolders, current.excludeFolders); assert.notEqual(run.excludeFolders, current.excludeFolders);
    assert.equal(run.wikiLanguage, 'en'); assert.equal(run.searchLanguageMode, 'both'); assert.equal(run.outputFolder, 'My Maps');
    assert.ok(run.maxBodyChars >= 2000, `${preset.id} must retain an adequate body budget`);
    assert.ok(preset.description.includes(run.web ? `${run.maxPages * 3 + 12} 次网络请求` : '不联网'));
  }
  assert.equal(current.maxPages, 5);
  assert.equal(applyPreset(current, 'deep').depth, 3);
  assert.equal(applyPreset(current, 'quick').maxPages, 3);
  assert.throws(() => applyPreset(current, 'typo' as never), /未知/);
});

test('every numeric field rejects blanks, non-integers and out-of-range values without clamping', () => {
  for (const [key, rule] of Object.entries(numericRules)) {
    const field = key as keyof typeof numericRules;
    assert.deepEqual(validateNumericInput(field, String(rule.min)), { value: rule.min });
    assert.deepEqual(validateNumericInput(field, rule.max), { value: rule.max });
    for (const invalid of ['', ' ', null, undefined, true, NaN, Infinity, 1.5, rule.min - 1, rule.max + 1])
      assert.ok(validateNumericInput(field, invalid).error, `${key}: ${String(invalid)}`);
    const invalidOptions = { ...options(), [key]: rule.max + 1 };
    assert.ok(validateDiscovery({ kind: 'note', value: 'Research.md' }, invalidOptions).some(error => error.includes(rule.label)));
  }
});

test('saved low body budgets upgrade to 2000 while valid settings and local-note limits are preserved', () => {
  assert.equal(numericRules.maxBodyChars.min, 2000);
  assert.ok(validateNumericInput('maxBodyChars', '1999').error);
  assert.deepEqual(validateNumericInput('maxBodyChars', '2000'), { value: 2000 });
  for (const oldLimit of [0, 80, 500, 1999]) {
    const saved = { ...options(), maxBodyChars: oldLimit, maxNoteChars: 80, depth: 4 };
    const restored = { ...clampOptions(JSON.parse(JSON.stringify(saved))), graphDepth: saved.graphDepth };
    assert.equal(restored.maxBodyChars, 2000);
    assert.equal(restored.maxNoteChars, 80);
    assert.equal(restored.depth, 4);
    assert.deepEqual(validateDiscovery({ kind: 'topic', value: '脑科学' }, restored), []);
    assert.equal(saved.maxBodyChars, oldLimit, 'normalization must not mutate saved input');
  }
  for (const limit of [2000, 16000, 48000, 200000]) assert.equal(clampOptions({ maxBodyChars: limit }).maxBodyChars, limit);
  assert.equal(clampOptions({ maxBodyChars: undefined }).maxBodyChars, defaults.maxBodyChars);
  assert.equal(clampOptions({ maxBodyChars: Number.NaN }).maxBodyChars, defaults.maxBodyChars);
});

test('URL validation uses the shared public URL policy and reports local-only conflicts before requesting', () => {
  const run = options();
  assert.deepEqual(validateDiscovery({ kind: 'url', value: ' https://zh.wikipedia.org/wiki/脑科学#概述 ' }, run), []);
  for (const url of ['http://localhost/page', 'http://127.0.0.1', 'http://192.168.1.1', 'file:///a', 'https://user:secret@example.org', 'http://[::1]/'])
    assert.ok(validateDiscovery({ kind: 'url', value: url }, run).length, url);
  assert.ok(validateDiscovery({ kind: 'url', value: 'https://example.org' }, applyPreset(run, 'local')).some(error => error.includes('仅本地')));
  assert.ok(validateDiscovery({ kind: 'url', value: 'https://example.org' }, { ...run, maxPages: 0 }).some(error => error.includes('至少 1')));
  assert.deepEqual(validateDiscovery({ kind: 'note', value: 'My folder/脑科学.md' }, applyPreset(run, 'local')), []);
});

test('malformed restored configuration receives actionable errors instead of exceptions', () => {
  assert.ok(validateDiscovery(null, null).length);
  assert.ok(validateDiscovery({ kind: 'unknown', value: '' }, options()).some(error => error.includes('请选择')));
  assert.ok(validateDiscovery({ kind: 'topic', value: ' ' }, options()).some(error => error.includes('知识起点')));
  const wrong = { ...options(), web: 'yes', wikiLanguage: 'de', relevance: 'smart', searchLanguageMode: 'all', excludeTerms: [4], searchTerms: Array(21).fill('a') };
  const errors = validateDiscovery({ kind: 'topic', value: '脑科学' }, wrong);
  for (const term of ['开关', '中文或英文', '筛选', '中英文', '文本列表', '20 项']) assert.ok(errors.some(error => error.includes(term)), term);
  assert.ok(validateDiscovery({ kind: 'topic', value: '脑科学' }, { ...options(), depth: '3' }).some(error => error.includes('探索深度必须保存为数值')));
});

test('JSON arrays cannot impersonate seed kinds or enum options in restored explorations', () => {
  const run = options();
  const seed = { kind: ['url'], value: 'http://127.0.0.1/private' };
  assert.ok(validateDiscovery(seed, run).some(error => error.includes('请选择主题、网页或笔记')),
    'an array kind must not bypass the public URL branch');
  for (const [key, value] of [['wikiLanguage', ['en']], ['relevance', ['strict']], ['searchLanguageMode', ['both']]] as const) {
    assert.ok(validateDiscovery({ kind: 'topic', value: '脑科学' }, { ...run, [key]: value }).length,
      `${key} must be an enum string, not an array coerced with String()`);
  }
});

test('local preset produces linked note discovery while making zero network requests', async () => {
  let requests = 0;
  const adapter: EngineAdapter = {
    request: async () => { requests++; throw new Error('network should not run'); },
    listNotes: () => [{ path: '脑科学.md', title: '脑科学' }, { path: '睡眠.md', title: '睡眠' }],
    readNote: async path => path === '脑科学.md' ? '脑科学中的睡眠研究 [[睡眠]]' : '睡眠科学研究',
    resolveLink: target => target === '睡眠' ? '睡眠.md' : null,
  };
  const graph = await generateGraph({ kind: 'note', value: '脑科学.md' }, adapter, applyPreset(options(), 'local'));
  assert.equal(requests, 0); assert.equal(graph.stats.requests, 0);
  assert.ok(graph.nodes.some(node => node.locator === '睡眠.md'));
  assert.ok(graph.edges.some(edge => edge.relation === 'wiki_link'));
});

test('local topic search finds vault evidence without sending the topic or supplemental words out', async () => {
  let requests = 0;
  const adapter: EngineAdapter = {
    request: async () => { requests++; throw new Error('unexpected public request'); },
    listNotes: () => [{ path: '研究/脑科学.md', title: '脑科学' }],
    readNote: async () => '脑科学研究神经系统。该笔记是已有研究记录。',
    resolveLink: () => null,
  };
  const run = applyPreset(options(), 'local');
  const graph = await generateGraph({ kind: 'topic', value: '脑科学' }, adapter, run);
  assert.equal(requests, 0); assert.equal(graph.stats.requests, 0);
  assert.ok(graph.nodes.some(node => node.kind === 'note' && node.locator === '研究/脑科学.md'));
  assert.ok(graph.edges.some(edge => edge.relation === 'keyword_match' && edge.evidence.some(evidence => evidence.quote.includes('脑科学'))));
  assert.deepEqual(run.searchTerms, ['神经科学']);
});
