import { stableId, type NodeReading } from './graph';
import { managedAliases, managedHeader, managedValue } from './ownership';
import { cleanKnowledgeTitle } from './titles';
import { publicUrl } from './web';

export interface ManagedNoteState {
  managedId: string; title: string; mergedIds: string[]; kind?: string; source?: string;
  bodyAvailable: boolean; readingState?: NodeReading['state'];
}
// Only complete, unchanged lines emitted by the plugin are empty-body notices.
// Never strip a prefix such as "等待读取": the rest of that line may be a user's
// explanation, which must continue to prevent automatic body replacement.
const emptyBodyNotices = new Set([
  '来源正文中的术语或链接名称，定义与语义关系待核实。',
  '正文提及的已有笔记；本次未读取该笔记正文，定义与语义关系待核实。',
  '仅有提及证据，尚未读取正文',
  '仅有提及证据，尚未读取正文。',
  '仅有提及证据，尚未读取正文.',
  '用户指定网页，等待读取来源与概念。',
  '后台逐步发现来源与概念；词项匹配和提及不表示因果关系。',
  '自动发现的来源与概念；匹配和提及不表示因果关系。',
  '已有笔记；本次来源尚未读取，关系以原有链接或词项匹配为证据。',
  '公开百科搜索返回的候选名称；尚未读取来源正文。',
  '用户打开生成的空概念，按需补充正文。',
]);
/** The same ownership/body rules are used by a single opened note and full save preflight. */
export function readManagedNote(content: string, fallbackTitle: string): ManagedNoteState | undefined {
  const header = managedHeader(content);
  if (!header) return;
  const managedId = managedValue(header,'knowledge_seed_id');
  if (!managedId || !/^[a-z0-9_-]+$/i.test(managedId)) return;
  const scalar = (name: string) => managedValue(header,name);
  const source = scalar('source') || undefined, entity = scalar('entity_url') || undefined;
  if (source && entity && publicUrl(source) !== publicUrl(entity)) throw new Error('来源网址与概念身份不一致。');
  const withoutLinks = content.replace(new RegExp(`<!-- knowledge-seed:links:${managedId} -->[\\s\\S]*?<!-- /knowledge-seed:links:${managedId} -->`,'g'),'');
  const withoutReading = withoutLinks.replace(new RegExp(`<!-- knowledge-seed:reading:${managedId} -->[\\s\\S]*?<!-- /knowledge-seed:reading:${managedId} -->`,'g'),'');
  const withoutExcerpts = withoutReading.replace(new RegExp(`<!-- knowledge-seed:excerpt:${managedId}:([a-f0-9]{16}) -->\\r?\\n([\\s\\S]*?)\\r?\\n<!-- /knowledge-seed:excerpt:${managedId} -->`,'g'),
    (block, hash:string, excerpt:string)=>stableId(excerpt.replace(/\r\n/g,'\n'))===hash?'':block);
  const manualBody = withoutExcerpts.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---/,'').replace(/^#{1,6} .*$/gm,'')
    .replace(/<!--[\s\S]*?-->/g,'').replace(/(?<!\\)%%[\s\S]*?(?<!\\)(?:%%|$)/g,'')
    .replace(/^>[ \t]*(.*?)[ \t]*\r?$/gm,(line,notice:string)=>emptyBodyNotices.has(notice)?'':line).trim();
  const bodyAvailable = content.includes(`<!-- knowledge-seed:article:${managedId}:`) || /[\p{L}\p{N}]/u.test(manualBody);
  const reading = scalar('reading_state');
  const readingState = ['pending','reading','ready','failed','no_match','excluded'].includes(reading ?? '') ? reading as NodeReading['state'] : undefined;
  return {managedId,mergedIds:managedAliases(header),bodyAvailable,readingState,
    title:cleanKnowledgeTitle(scalar('title') || fallbackTitle),kind:scalar('kind'),source:source??entity};
}
