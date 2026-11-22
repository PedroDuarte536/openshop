// Text normalisation shared by indexing and querying: accents and case are ignored, words are split on anything that
// isn't a letter or a digit, and "350ml" is also indexed as "350" and "ml".

/** NFKD, combining marks removed, lower case: "Céramique" -> "ceramique". Plain ASCII skips the Unicode work. */
export const fold = (s: string) => (/^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());

/** Words of a query, in order. "350ml" stays one word here; the index falls back to "350" + "ml" when the shop has no "350ml". */
export function queryWords(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The letter and digit runs of a word that mixes both ("350ml" -> 350, ml); null for other words (the common case, cheap). */
const HAS_DIGIT = /\p{N}/u, HAS_LETTER = /\p{L}/u;
export function mixedRuns(w: string): string[] | null {
  if (!HAS_DIGIT.test(w) || !HAS_LETTER.test(w)) return null;
  const runs = w.match(/\p{L}+|\p{N}+/gu);
  return runs && runs.length > 1 ? runs : null;
}

/** Tokens to index for a text: every word, plus its letter and digit runs ("350ml" -> 350ml, 350, ml). */
export function indexTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of queryWords(s)) {
    out.push(w);
    const runs = mixedRuns(w);
    if (runs) out.push(...runs);
  }
  return out;
}
