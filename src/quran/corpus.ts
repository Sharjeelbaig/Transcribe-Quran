import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IndexedWord, QuranCorpus, QuranVerse } from "../types.js";
import { normalizeArabic } from "./normalize-arabic.js";

export interface QuranIndex {
  corpus: QuranCorpus;
  words: IndexedWord[];
  postings: Map<string, number[]>;
  verses: Map<string, QuranVerse>;
}

export function defaultCorpusPath(): string {
  const candidates = [
    // Bundled package: dist/index.js -> quran.json
    fileURLToPath(new URL("../quran.json", import.meta.url)),
    // TypeScript source/tests: src/quran/corpus.ts -> quran.json
    fileURLToPath(new URL("../../quran.json", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

export async function loadQuranCorpus(path = defaultCorpusPath()): Promise<QuranCorpus> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as QuranCorpus;
  if (parsed.totals?.surahs !== 114 || parsed.totals?.verses !== 6236) {
    throw new Error(`Invalid Qur'an corpus at ${path}`);
  }
  return parsed;
}

export function buildQuranIndex(corpus: QuranCorpus): QuranIndex {
  const words: IndexedWord[] = [];
  const postings = new Map<string, number[]>();
  const verses = new Map<string, QuranVerse>();

  for (const surah of corpus.surahs) {
    for (const verse of surah.verses) {
      verses.set(verse.key, verse);
      for (const word of verse.words) {
        const normalized = normalizeArabic(word.text.imlaei || word.text.uthmani);
        const indexed: IndexedWord = {
          index: words.length,
          surah: surah.number,
          verse: verse.number,
          verseKey: verse.key,
          position: word.position,
          normalized,
          word,
          verseData: verse,
          surahData: surah,
        };
        words.push(indexed);
        const positions = postings.get(normalized);
        if (positions) positions.push(indexed.index);
        else postings.set(normalized, [indexed.index]);
      }
    }
  }

  if (words.length !== corpus.totals.words) {
    throw new Error(`Qur'an index expected ${corpus.totals.words} words, found ${words.length}`);
  }

  return { corpus, words, postings, verses };
}
