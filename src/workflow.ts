import type { Options, Seed } from './engine';
import { normalizeText } from './graph';
import { publicUrl } from './web';

/** Only discovery and core graph options are required for a repeatable saved exploration. */
export type RunOptions = Options & { graphDepth: number };
export interface DiscoveryConfig { seed: Seed; options: RunOptions }
export type PresetId = 'quick' | 'balanced' | 'deep' | 'local';
export type NumericOption = 'depth' | 'maxPages' | 'maxNotes' | 'maxConcepts' | 'scanLimit'
  | 'searchLimit' | 'linkLimit' | 'maxBodyChars' | 'maxNoteChars' | 'graphDepth';

export const numericRules: Record<NumericOption, { label: string; min: number; max: number }> = {
  depth: { label: '探索深度', min: 0, max: 20 },
  maxPages: { label: '网页数量上限', min: 0, max: 500 },
  maxNotes: { label: '笔记数量上限', min: 0, max: 500 },
  maxConcepts: { label: '概念数量上限', min: 0, max: 1000 },
  scanLimit: { label: '笔记扫描上限', min: 1, max: 50000 },
  searchLimit: { label: '检索候选上限', min: 0, max: 100 },
  linkLimit: { label: '每页链接上限', min: 0, max: 100 },
  maxBodyChars: { label: '网页正文长度', min: 2000, max: 200000 },
  maxNoteChars: { label: '笔记正文长度', min: 80, max: 200000 },
  graphDepth: { label: '原生图显示深度', min: 0, max: 5 },
};

export interface ExplorationPreset {
  id: PresetId;
  label: string;
  description: string;
  patch: Partial<RunOptions>;
}

/** Network request figures are the engine's hard cap, not a promise of actual consumption. */
export const presets: readonly ExplorationPreset[] = [
  { id: 'quick', label: '快速探索', description: '深度 1；最多 3 个网页、4 篇笔记、8 个概念。最多 21 次网络请求，适合先看方向。',
    patch: { web: true, depth: 1, maxPages: 3, maxNotes: 4, maxConcepts: 8, scanLimit: 150,
      searchLimit: 8, linkLimit: 6, maxBodyChars: 16000, maxNoteChars: 16000, graphDepth: 2, relevance: 'strict' } },
  { id: 'balanced', label: '平衡探索', description: '深度 1；最多 5 个网页、8 篇笔记、16 个概念。最多 27 次网络请求，适合日常探索。',
    patch: { web: true, depth: 1, maxPages: 5, maxNotes: 8, maxConcepts: 16, scanLimit: 250,
      searchLimit: 12, linkLimit: 12, maxBodyChars: 48000, maxNoteChars: 20000, graphDepth: 3, relevance: 'balanced' } },
  { id: 'deep', label: '深入探索', description: '深度 3；最多 12 个网页、24 篇笔记、40 个概念。最多 48 次网络请求，耗时和候选数量会增加。',
    patch: { web: true, depth: 3, maxPages: 12, maxNotes: 24, maxConcepts: 40, scanLimit: 1000,
      searchLimit: 24, linkLimit: 20, maxBodyChars: 96000, maxNoteChars: 40000, graphDepth: 5, relevance: 'balanced' } },
  { id: 'local', label: '仅已有笔记', description: '深度 3；最多 24 篇笔记、24 个概念，扫描最多 1000 篇笔记。不联网，适用于主题或笔记起点。',
    patch: { web: false, depth: 3, maxPages: 0, maxNotes: 24, maxConcepts: 24, scanLimit: 1000,
      searchLimit: 0, linkLimit: 12, maxBodyChars: 24000, maxNoteChars: 40000, graphDepth: 5, relevance: 'balanced' } },
];

/** Preserve settings extensions while giving each editable run its own array instances. */
export function cloneRunOptions<T extends RunOptions>(value: T): T {
  return { ...value, searchTerms: [...value.searchTerms], excludeTerms: [...value.excludeTerms], excludeFolders: [...value.excludeFolders],
    ...(value.directionRules !== undefined ? {directionRules:value.directionRules.map(rule => ({...rule}))} : {}) };
}

export function applyPreset<T extends RunOptions>(value: T, id: PresetId): T {
  const preset = presets.find(item => item.id === id);
  if (!preset) throw new Error('未知探索预设。');
  return cloneRunOptions({ ...value, ...preset.patch });
}

export function cloneDiscoveryConfig(value: DiscoveryConfig): DiscoveryConfig {
  return { seed: { ...value.seed }, options: cloneRunOptions(value.options) };
}

export function validateNumericInput(key: NumericOption, input: unknown): { value?: number; error?: string } {
  const rule = numericRules[key];
  if (!rule) return { error: '未知数值选项。' };
  const number = typeof input === 'number' ? input
    : typeof input === 'string' && input.trim() !== '' ? Number(input.trim()) : NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number)) return { error: `${rule.label}必须是整数（${rule.min}–${rule.max}）。` };
  if (number < rule.min || number > rule.max) return { error: `${rule.label}应在 ${rule.min}–${rule.max} 之间。` };
  return { value: number };
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Report errors rather than silently clamping. The caller checks vault note existence. */
export function validateDiscovery(seed: unknown, options: unknown): string[] {
  const errors: string[] = [];
  if (!record(seed) || typeof seed.kind !== 'string' || !['topic', 'url', 'note'].includes(seed.kind)) errors.push('请选择主题、网页或笔记起点。');
  if (!record(seed) || typeof seed.value !== 'string' || !seed.value.trim()) errors.push('请输入知识起点。');
  if (!record(options)) return [...errors, '探索参数无效。'];
  for (const key of Object.keys(numericRules) as NumericOption[]) {
    if (typeof options[key] !== 'number') {
      errors.push(`${numericRules[key].label}必须保存为数值；请重新输入有效整数。`);
      continue;
    }
    const result = validateNumericInput(key, options[key]);
    if (result.error) errors.push(result.error);
  }
  if (typeof options.web !== 'boolean') errors.push('公开网页开关无效。');
  if (options.readingMode !== undefined && !['adaptive', 'manual'].includes(options.readingMode as string)) errors.push('请选择动态读取或手动范围。');
  if (options.readingPace !== undefined && !['fast', 'balanced', 'deep'].includes(options.readingPace as string)) errors.push('请选择快速、均衡或深入的读取节奏。');
  if (typeof options.wikiLanguage !== 'string' || !['zh', 'en'].includes(options.wikiLanguage)) errors.push('检索语言必须为中文或英文。');
  if (typeof options.searchLanguageMode !== 'string' || !['primary', 'both'].includes(options.searchLanguageMode)) errors.push('请选择单语言或中英文检索。');
  if (typeof options.relevance !== 'string' || !['strict', 'balanced', 'broad'].includes(options.relevance)) errors.push('请选择有效的相关性筛选方式。');
  if (options.explorationStrategy !== undefined && (typeof options.explorationStrategy !== 'string'
    || !['radial','focused','breadth','depth','custom'].includes(options.explorationStrategy))) errors.push('请选择有效的探索策略。');
  for (const [key,label,max] of [['breadthDecay','外层宽度衰减',4],['directionDepthBoost','方向深度增加',20],['offDirectionDepth','非方向分支深度',20]] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)) errors.push(`${label}必须是 0–${max} 的整数。`);
  }
  if (options.directionRules !== undefined) {
    const rules = options.directionRules, seen = new Set<string>();
    if (!Array.isArray(rules) || rules.length > 20) errors.push('自定义方向规则必须是列表，最多 20 条。');
    else for (const [index,rule] of rules.entries()) {
      if (!record(rule) || typeof rule.term !== 'string' || !rule.term.trim() || rule.term.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(rule.term)
        || typeof rule.weight !== 'number' || !Number.isInteger(rule.weight) || rule.weight < 1 || rule.weight > 10
        || rule.depth !== undefined && (typeof rule.depth !== 'number' || !Number.isInteger(rule.depth) || rule.depth < 0 || rule.depth > 20)) {
        errors.push(`第 ${index + 1} 条方向规则无效：名称最多 180 字，权重为 1–10 的整数，深度可留空或填 0–20 的整数。`); continue;
      }
      const key = normalizeText(rule.term);
      if (seen.has(key)) errors.push(`第 ${index + 1} 条方向规则重复；请合并同名方向。`);
      seen.add(key);
    }
  }
  for (const [key, label, limit] of [['searchTerms', '补充检索词', 20], ['excludeTerms', '排除词', 100], ['excludeFolders', '排除目录', Infinity]] as const) {
    const values = options[key];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) errors.push(`${label}必须是非空文本列表。`);
    else if (values.length > limit) errors.push(`${label}最多 ${limit} 项。`);
    else if (key !== 'excludeFolders' && values.some(value => value.trim().length > 180)) errors.push(`${label}每项最多 180 个字符。`);
  }
  if (record(seed) && seed.kind === 'url' && typeof seed.value === 'string' && seed.value.trim()) {
    try { publicUrl(seed.value); } catch (error) { errors.push(error instanceof Error ? error.message : '网页地址无效。'); }
    if (options.web !== true || (options.readingMode !== 'adaptive' && (typeof options.maxPages !== 'number' || options.maxPages < 1)))
      errors.push('网页起点需要开启公开网页检索，并将网页上限设为至少 1；仅本地探索请选择主题或笔记起点。');
  }
  return errors;
}
