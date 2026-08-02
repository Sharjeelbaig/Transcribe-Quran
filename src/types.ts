export interface QuranText {
  uthmani: string;
  uthmaniSimple: string;
  imlaei: string;
  indopak: string;
}

export interface QuranWordText {
  uthmani: string;
  imlaei: string;
  indopak: string;
}

export interface QuranWord {
  position: number;
  location: string;
  text: QuranWordText;
  translation: string;
}

export type TranslationKey =
  | "saheehInternational"
  | "abdulHaleem"
  | "taqiUsmani"
  | "pickthall"
  | "yusufAli";

export interface QuranVerse {
  number: number;
  key: string;
  juzNumber: number;
  pageNumber: number;
  hizbNumber: number;
  rubElHizbNumber: number;
  rukuNumber: number;
  manzilNumber: number;
  sajdahNumber: number | null;
  text: QuranText;
  translations: Record<TranslationKey, string>;
  words: QuranWord[];
}

export interface QuranSurah {
  number: number;
  name: string;
  arabicName: string;
  translatedName: string;
  revelationPlace: string;
  revelationOrder: number;
  bismillahPre: boolean;
  versesCount: number;
  pages: [number, number];
  verses: QuranVerse[];
}

export interface QuranCorpus {
  schemaVersion: number;
  source: {
    provider: string;
    website: string;
    notice: string;
  };
  translationResources: Record<
    TranslationKey,
    { id: number; name: string; author: string; language: string; slug: string }
  >;
  totals: { surahs: number; verses: number; words: number };
  surahs: QuranSurah[];
}

export interface IndexedWord {
  index: number;
  surah: number;
  verse: number;
  verseKey: string;
  position: number;
  normalized: string;
  word: QuranWord;
  verseData: QuranVerse;
  surahData: QuranSurah;
}

export interface TranscriptWord {
  text: string;
  normalized: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface MatchedTranscriptWord extends TranscriptWord {
  canonicalIndex: number;
  matchConfidence: number;
  inferredTiming?: boolean;
}

export interface AlignedWord {
  start: number;
  end: number;
  surah: number;
  verse: number;
  verseKey: string;
  position: number;
  arabic: string;
  imlaei: string;
  wordTranslation: string;
  verseTranslation: string;
  confidence: number;
  inferredTiming: boolean;
  canonicalIndex: number;
}

export interface AlignmentDocument {
  schemaVersion: 1;
  sourceVideo: string;
  model: string;
  translation: TranslationKey;
  durationSeconds: number;
  generatedAt: string;
  words: AlignedWord[];
  diagnostics: {
    transcriptWords: number;
    matchedWords: number;
    inferredWords: number;
    averageConfidence: number;
  };
}

export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
}

export interface ProcessOptions {
  input: string;
  output?: string;
  alignmentOutput?: string;
  subtitleOutput?: string;
  model: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  translation: TranslationKey;
  wordsPerCaption?: number;
  fontName?: string;
  translationFontName?: string;
  fontSize?: number;
  translationFontSize?: number;
  confidenceThreshold: number;
  burnVideo: boolean;
  offline: boolean;
  keepTemporaryFiles: boolean;
  verbose: boolean;
}
