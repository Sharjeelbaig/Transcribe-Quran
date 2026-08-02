export { processVideo } from "./pipeline.js";
export { loadQuranCorpus, buildQuranIndex } from "./quran/corpus.js";
export { normalizeArabic } from "./quran/normalize-arabic.js";
export { matchTranscript, materializeAlignedWords } from "./quran/matcher.js";
export {
  createAss,
  DEFAULT_CAPTION_GAP,
  DEFAULT_ARABIC_FONT_SIZE,
  DEFAULT_TRANSLATION_FONT_SIZE,
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_TRANSLATION_FONT_NAME,
} from "./captions/ass.js";
export { refineFinalWordTimings } from "./audio/timing.js";
export { transcribeAudio, DEFAULT_MODEL } from "./model/transcriber.js";
export type * from "./types.js";
