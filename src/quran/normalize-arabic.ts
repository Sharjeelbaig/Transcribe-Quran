const DIACRITICS_AND_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const QURAN_ANNOTATION_MARKS = /[\u0600-\u0605\u06DD\u08D3-\u08FF\uE000-\uF8FF]/gu;
const NON_ARABIC = /[^\u0621-\u063A\u0641-\u064A\s]/gu;

/**
 * Produces a deliberately lossy form for matching ASR output to the corpus.
 * Display text must always come from quran.json, never from this function.
 */
export function normalizeArabic(value: string): string {
  return value
    .normalize("NFKD")
    .replace(DIACRITICS_AND_MARKS, "")
    .replace(QURAN_ANNOTATION_MARKS, "")
    .replace(/ـ/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ؤ/gu, "و")
    .replace(/ئ/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(NON_ARABIC, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function splitNormalizedArabic(value: string): string[] {
  const normalized = normalizeArabic(value);
  return normalized ? normalized.split(" ") : [];
}
