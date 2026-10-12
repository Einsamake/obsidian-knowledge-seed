import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { parseHTML } from 'linkedom';
import { defaults, type Options } from '../src/engine';

// Exercise the shipped controls through the public Setting API. The shim only
// supplies Obsidian's widgets and browser constraint validation missing in DOM.
const source = buildSync({ entryPoints: [fileURLToPath(new URL('../src/strategy-ui.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian'] }).outputFiles[0].text;

function fixture(patch: Partial<Options> = {}) {
  const { document, window } = parseHTML('<html><body></body></html>');
  const validity = new WeakMap<HTMLElement, string>();
  const pending: Promise<unknown>[] = [];
  let changes = 0;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag) as unknown as HTMLElementTagNameMap[K];
    const current = node as any;
    current.createEl = (childTag: keyof HTMLElementTagNameMap, options: any = {}) => {
      const child = element(childTag);
      if (options.text !== undefined) child.textContent = options.text;
      if (options.cls) child.className = options.cls;
      for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, String(value));
      node.appendChild(child); return child;
    };
    current.createDiv = (options: any = {}) => current.createEl('div', options);
    current.setText = (text: string) => { node.textContent = text; };
    current.setCustomValidity = (error: string) => { validity.set(node, error); };
    if (tag === 'select') Object.defineProperty(node, 'value', {
      get: () => [...node.querySelectorAll('option')].find(option => option.selected)?.value ?? '',
      set: (value: string) => {
        const options = [...node.querySelectorAll('option')];
        options.forEach(option => { option.selected = false; });
        const selected = options.find(option => option.value === value); if (selected) selected.selected = true;
      },
    });
    return node;
  }
  const listen = (node: HTMLElement, event: string, callback: () => unknown) => node.addEventListener(event, () => {
    pending.push(Promise.resolve(callback()));
  });
  class Text {
    inputEl: HTMLInputElement | HTMLTextAreaElement;
    constructor(parent: HTMLElement, multiline = false) {
      this.inputEl = element(multiline ? 'textarea' : 'input'); parent.appendChild(this.inputEl);
    }
    setValue(value: string) { this.inputEl.value = value; return this; }
    setPlaceholder(value: string) { this.inputEl.setAttribute('placeholder', value); return this; }
    onChange(callback: (value: string) => unknown) { listen(this.inputEl, 'input', () => callback(this.inputEl.value)); return this; }
  }
  class Dropdown {
    selectEl = element('select');
    constructor(parent: HTMLElement) { parent.appendChild(this.selectEl); }
    addOptions(options: Record<string, string>) {
      for (const [value, label] of Object.entries(options)) this.selectEl.createEl('option', { text: label, attr: { value } }); return this;
    }
    setValue(value: string) { this.selectEl.value = value; return this; }
    onChange(callback: (value: string) => unknown) { listen(this.selectEl, 'change', () => callback(this.selectEl.value)); return this; }
  }
  class Setting {
    settingEl = element('div'); controlEl = element('div');
    constructor(parent: HTMLElement) { this.settingEl.appendChild(this.controlEl); parent.appendChild(this.settingEl); }
    setName(name: string) { this.settingEl.setAttribute('data-setting', name); return this; }
    setDesc(text: string) { this.settingEl.createEl('p', { text }); return this; }
    addText(callback: (component: Text) => unknown) { callback(new Text(this.controlEl)); return this; }
    addTextArea(callback: (component: Text) => unknown) { callback(new Text(this.controlEl, true)); return this; }
    addDropdown(callback: (component: Dropdown) => unknown) { callback(new Dropdown(this.controlEl)); return this; }
  }
  const module = { exports: {} as any };
  vm.runInNewContext(source, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, 'obsidian'); return { Setting };
  } });
  const options: Options = { ...defaults, ...patch };
  const root = element('div'); document.body.appendChild(root as any);
  module.exports.renderExplorationStrategyControls(root, options, async () => { changes++; });
  const field = <T extends HTMLElement>(label: string): T => {
    const result = root.querySelector(`[aria-label="${label}"]`); assert.ok(result, label); return result as unknown as T;
  };
  const input = async (label: string, value: string) => {
    const node = field<HTMLInputElement | HTMLTextAreaElement>(label); node.value = value;
    node.dispatchEvent(new window.Event('input') as unknown as Event); await Promise.all(pending.splice(0)); return node;
  };
  const choose = async (strategy: string) => {
    const node = field<HTMLSelectElement>('探索策略'); node.value = strategy;
    node.dispatchEvent(new window.Event('change') as unknown as Event); await Promise.all(pending.splice(0));
  };
  return { root, options, field, input, choose, validity, changes: () => changes, exports: module.exports };
}

test('strategy selector presents five distinct choices and explains limits without opening advanced options', async () => {
  const ui = fixture();
  const strategy = ui.field<HTMLSelectElement>('探索策略');
  assert.deepEqual([...strategy.querySelectorAll('option')].map(option => option.value), ['radial', 'focused', 'breadth', 'depth', 'custom']);
  assert.equal(strategy.value, 'radial');
  assert.match(ui.root.textContent ?? '', /整体探索深度和节点总上限/);
  assert.equal(ui.field<HTMLInputElement>('外层展开递减').disabled, true);
  await ui.choose('breadth');
  assert.equal(ui.options.explorationStrategy, 'breadth');
  assert.match(ui.root.querySelector('[role="status"]')?.textContent ?? '', /保持每层展开宽度/);
  await ui.choose('depth');
  assert.match(ui.root.querySelector('[role="status"]')?.textContent ?? '', /最多.*3.*分支/);
  assert.equal(ui.changes(), 2);
});

test('custom numerical fields reject invalid input without changing saved values or notifying persistence', async () => {
  const ui = fixture({ explorationStrategy: 'custom', breadthDecay: 1 });
  assert.equal(ui.field<HTMLInputElement>('外层展开递减').disabled, false);
  await ui.input('外层展开递减', '0');
  assert.equal(ui.options.breadthDecay, 0); assert.equal(ui.changes(), 1);
  for (const value of ['5', '-1', '1.5', '', 'NaN']) {
    const node = await ui.input('外层展开递减', value);
    assert.equal(node.getAttribute('aria-invalid'), 'true');
    assert.match(ui.validity.get(node) ?? '', /0–4.*整数/);
    assert.equal(ui.options.breadthDecay, 0); assert.equal(ui.changes(), 1);
  }
  await ui.input('方向额外深度', '20');
  await ui.input('未匹配方向的深度', '0');
  assert.equal(ui.options.directionDepthBoost, 20); assert.equal(ui.options.offDirectionDepth, 0);
  await ui.input('方向额外深度', '21');
  assert.equal(ui.options.directionDepthBoost, 20); assert.equal(ui.changes(), 3);
});

test('switching strategy clears a hidden invalid custom draft and restores the last accepted value', async () => {
  const ui = fixture({ explorationStrategy: 'custom', offDirectionDepth: 2 });
  const node = await ui.input('未匹配方向的深度', '-2');
  assert.equal(node.getAttribute('aria-invalid'), 'true');
  await ui.choose('focused');
  assert.equal(node.disabled, true); assert.equal(node.value, '2');
  assert.equal(ui.validity.get(node), ''); assert.equal(node.getAttribute('aria-invalid'), 'false');
  assert.equal(ui.options.offDirectionDepth, 2);
  await ui.choose('custom'); assert.equal(node.disabled, false); assert.equal(node.value, '2');
});

test('direction rows save independent objects; rejected rows preserve the existing rule list', async () => {
  const shared = [{ term: '原方向', weight: 2, depth: 3 }];
  const ui = fixture({ directionRules: shared });
  await ui.input('各方向优先级与深度', '神经科学 | 3 | 4\n实际应用 | 2\n历史 | | 0');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.options.directionRules)), [
    { term: '神经科学', weight: 3, depth: 4 }, { term: '实际应用', weight: 2 }, { term: '历史', weight: 1, depth: 0 },
  ]);
  assert.deepEqual(shared, [{ term: '原方向', weight: 2, depth: 3 }]);
  const saved = ui.options.directionRules;
  const rejected = await ui.input('各方向优先级与深度', '神经科学 | 11');
  assert.equal(rejected.getAttribute('aria-invalid'), 'true');
  assert.strictEqual(ui.options.directionRules, saved); assert.equal(ui.changes(), 1);
  await ui.input('各方向优先级与深度', '');
  assert.equal(ui.options.directionRules?.length, 0); assert.equal(ui.changes(), 2);
  assert.equal(rejected.getAttribute('aria-invalid'), 'false');
});

test('direction parser validates row structure, duplicates, bounds and blank optional fields', () => {
  const { parseDirectionRuleInput: parse, formatDirectionRules: format } = fixture().exports;
  const valid = parse('  PCA ｜ 3 ｜ 4\r\n\n  数值计算  ');
  assert.equal(valid.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(valid.rules)), [{ term: 'PCA', weight: 3, depth: 4 }, { term: '数值计算', weight: 1 }]);
  assert.equal(format([{ term: '数值计算', weight: 1, depth: 0 }]), '数值计算 | 1 | 0');
  for (const input of [' | 2', 'PCA | 1 | 3 | 4', 'PCA | 0', 'PCA | 1.5', 'PCA | 2 | -1', 'PCA | 2 | 21', 'PCA\npca', 'PCA\nＰＣＡ', 'x'.repeat(181)]) {
    const result = parse(input); assert.equal(result.rules, undefined, input); assert.ok(result.error, input);
  }
  assert.match(parse(Array.from({ length: 21 }, (_, index) => `方向${index}`).join('\n')).error, /最多.*20/);
  assert.equal(parse(' \n \n ').rules.length, 0);
});
