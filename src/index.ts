export { processVideo } from "./pipeline.js";
export { loadQuranCorpus, buildQuranIndex } from "./quran/corpus.js";
export { normalizeArabic } from "./quran/normalize-arabic.js";
export { matchTranscript, materializeAlignedWords } from "./quran/matcher.js";
export {
  createAss,
  type AssPosition,
  DEFAULT_CAPTION_GAP,
  DEFAULT_ARABIC_FONT_SIZE,
  DEFAULT_TRANSLATION_FONT_SIZE,
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_TRANSLATION_FONT_NAME,
} from "./captions/ass.js";
export {
  DEFAULT_SPEECH_PAUSE_SECONDS,
  analyzeSpeech,
  distributeAcrossSpeech,
  measureCaptionCoverage,
  placeInferredWordsOnSpeech,
  refineFinalWordTimings,
  refineSpeechWordTimings,
  type SpeechAnalysis,
  type SpeechSegment,
  type SpeechTimingOptions,
} from "./audio/timing.js";
export {
  protectWordTimings,
  DEFAULT_FALLBACK_FRAME_RATE,
  DEFAULT_MAXIMUM_DISPLAY_DRIFT_SECONDS,
  DEFAULT_MINIMUM_CAPTION_FRAMES,
  DEFAULT_MINIMUM_WORD_SECONDS,
  DEFAULT_SEGMENT_HOLD_SECONDS,
  type TimingGuardOptions,
  type TimingGuardResult,
} from "./audio/timing-guard.js";
export {
  createModelSession,
  spokenForm,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  MAX_SEGMENT_SECONDS,
  type ForcedSpan,
  type ModelSession,
  type ModelSessionOptions,
} from "./model/session.js";
export { buildPhraseSegments, type PhraseSegment } from "./audio/segmenter.js";
export { atempoFilters, stretchAudio } from "./audio/tempo.js";
export {
  canonicalSpanOf,
  evenTimings,
  materializeSpan,
  reconcileSpan,
  type CanonicalSpan,
} from "./quran/passage.js";
export type * from "./types.js";
