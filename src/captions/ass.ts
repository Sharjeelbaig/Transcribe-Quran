import type { AlignedWord } from "../types.js";
import type { QuranIndex } from "../quran/corpus.js";

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function escapeAss(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\r?\n/g, " ");
}

const RTL_ISOLATE = "\u2067";
const POP_DIRECTIONAL_ISOLATE = "\u2069";
const LTR_EMBED = "\u202A";
const POP_DIRECTIONAL_FORMATTING = "\u202C";

function isolatedArabic(value: string): string {
  return `${RTL_ISOLATE}${escapeAss(value)}${POP_DIRECTIONAL_ISOLATE}`;
}

const CAPTION_CENTER_X = 540;
const CAPTION_CENTER_Y = 960;
export const DEFAULT_CAPTION_GAP = 40;
export const DEFAULT_ARABIC_FONT_SIZE = 310;
export const DEFAULT_TRANSLATION_FONT_SIZE = 92;
export const DEFAULT_ARABIC_FONT_NAME = "Amiri Quran";
export const DEFAULT_TRANSLATION_FONT_NAME = "Arial";

export interface AssOptions {
  arabicFontName?: string;
  translationFontName?: string;
  arabicFontSize?: number;
  translationFontSize?: number;
  captionGap?: number;
  arabicPosition?: AssPosition;
  translationPosition?: AssPosition;
  arabicVisual?: AssLayerVisual;
  translationVisual?: AssLayerVisual;
}

export interface AssPosition {
  x: number;
  y: number;
}

export interface AssLayerVisual {
  opacity?: number;
  rotation?: number;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowDistance?: number;
  animationIn?: { preset?: "none" | "fade"; duration?: number };
  animationOut?: { preset?: "none" | "fade"; duration?: number };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assColour(hex: string | undefined, opacity = 1, fallback = "FFFFFF"): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  const rgb = match?.[1] ?? fallback;
  const alpha = Math.round((1 - clamp(opacity, 0, 1)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function visualStyle(visual: AssLayerVisual | undefined, defaults: { outline: number; shadow: number }): { primary: string; outline: string; back: string; outlineWidth: number; shadowDistance: number; rotation: number } {
  return {
    primary: assColour(undefined, visual?.opacity ?? 1),
    outline: assColour(visual?.outlineColor, 1, "101010"),
    back: visual?.shadowColor !== undefined || visual?.shadowOpacity !== undefined
      ? assColour(visual.shadowColor, visual.shadowOpacity ?? 0.44, "000000")
      : "&H90000000",
    outlineWidth: clamp(visual?.outlineWidth ?? defaults.outline, 0, 20),
    shadowDistance: clamp(visual?.shadowDistance ?? defaults.shadow, 0, 20),
    rotation: Number.isFinite(visual?.rotation) ? visual!.rotation! : 0,
  };
}

function animationTag(visual: AssLayerVisual | undefined, start: number, end: number): string {
  const durationMs = Math.max(80, Math.round((end - start) * 500));
  const inDuration = visual?.animationIn?.preset === "fade" ? clamp(Math.round(visual.animationIn.duration ?? 250), 0, durationMs) : 0;
  const outDuration = visual?.animationOut?.preset === "fade" ? clamp(Math.round(visual.animationOut.duration ?? 250), 0, durationMs) : 0;
  const rotation = Number.isFinite(visual?.rotation) && visual?.rotation ? `\\frz${visual.rotation}` : "";
  return `${rotation}${inDuration || outDuration ? `\\fad(${inDuration},${outDuration})` : ""}`;
}

function captionPositions(
  arabicFontSize: number,
  translationFontSize: number,
  captionGap: number,
): { arabicY: number; translationY: number } {
  // Keep the two lines as one vertically centered group while reserving a
  // real gap between their font boxes. Font sizes are in the ASS script's
  // design units, so this also adapts safely when users change either size.
  return {
    arabicY: Math.round(CAPTION_CENTER_Y - (translationFontSize + captionGap) / 2),
    translationY: Math.round(CAPTION_CENTER_Y + (arabicFontSize + captionGap) / 2),
  };
}

function validFontName(value: string, label: string): string {
  const name = value.trim();
  if (!name || /[,\\\r\n]/.test(name)) {
    throw new Error(`${label} must be a non-empty font family name without commas or line breaks.`);
  }
  return name;
}

function validPosition(value: AssPosition, label: string): AssPosition {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`${label} must contain finite x and y coordinates.`);
  }
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function contextLine(word: AlignedWord, index: QuranIndex, wordsPerCaption: number): string {
  const verse = index.verses.get(word.verseKey);
  if (!verse || wordsPerCaption === 1) {
    return `{\\c&H0000D7FF&\\b1}${isolatedArabic(word.arabic)}{\\c&H00FFFFFF&\\b0}`;
  }
  const active = Math.max(0, word.position - 1);
  const start = Math.floor(active / wordsPerCaption) * wordsPerCaption;
  const end = Math.min(verse.words.length, start + wordsPerCaption);

  // libass applies Unicode bidi after parsing inline highlight tags. Supplying
  // canonical Arabic order and relying on that pass can shuffle whole words.
  // Emit the desired visual order explicitly: later words first on the left,
  // the earliest word last on the right, while each word remains an RTL isolate.
  const line = verse.words
    .slice(start, end)
    .reverse()
    .map((item) => {
      const isolated = isolatedArabic(item.text.uthmani);
      return item.position === word.position
        ? `{\\c&H0000D7FF&\\b1}${isolated}{\\c&H00FFFFFF&\\b0}`
        : isolated;
    })
    .join("\u00A0");
  // The token sequence is intentionally left-to-right because its array was
  // reversed above; right-aligned placement makes the first recited word the
  // rightmost item on screen.
  return `${LTR_EMBED}${line}${POP_DIRECTIONAL_FORMATTING}`;
}

export function createAss(
  words: AlignedWord[],
  index: QuranIndex,
  wordsPerCaption = 1,
  options: AssOptions = {},
): string {
  if (!Number.isSafeInteger(wordsPerCaption) || wordsPerCaption < 1) {
    throw new Error("wordsPerCaption must be a positive integer.");
  }
  const arabicFontSize = options.arabicFontSize ?? DEFAULT_ARABIC_FONT_SIZE;
  const translationFontSize = options.translationFontSize ?? DEFAULT_TRANSLATION_FONT_SIZE;
  const captionGap = options.captionGap ?? DEFAULT_CAPTION_GAP;
  if (!Number.isFinite(arabicFontSize) || arabicFontSize <= 0) {
    throw new Error("arabicFontSize must be a positive number.");
  }
  if (!Number.isFinite(translationFontSize) || translationFontSize <= 0) {
    throw new Error("translationFontSize must be a positive number.");
  }
  if (!Number.isFinite(captionGap) || captionGap < 0) {
    throw new Error("captionGap must be a non-negative number.");
  }
  const arabicFontName = validFontName(
    options.arabicFontName ?? DEFAULT_ARABIC_FONT_NAME,
    "arabicFontName",
  );
  const translationFontName = validFontName(
    options.translationFontName ?? DEFAULT_TRANSLATION_FONT_NAME,
    "translationFontName",
  );
  const defaults = captionPositions(
    arabicFontSize,
    translationFontSize,
    captionGap,
  );
  const arabicPosition = validPosition(
    options.arabicPosition ?? { x: CAPTION_CENTER_X, y: defaults.arabicY },
    "arabicPosition",
  );
  const translationPosition = validPosition(
    options.translationPosition ?? { x: CAPTION_CENTER_X, y: defaults.translationY },
    "translationPosition",
  );
  const arabicVisual = visualStyle(options.arabicVisual, { outline: 4, shadow: 1 });
  const translationVisual = visualStyle(options.translationVisual, { outline: 3, shadow: 1 });
  const header = `[Script Info]
; Generated by transcribe-quran
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Quran,${arabicFontName},${arabicFontSize},${arabicVisual.primary},&H0000D7FF,${arabicVisual.outline},${arabicVisual.back},0,0,0,0,100,100,0,0,1,${arabicVisual.outlineWidth},${arabicVisual.shadowDistance},5,70,70,0,1
Style: Translation,${translationFontName},${translationFontSize},${translationVisual.primary},${translationVisual.primary},${translationVisual.outline},${translationVisual.back},0,0,0,0,100,100,0,0,1,${translationVisual.outlineWidth},${translationVisual.shadowDistance},5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events: string[] = [];
  for (const word of words) {
    const start = assTime(word.start);
    const end = assTime(Math.max(word.end, word.start + 0.08));
    events.push(
      `Dialogue: 0,${start},${end},Quran,,0,0,0,,{\\an5\\pos(${arabicPosition.x},${arabicPosition.y})${animationTag(options.arabicVisual, word.start, word.end)}}${contextLine(word, index, wordsPerCaption)}`,
    );
    events.push(
      `Dialogue: 1,${start},${end},Translation,,0,0,0,,{\\an5\\pos(${translationPosition.x},${translationPosition.y})${animationTag(options.translationVisual, word.start, word.end)}}${escapeAss(word.wordTranslation)}  •  ${word.verseKey}`,
    );
  }
  return header + events.join("\n") + "\n";
}
