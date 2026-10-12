import { safeName } from './export';
import { cleanKnowledgeTitle } from './titles';

export interface NameChange { from: string; to: string; ownerId: string }
export function planNameCleanup(notes: Array<{ path: string; title: string; managedId: string }>, occupied: Set<string>): NameChange[] {
  const changes: NameChange[] = [];
  const reserved = new Set([...occupied].map(path => path.toLocaleLowerCase()));
  for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
    const folder = note.path.slice(0, note.path.lastIndexOf('/') + 1);
    const current = note.path.slice(folder.length, -3);
    // Only recover names that actually carry legacy noise. Never undo a user rename.
    if (cleanKnowledgeTitle(current) === current.normalize('NFKC').replace(/\s+/g, ' ').trim()) continue;
    const name = safeName(cleanKnowledgeTitle(note.title || current));
    let candidate = `${folder}${name}.md`, index = 2;
    while (reserved.has(candidate.toLocaleLowerCase()) && candidate !== note.path) candidate = `${folder}${name} (${index++}).md`;
    if (candidate === note.path) continue;
    reserved.add(candidate.toLocaleLowerCase());
    changes.push({ from: note.path, to: candidate, ownerId: note.managedId });
  }
  return changes;
}
