import { Setting } from 'obsidian';
import type { Options } from './engine';
import { normalizeText } from './graph';

type Strategy = NonNullable<Options['explorationStrategy']>;
type DirectionRule = NonNullable<Options['directionRules']>[number];
type CustomNumber = 'breadthDecay' | 'directionDepthBoost' | 'offDirectionDepth';

const strategyLabels: Record<Strategy, string> = {
  radial: '由近及远', focused: '围绕主题', breadth: '广度优先', depth: '沿分支深入', custom: '自定义',
};
const strategyDescriptions: Record<Strategy, string> = {
  radial: '保留原有方式：越往外，每页继续展开的链接越少。指定方向会获得更多探索机会。',
  focused: '优先保留与起点和探索方向相关的分支，减少无关旁支，适合形成集中的主题图谱。',
  breadth: '按层覆盖各个分支，保持每层展开宽度，适合先了解主题有哪些方面。',
  depth: '优先沿当前知识线索向深处探索，每个来源最多继续检查 3 个分支。',
  custom: '自己设置外层展开速度、方向深度和旁支深度；各方向还可分别设置优先级与深度。',
};

export function explorationStrategyDescription(options: Options): string {
  const strategy = options.explorationStrategy ?? 'radial';
  return strategyDescriptions[strategy];
}

/** Parse editable rules strictly: an invalid row never silently replaces saved rules. */
export function parseDirectionRuleInput(input: string): { rules?: DirectionRule[]; error?: string } {
  const rows = input.split(/\r?\n/).map((text, index) => ({ text: text.trim(), line: index + 1 })).filter(row => row.text);
  if (rows.length > 20) return { error: '最多设置 20 个方向，请删除多余行。' };
  const rules: DirectionRule[] = [], seen = new Set<string>();
  for (const row of rows) {
    const parts = row.text.split(/[|｜]/).map(part => part.trim());
    if (parts.length > 3) return { error: `第 ${row.line} 行格式有误，请按“方向 | 优先级 | 深度”填写。` };
    const term = parts[0];
    if (!term || term.length > 180) return { error: `第 ${row.line} 行方向名称须为 1–180 个字符。` };
    const key = normalizeText(term);
    if (seen.has(key)) return { error: `第 ${row.line} 行方向重复，请合并同名方向。` };
    const weight = parts[1] ? Number(parts[1]) : 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 10) return { error: `第 ${row.line} 行优先级必须是 1–10 的整数。` };
    const depth = parts[2] ? Number(parts[2]) : undefined;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0 || depth > 20)) return { error: `第 ${row.line} 行深度必须是 0–20 的整数，或留空。` };
    seen.add(key);
    rules.push(depth === undefined ? { term, weight } : { term, weight, depth });
  }
  return { rules };
}

export function formatDirectionRules(rules: readonly DirectionRule[] = []): string {
  return rules.map(rule => `${rule.term} | ${rule.weight}${rule.depth === undefined ? '' : ` | ${rule.depth}`}`).join('\n');
}

/** Public Obsidian controls shared by the seed form and persistent settings. */
export function renderExplorationStrategyControls(container: HTMLElement, options: Options, changed: () => Promise<void> | void = () => {}): void {
  const section = container.createEl('section', { attr: { 'aria-label': '探索策略设置' } });
  const explanation = section.createEl('p', { cls: 'knowledge-seed-note', attr: { role: 'status', 'aria-live': 'polite' } });
  let selected: Strategy = options.explorationStrategy ?? 'radial';
  const custom = section.createDiv({ cls: 'knowledge-seed-options' });
  const numericControls: Array<{ key: CustomNumber; input: HTMLInputElement; error: HTMLElement; fallback: number }> = [];
  const showStrategy = () => {
    explanation.setText(explorationStrategyDescription({ ...options, explorationStrategy: selected }));
    custom.hidden = selected !== 'custom';
    for (const control of numericControls) {
      control.input.disabled = custom.hidden;
      // Hidden custom drafts do not prevent using another strategy. Keep the
      // previous accepted value rather than accepting or clamping bad input.
      if (custom.hidden) {
        control.input.value = String(options[control.key] ?? control.fallback);
        control.input.setCustomValidity('');
        control.input.setAttribute('aria-invalid', 'false');
        control.error.setText('');
      }
    }
  };
  const strategySetting = new Setting(section).setName('探索策略').setDesc('选择图谱如何展开。策略影响搜索顺序与范围，关系仍来自正文和已有笔记中的真实链接。');
  section.insertBefore(strategySetting.settingEl, explanation);
  strategySetting.addDropdown(dropdown => {
    dropdown.selectEl.setAttribute('aria-label', '探索策略');
    dropdown.addOptions(strategyLabels).setValue(selected).onChange(async value => {
      if (!Object.hasOwn(strategyLabels, value)) return;
      selected = value as Strategy;
      options.explorationStrategy = selected;
      showStrategy();
      await changed();
    });
  });
  const fields: Array<{ key: CustomNumber; name: string; description: string; fallback: number; max: number }> = [
    { key: 'breadthDecay', name: '外层展开递减', description: '0 保持每层展开宽度；1 温和递减；数值越大，远处分支越收窄。', fallback: 1, max: 4 },
    { key: 'directionDepthBoost', name: '方向额外深度', description: '匹配探索方向时，在旁支深度基础上增加的层数。', fallback: 2, max: 20 },
    { key: 'offDirectionDepth', name: '未匹配方向的深度', description: '没有匹配探索方向的分支继续探索几层；0 不继续展开。', fallback: 1, max: 20 },
  ];
  for (const field of fields) new Setting(custom).setName(field.name).setDesc(`${field.description} 可输入 0–${field.max} 的整数。`).addText(text => {
    const input = text.inputEl;
    input.type = 'number'; input.min = '0'; input.max = String(field.max); input.step = '1';
    input.setAttribute('aria-label', field.name);
    const errorEl = input.parentElement!.createEl('small', { cls: 'knowledge-seed-error', attr: { 'aria-live': 'polite' } });
    numericControls.push({ key: field.key, input, error: errorEl, fallback: field.fallback });
    text.setValue(String(options[field.key] ?? field.fallback)).onChange(async value => {
      const number = value.trim() ? Number(value) : NaN;
      const error = Number.isInteger(number) && number >= 0 && number <= field.max ? '' : `${field.name}必须是 0–${field.max} 的整数。`;
      input.setCustomValidity(error); input.setAttribute('aria-invalid', String(Boolean(error))); errorEl.setText(error);
      if (error) return;
      options[field.key] = number;
      await changed();
    });
  });
  new Setting(section).setName('分别设置方向（可选）')
    .setDesc('每行“方向 | 优先级 | 深度”，例如：神经科学 | 3 | 4。优先级 1–10，越大越先探索；深度 0–20，留空遵循策略。最多 20 行。方向名称也会作为公开检索词。')
    .addTextArea(text => {
      text.inputEl.setAttribute('aria-label', '各方向优先级与深度');
      text.inputEl.rows = 4;
      text.setPlaceholder('神经科学 | 3 | 4\n实际应用 | 2\n历史背景 | 1 | 1');
      const errorEl = text.inputEl.parentElement!.createEl('small', { cls: 'knowledge-seed-error', attr: { 'aria-live': 'polite' } });
      text.setValue(formatDirectionRules(options.directionRules)).onChange(async value => {
        const result = parseDirectionRuleInput(value);
        text.inputEl.setCustomValidity(result.error ?? '');
        text.inputEl.setAttribute('aria-invalid', String(Boolean(result.error))); errorEl.setText(result.error ?? '');
        if (!result.rules) return;
        options.directionRules = result.rules.map(rule => ({ ...rule }));
        await changed();
      });
    });
  section.createEl('p', { text: '所有方向仍受整体探索深度和节点总上限限制；方向按名称和上下文中的词匹配。', cls: 'knowledge-seed-note' });
  showStrategy();
}
