/** Read only plugin-owned YAML properties, including Obsidian's block-list style.
 * Unknown YAML structures are refused rather than guessed as an entity identity.
 */
export interface ManagedField { raw: string; start: number; end: number }
export interface ManagedHeader { text: string; fields: Map<string, ManagedField> }

export function managedHeader(content: string): ManagedHeader | undefined {
  const text = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (text === undefined) return undefined;
  const fields = new Map<string, ManagedField>();
  const rows = [...text.matchAll(/^([a-z_][a-z0-9_]*):[ \t]*(.*)\r?$/gmi)];
  for (const row of rows) {
    const name = row[1];
    if (!['knowledge_seed_id','knowledge_seed_merged_ids','title','kind','status','source','entity_url','reading_state'].includes(name)) continue;
    if (fields.has(name)) throw new Error(`生成笔记属性重复：${name}`);
    const start = row.index!;
    let end = start + row[0].length;
    const initial = row[2].trim();
    if (!initial && name === 'knowledge_seed_merged_ids') {
      const continuation = /^(?:\r?\n[ \t]*-[ \t]+[^\r\n]*)+/.exec(text.slice(end))?.[0] ?? '';
      end += continuation.length;
    } else {
      // A folded or indented scalar must never be mistaken for an empty source.
      // Refuse unsupported continuation text before trimming can erase it.
      const continuation = /^(?:\r?\n[ \t]+[^\r\n]*)+/.exec(text.slice(end))?.[0] ?? '';
      if (continuation.trim()) throw new Error('生成笔记属性包含不支持的缩进结构。');
    }
    fields.set(name, { raw: text.slice(start + row[0].indexOf(':') + 1, end).trim(), start, end });
  }
  return {text, fields};
}

export function managedScalar(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!text || /^(?:null|~)$/i.test(text)) return undefined;
  if (text.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(text)?.[0];
    if (!quoted || !/^(?:[ \t]+#.*)?$/.test(text.slice(quoted.length))) throw new Error('生成笔记属性值无效。');
    const value: unknown = JSON.parse(quoted);
    if (typeof value !== 'string') throw new Error('生成笔记属性值无效。');
    return value;
  }
  if (text.startsWith("'")) {
    const quoted = /^'(?:[^']|'')*'/.exec(text)?.[0];
    if (!quoted || !/^(?:[ \t]+#.*)?$/.test(text.slice(quoted.length))) throw new Error('生成笔记属性值无效。');
    return quoted.slice(1,-1).replaceAll("''", "'");
  }
  if (/^[\[{>|]/.test(text) || /\r|\n/.test(text)) throw new Error('生成笔记属性值无效。');
  return text.replace(/[ \t]+#.*$/, '').trim() || undefined;
}

export function managedAliases(header: ManagedHeader): string[] {
  const raw = header.fields.get('knowledge_seed_merged_ids')?.raw;
  if (raw === undefined || !raw || /^(?:null|~)$/i.test(raw)) return [];
  let values: unknown[];
  if (raw.startsWith('[')) {
    // Generated flow arrays are JSON. Also accept simple YAML string arrays
    // rewritten by native property editing; identities cannot contain commas.
    const flow = /^\[([\s\S]*)\](?:[ \t]+#.*)?$/.exec(raw);
    if (!flow) throw new Error('已有合并身份属性无效。');
    values = flow[1].trim() ? flow[1].split(',').map(part => managedScalar(part)) : [];
  } else {
    values = raw.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
      if (!item) throw new Error('已有合并身份属性无效。');
      return managedScalar(item[1]);
    });
  }
  if (values.some(value => typeof value !== 'string' || !/^[a-z0-9_-]+$/i.test(value))) throw new Error('已有合并身份属性无效。');
  return [...new Set(values as string[])];
}

export const managedValue = (header: ManagedHeader, name: string): string | undefined => managedScalar(header.fields.get(name)?.raw);
