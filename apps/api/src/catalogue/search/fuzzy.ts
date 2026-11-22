// Typo tolerance (plan §2.5.4): a word is corrected only when it is long enough, has no digits, isn't a real word
import { CONFIG } from "../../config.ts";
// (or, for the word being typed, a prefix of one), and a dictionary word is one edit away: one wrong, extra, missing
// or swapped letter. Distance 2 is never used (too many false matches on product vocabularies).

/** Scripts without spaces between words: their "words" aren't words, so they are never corrected. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export const MIN_FUZZY_LENGTH = CONFIG.search.fuzzy.minWordLength;
export const MAX_CANDIDATES = CONFIG.search.fuzzy.maxCandidates;
export const MAX_CORRECTED_WORDS = CONFIG.search.fuzzy.maxCorrectedWords;
/** Beyond this many distinct words the scan would get slow; typo tolerance is then turned off (and logged). */
export const MAX_DICTIONARY = CONFIG.search.fuzzy.maxDictionaryWords;

const eq = (a: string[], ai: number, b: string[], bi: number) => {
  if (a.length - ai !== b.length - bi) return false;
  for (let k = 0; ai + k < a.length; k++) if (a[ai + k] !== b[bi + k]) return false;
  return true;
};

/**
 * True when `a` and `b` (arrays of code points, different) are one edit apart: one substitution, insertion, deletion,
 * or swap of two adjacent letters (optimal string alignment distance 1). Linear time, no allocation.
 */
export function withinOne(a: string[], b: string[]): boolean {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (i === la) return false; // identical
    if (eq(a, i + 1, b, i + 1)) return true; // substitution
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && eq(a, i + 2, b, i + 2); // adjacent swap
  }
  const [L, S] = la > lb ? [a, b] : [b, a];
  return eq(L, i + 1, S, i); // insertion or deletion
}

/** Whether a query word may be corrected at all (before looking at the dictionary). */
export function eligible(word: string, minLength = MIN_FUZZY_LENGTH): boolean {
  const cps = [...word];
  return cps.length >= minLength && !/\p{N}/u.test(word) && !UNSPACED.test(word);
}

/** Dictionary words grouped by length (in code points), with document frequency. Built once per index. */
export class Dictionary {
  private byLength = new Map<number, { word: string; cps: string[] }[]>();
  readonly df: Map<string, number>;
  readonly enabled: boolean;
  constructor(df: Map<string, number>) {
    this.df = df;
    this.enabled = df.size <= MAX_DICTIONARY;
    if (!this.enabled) { console.warn(`Search: ${df.size} distinct words, typo tolerance is off above ${MAX_DICTIONARY}.`); return; }
    for (const word of df.keys()) {
      const cps = [...word];
      let list = this.byLength.get(cps.length);
      if (!list) { list = []; this.byLength.set(cps.length, list); }
      list.push({ word, cps });
    }
  }
  /**
   * Up to MAX_CANDIDATES dictionary words one edit away from `word`, best first: same first letter, then more common
   * (higher document frequency), then alphabetical, so results are always the same.
   */
  candidates(word: string): string[] {
    if (!this.enabled) return [];
    const cps = [...word];
    const found: string[] = [];
    for (let len = cps.length - 1; len <= cps.length + 1; len++) {
      for (const e of this.byLength.get(len) ?? []) if (withinOne(cps, e.cps)) found.push(e.word);
    }
    const first = cps[0];
    return found
      .sort((a, b) => Number([...b][0] === first) - Number([...a][0] === first) || (this.df.get(b) ?? 0) - (this.df.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_CANDIDATES);
  }
}
