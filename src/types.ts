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

export type TimingSource = "recognizer" | "refined" | "guard-fallback" | "inferred" | "forced";

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
  /** The original ASR/matcher interval, retained when later audio timing is refined. */
  recognizerStart?: number;
  recognizerEnd?: number;
  /** The non-overlapping, frame-safe window used by ASS and the UI preview. */
  displayStart?: number;
  displayEnd?: number;
  timingSource?: TimingSource;
  /** True when the reciter stops after this word, so it may linger on screen. */
  endsSpeechSegment?: boolean;
}

export interface AlignmentDocument {
  schemaVersion: 1;
  packageVersion?: string;
  sourceVideo: string;
  model: string;
  translation: TranslationKey;
  durationSeconds: number;
  frameRate?: number;
  generatedAt: string;
  words: AlignedWord[];
  diagnostics: {
    transcriptWords: number;
    matchedWords: number;
    inferredWords: number;
    averageConfidence: number;
    timingFrameRate?: number;
    minimumCaptionFrames?: number;
    speechPauseSeconds?: number;
    speechExtendedWords?: number;
    refinementFallbackWords?: number;
    displayExtendedWords?: number;
    maximumDisplayShiftSeconds?: number;
    minimumDisplaySeconds?: number;
    belowMinimumWords?: number;
    speechSegments?: number;
    voicedSeconds?: number;
    /** Speech time, in seconds, with no caption on screen. */
    uncoveredSpeechSeconds?: number;
    /** Phrases the reciter's pauses divided the recording into. */
    phrases?: number;
    /** Phrases whose word timings were measured by forced alignment. */
    forcedPhrases?: number;
    /** Phrases that fell back to spreading the passage evenly. */
    estimatedPhrases?: number;
    /** Phrases no canonical passage could be identified for. */
    unmatchedPhrases?: number;
    tempo?: number;
  };
}

export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
}

export type ProcessStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface ProcessProgress {
  step: ProcessStep;
  message: string;
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
  captionGap?: number;
  /** Override auto-detected input FPS for frame-safe caption display. */
  frameRate?: number;
  /** Minimum number of video frames each caption should remain visible. */
  minimumCaptionFrames?: number;
  /** Absolute floor, in seconds, on how long each caption stays readable. */
  minimumWordSeconds?: number;
  /** Extra time a caption lingers into the silence after the reciter stops. */
  captionHoldSeconds?: number;
  /** How far reaching the minimum may delay a later caption. */
  maximumCaptionDriftSeconds?: number;
  /** Quiet-audio duration required before the reciter is considered to have stopped. */
  speechPauseSeconds?: number;
  /**
   * Playback rate applied to each phrase before recognition, undone afterwards.
   * Measured accuracy falls off sharply below 1.0, so the default is 1.0.
   */
  tempo?: number;
  confidenceThreshold: number;
  burnVideo: boolean;
  offline: boolean;
  keepTemporaryFiles: boolean;
  verbose: boolean;
  onProgress?: (progress: ProcessProgress) => void;
}
