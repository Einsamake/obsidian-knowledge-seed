import { normalizeText, terms } from './graph';
import { isNoiseLabel } from './titles';

export type RelevanceMode = 'strict' | 'balanced' | 'broad';
export interface RelevanceOptions { relevance?: RelevanceMode; searchTerms?: string[]; excludeTerms?: string[] }
export function plainSearchSnippet(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
const contains = (text: string, term: string): boolean => {
  if (!term) return false;
  if (/^[a-z0-9+ .-]+$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
  }
  return text.includes(term);
};
export function excludedContent(text: string, excluded: string[] = []): boolean {
  const value = normalizeText(text);
  return excluded.some(term => Boolean(normalizeText(term)) && value.includes(normalizeText(term)));
}
/** Deterministic lexical ranking; scores are selection aids, never semantic evidence. */
export function scoreCandidate(query: string, title: string, context: string, options: RelevanceOptions = {}, kind: 'link' | 'search' | 'note' = 'link') {
  const t = normalizeText(title), c = normalizeText(plainSearchSnippet(context));
  if (excludedContent(t, options.excludeTerms)) return { score: -100, accepted: false, reason: 'excluded' };
  const phrases = [...new Set([query, ...(options.searchTerms ?? [])].map(normalizeText).filter(Boolean))];
  const languageNavigation = /^(?:english|英文|英语|英語|汉语|漢語|中文|简体中文|繁體中文|繁体中文|日本語|한국어|français|deutsch|español|русский|italiano|português|العربية)$/i.test(title.trim())
    && !phrases.includes(t) && !phrases.some(phrase => /语言|語言|linguist|language|translation/.test(phrase));
  if (kind !== 'note' && (isNoiseLabel(title) || languageNavigation)) return { score: -50, accepted: false, reason: 'navigation' };
  let best = 0, strongTitle = false;
  for (const phrase of phrases) {
    const tokens = terms(phrase);
    const titlePhrase = contains(t, phrase), contextPhrase = contains(c, phrase);
    const titleCoverage = tokens.length ? tokens.filter(token => contains(t, token)).length / tokens.length : 0;
    const contextCoverage = tokens.length ? tokens.filter(token => contains(c, token)).length / tokens.length : 0;
    const score = (t === phrase ? 20 : titlePhrase ? 14 : titleCoverage * 5)
      + (contextPhrase ? 7 : contextCoverage * 2);
    best = Math.max(best, score);
    strongTitle ||= titlePhrase || (titleCoverage >= 0.7 && contextCoverage >= 0.4);
  }
  const mode = options.relevance ?? 'balanced';
  return { score: best, accepted: mode === 'broad' || (mode === 'strict' ? strongTitle && best >= 7 : best >= 3), reason: 'lexical' };
}
/** At most six queries per language: main term, exact phrase and four user terms. */
export function searchQueries(query: string, extra: string[] = []): string[] {
  const primary = query.trim().replace(/\s+/g, ' ').slice(0, 180);
  const candidates = [primary, primary.length > 1 ? `"${primary.replace(/"/g, '')}"` : '', ...extra.slice(0, 4)];
  return [...new Set(candidates.map(value => value.trim().slice(0, 180)).filter(Boolean))];
}
