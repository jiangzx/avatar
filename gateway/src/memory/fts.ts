import { bigrams } from './bigram.ts';

/** FTS expression for the same tokens `bigrams` stored. Null when the text has none. */
export function ftsMatch(text: string, match: 'any' | 'all' = 'any'): string | null {
  const tokens = bigrams(text).split(' ').filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(match === 'all' ? ' AND ' : ' OR ');
}
