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
import { DEFAULT_MODEL } from "./model/session.js";
import { startUiServer } from "./ui/server.js";
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
  npx transcribe-quran [video] [options]

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
      --frame-rate <fps>      Override source FPS when it cannot be detected
      --min-caption-frames <n>
                              Keep each caption visible for at least n frames (3)
      --min-word-seconds <seconds>
                              Keep each caption readable for at least this long (0.50)
      --caption-hold <seconds>
                              Linger after the reciter stops a phrase (0.35)
      --max-caption-drift <seconds>
                              How far a caption may lag the audio to stay readable (0.40)
      --speech-pause <seconds>
                              Quiet time that marks the end of recitation (0.60)
      --tempo <rate>          Speed each phrase is recognized at, undone afterwards.
                              Below 1.0 measurably hurts accuracy (1.0)
      --offline               Forbid all network model access
      --no-burn               Only create alignment JSON and ASS subtitles
      --keep-temp             Retain extracted audio and temporary files
      --ui                    Launch the local browser editor
      --port <number>         UI server port (4317)
      --no-open               Do not open the browser automatically with --ui
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
      "frame-rate": { type: "string" },
      "min-caption-frames": { type: "string", default: "3" },
      "min-word-seconds": { type: "string", default: "0.50" },
      "caption-hold": { type: "string", default: "0.35" },
      "max-caption-drift": { type: "string", default: "0.40" },
      "speech-pause": { type: "string", default: "0.60" },
      tempo: { type: "string", default: "1.0" },
      offline: { type: "boolean", default: false },
      "no-burn": { type: "boolean", default: false },
      "keep-temp": { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      port: { type: "string", default: "4317" },
      "no-open": { type: "boolean", default: false },
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
  if (parsed.positionals.length > 1) throw new Error("Only one input video may be processed per command.");
  if (!input && !parsed.values.ui) throw new Error(`Missing input video.\n\n${HELP}`);
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
  const requestedFrameRate = parsed.values["frame-rate"] === undefined ? undefined : Number(parsed.values["frame-rate"]);
  const minimumCaptionFrames = Number(parsed.values["min-caption-frames"]);
  const minimumWordSeconds = Number(parsed.values["min-word-seconds"]);
  const captionHoldSeconds = Number(parsed.values["caption-hold"]);
  const maximumCaptionDriftSeconds = Number(parsed.values["max-caption-drift"]);
  const speechPauseSeconds = Number(parsed.values["speech-pause"]);
  const tempo = Number(parsed.values.tempo);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error("--font-size must be a positive number.");
  }
  if (!Number.isFinite(translationFontSize) || translationFontSize <= 0) {
    throw new Error("--translation-font-size must be a positive number.");
  }
  if (!Number.isFinite(captionGap) || captionGap < 0) {
    throw new Error("--caption-gap must be a non-negative number.");
  }
  if (requestedFrameRate !== undefined && (!Number.isFinite(requestedFrameRate) || requestedFrameRate <= 0)) {
    throw new Error("--frame-rate must be a positive number.");
  }
  if (!Number.isSafeInteger(minimumCaptionFrames) || minimumCaptionFrames < 1) {
    throw new Error("--min-caption-frames must be a positive integer.");
  }
  if (!Number.isFinite(speechPauseSeconds) || speechPauseSeconds <= 0) {
    throw new Error("--speech-pause must be a positive number of seconds.");
  }
  if (!Number.isFinite(minimumWordSeconds) || minimumWordSeconds <= 0) {
    throw new Error("--min-word-seconds must be a positive number of seconds.");
  }
  if (!Number.isFinite(captionHoldSeconds) || captionHoldSeconds < 0) {
    throw new Error("--caption-hold must be a non-negative number of seconds.");
  }
  if (!Number.isFinite(maximumCaptionDriftSeconds) || maximumCaptionDriftSeconds < 0) {
    throw new Error("--max-caption-drift must be a non-negative number of seconds.");
  }
  if (!Number.isFinite(tempo) || tempo <= 0) {
    throw new Error("--tempo must be a positive number.");
  }
  const port = Number(parsed.values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  const fontName = parsed.values.font.trim();
  const translationFontName = parsed.values["translation-font"].trim();
  if (!fontName || /[,\\\r\n]/.test(fontName)) {
    throw new Error("--font must be a non-empty font family name without commas or line breaks.");
  }
  if (!translationFontName || /[,\\\r\n]/.test(translationFontName)) {
    throw new Error("--translation-font must be a non-empty font family name without commas or line breaks.");
  }

  if (parsed.values.ui) {
    const uiServer = await startUiServer({
      ...(input ? { input } : {}),
      port,
      openBrowser: !parsed.values["no-open"],
      settings: {
        wordsPerCaption,
        translation: valueIn(parsed.values.translation, TRANSLATIONS, "translation"),
        arabicFontName: fontName,
        translationFontName,
        arabicFontSize: fontSize,
        translationFontSize,
        captionGap,
        speechPauseSeconds,
        confidenceThreshold,
        model: parsed.values.model,
        dtype: valueIn(parsed.values.dtype, ["fp32", "fp16", "q8", "q4"] as const, "dtype"),
        offline: parsed.values.offline,
      },
    });
    const shutdown = async () => {
      await uiServer.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  if (!input) throw new Error(`Missing input video.\n\n${HELP}`);

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
    ...(requestedFrameRate !== undefined ? { frameRate: requestedFrameRate } : {}),
    minimumCaptionFrames,
    minimumWordSeconds,
    captionHoldSeconds,
    maximumCaptionDriftSeconds,
    speechPauseSeconds,
    tempo,
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
  const timing = result.alignment.diagnostics;
  console.log(
    `Captioned ${timing.matchedWords} canonical words from ${timing.transcriptWords} recognized ` +
      `(average passage confidence ${(timing.averageConfidence * 100).toFixed(1)}%).`,
  );
  console.log(
    `Phrases: ${timing.phrases ?? 0} total — ${timing.forcedPhrases ?? 0} with forced word alignment, ` +
      `${timing.estimatedPhrases ?? 0} estimated, ${timing.unmatchedPhrases ?? 0} unidentified` +
      `${(timing.tempo ?? 1) !== 1 ? `, recognized at ${timing.tempo}x` : ""}.`,
  );
  console.log(
    `Frame-safe timing: ${timing.timingFrameRate?.toFixed(3) ?? "unknown"} fps, ` +
      `${timing.minimumCaptionFrames ?? "?"} minimum frames, ${timing.displayExtendedWords ?? 0} display extensions.`,
  );
  if (timing.voicedSeconds !== undefined) {
    const uncovered = timing.uncoveredSpeechSeconds ?? 0;
    console.log(
      `Caption coverage: ${(100 - (uncovered / Math.max(timing.voicedSeconds, 1e-6)) * 100).toFixed(1)}% of ` +
        `${timing.voicedSeconds.toFixed(1)} s of recitation is captioned ` +
        `(${uncovered.toFixed(1)} s uncovered across ${timing.speechSegments ?? 0} phrases).`,
    );
  }
  if (timing.belowMinimumWords) {
    console.log(
      `Note: ${timing.belowMinimumWords} caption(s) stayed under the ${timing.minimumDisplaySeconds?.toFixed(2) ?? "?"} s ` +
        `minimum because the recitation was too fast to hold them longer without lagging the audio.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`transcribe-quran: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
