#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { processVideo } from "./pipeline.js";
import {
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_ARABIC_FONT_SIZE,
  DEFAULT_CAPTION_GAP,
  DEFAULT_TRANSLATION_FONT_NAME,
  DEFAULT_TRANSLATION_FONT_SIZE,
} from "./captions/ass.js";
import { DEFAULT_MODEL } from "./model/transcriber.js";
import type { ProcessOptions, TranslationKey } from "./types.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = packageMetadata.version;
const TRANSLATIONS: TranslationKey[] = [
  "saheehInternational",
  "abdulHaleem",
  "taqiUsmani",
  "pickthall",
  "yusufAli",
];

const HELP = `transcribe-quran ${VERSION}

Create fully local, canonical Qur'an word-by-word captions for a video.

Usage:
  npx transcribe-quran <video> [options]

Options:
  -o, --output <path>         Captioned video output path
      --alignment <path>      Alignment JSON output path
      --subtitles <path>      ASS subtitle output path
      --model <id-or-path>    Transformers.js ONNX model (${DEFAULT_MODEL})
      --dtype <q8|q4|fp32>    Model precision (q8)
      --translation <name>    Verse translation (saheehInternational)
      --words <count>         Maximum Arabic words shown at once (1)
      --font-size <number>    Arabic caption font size (${DEFAULT_ARABIC_FONT_SIZE})
      --translation-font-size <number>
                              English caption font size (${DEFAULT_TRANSLATION_FONT_SIZE})
      --caption-gap <number>  Vertical gap between Arabic and English (${DEFAULT_CAPTION_GAP})
      --font <family>         Arabic caption font (${DEFAULT_ARABIC_FONT_NAME})
      --translation-font <family>
                              English caption font (${DEFAULT_TRANSLATION_FONT_NAME})
      --confidence <0..1>     Minimum passage match confidence (0.50)
      --offline               Forbid all network model access
      --no-burn               Only create alignment JSON and ASS subtitles
      --keep-temp             Retain extracted audio and temporary files
  -v, --verbose               Show model download and diagnostic progress
  -h, --help                  Show this help
      --version               Show the version

Translations:
  ${TRANSLATIONS.join(", ")}
`;

function valueIn<T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new Error(`Invalid ${label}: ${value}. Expected one of: ${values.join(", ")}`);
  return value as T;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string", short: "o" },
      alignment: { type: "string" },
      subtitles: { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL },
      dtype: { type: "string", default: "q8" },
      translation: { type: "string", default: "saheehInternational" },
      words: { type: "string", default: "1" },
      "font-size": { type: "string", default: String(DEFAULT_ARABIC_FONT_SIZE) },
      "translation-font-size": { type: "string", default: String(DEFAULT_TRANSLATION_FONT_SIZE) },
      "caption-gap": { type: "string", default: String(DEFAULT_CAPTION_GAP) },
      font: { type: "string", default: DEFAULT_ARABIC_FONT_NAME },
      "translation-font": { type: "string", default: DEFAULT_TRANSLATION_FONT_NAME },
      confidence: { type: "string", default: "0.50" },
      offline: { type: "boolean", default: false },
      "no-burn": { type: "boolean", default: false },
      "keep-temp": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }
  if (parsed.values.version) {
    console.log(VERSION);
    return;
  }
  const input = parsed.positionals[0];
  if (!input) throw new Error(`Missing input video.\n\n${HELP}`);
  if (parsed.positionals.length > 1) throw new Error("Only one input video may be processed per command.");
  const confidenceThreshold = Number(parsed.values.confidence);
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("--confidence must be a number between 0 and 1.");
  }
  const wordsPerCaption = Number(parsed.values.words);
  if (!Number.isSafeInteger(wordsPerCaption) || wordsPerCaption < 1) {
    throw new Error("--words must be a positive integer.");
  }
  const fontSize = Number(parsed.values["font-size"]);
  const translationFontSize = Number(parsed.values["translation-font-size"]);
  const captionGap = Number(parsed.values["caption-gap"]);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error("--font-size must be a positive number.");
  }
  if (!Number.isFinite(translationFontSize) || translationFontSize <= 0) {
    throw new Error("--translation-font-size must be a positive number.");
  }
  if (!Number.isFinite(captionGap) || captionGap < 0) {
    throw new Error("--caption-gap must be a non-negative number.");
  }
  const fontName = parsed.values.font.trim();
  const translationFontName = parsed.values["translation-font"].trim();
  if (!fontName || /[,\\\r\n]/.test(fontName)) {
    throw new Error("--font must be a non-empty font family name without commas or line breaks.");
  }
  if (!translationFontName || /[,\\\r\n]/.test(translationFontName)) {
    throw new Error("--translation-font must be a non-empty font family name without commas or line breaks.");
  }

  const options: ProcessOptions = {
    input,
    ...(parsed.values.output ? { output: parsed.values.output } : {}),
    ...(parsed.values.alignment ? { alignmentOutput: parsed.values.alignment } : {}),
    ...(parsed.values.subtitles ? { subtitleOutput: parsed.values.subtitles } : {}),
    model: parsed.values.model,
    dtype: valueIn(parsed.values.dtype, ["fp32", "fp16", "q8", "q4"] as const, "dtype"),
    translation: valueIn(parsed.values.translation, TRANSLATIONS, "translation"),
    wordsPerCaption,
    fontName,
    translationFontName,
    fontSize,
    translationFontSize,
    captionGap,
    confidenceThreshold,
    burnVideo: !parsed.values["no-burn"],
    offline: parsed.values.offline,
    keepTemporaryFiles: parsed.values["keep-temp"],
    verbose: parsed.values.verbose,
  };

  const result = await processVideo(options);
  console.log(`Alignment: ${result.alignmentPath}`);
  console.log(`Subtitles: ${result.subtitlePath}`);
  if (result.videoPath) console.log(`Video: ${result.videoPath}`);
  console.log(
    `Matched ${result.alignment.diagnostics.matchedWords}/${result.alignment.diagnostics.transcriptWords} recognized words ` +
      `(average confidence ${(result.alignment.diagnostics.averageConfidence * 100).toFixed(1)}%).`,
  );
}

main().catch((error: unknown) => {
  console.error(`transcribe-quran: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
