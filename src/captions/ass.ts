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
  arabicColor?: string;
  arabicHighlightColor?: string;
  translationColor?: string;
  arabicFontSize?: number;
  translationFontSize?: number;
  captionGap?: number;
  minimumDisplaySeconds?: number;
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
  outlineEnabled?: boolean;
  outlineOpacity?: number;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowDistance?: number;
  shadowEnabled?: boolean;
  animationIn?: AssLayerAnimation;
  animationOut?: AssLayerAnimation;
}

export type AssAnimationPreset = "none" | "fade" | "slide-up" | "slide-down" | "scale";

export interface AssLayerAnimation {
  preset?: AssAnimationPreset;
  duration?: number;
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

function visualStyle(
  visual: AssLayerVisual | undefined,
  defaults: { outline: number; shadow: number },
  primaryColor: string | undefined,
): { primary: string; outline: string; back: string; outlineWidth: number; shadowDistance: number; rotation: number } {
  return {
    primary: assColour(primaryColor, visual?.opacity ?? 1),
    outline: assColour(visual?.outlineColor, visual?.outlineOpacity ?? 1, "101010"),
    back: visual?.shadowEnabled === false ? "&HFF000000"
      : visual?.shadowColor !== undefined || visual?.shadowOpacity !== undefined
      ? assColour(visual.shadowColor, visual.shadowOpacity ?? 0.44, "000000")
      : "&H90000000",
    outlineWidth: visual?.outlineEnabled === false ? 0 : clamp(visual?.outlineWidth ?? defaults.outline, 0, 20),
    shadowDistance: visual?.shadowEnabled === false ? 0 : clamp(visual?.shadowDistance ?? defaults.shadow, 0, 20),
    rotation: Number.isFinite(visual?.rotation) ? visual!.rotation! : 0,
  };
}

function animationDuration(animation: AssLayerAnimation | undefined, spanSeconds: number): number {
  if (!animation?.preset || animation.preset === "none") return 0;
  // Entry and exit are deliberately capped at half the event. That avoids a
  // transition hiding the whole word while leaving the measured speech window
  // intact; the user-selected duration is otherwise honored.
  const maximum = Math.max(0, Math.floor(spanSeconds * 500));
  return clamp(Math.round(animation.duration ?? 250), 0, maximum);
}

type AnimationPhase = "base" | "enter" | "exit";

interface AnimationSegment {
  start: number;
  end: number;
  phase: AnimationPhase;
  animation?: AssLayerAnimation;
}

function animationSegments(visual: AssLayerVisual | undefined, start: number, end: number): AnimationSegment[] {
  const span = Math.max(0, end - start);
  const enterAnimation = visual?.animationIn;
  const exitAnimation = visual?.animationOut;
  const enterDuration = animationDuration(enterAnimation, span);
  const exitDuration = animationDuration(exitAnimation, span);
  const enterEnd = start + enterDuration / 1000;
  const exitStart = end - exitDuration / 1000;
  const segments: AnimationSegment[] = [];
  if (enterDuration > 0 && enterAnimation) segments.push({ start, end: enterEnd, phase: "enter", animation: enterAnimation });
  if (exitStart - enterEnd >= 0.01) segments.push({ start: enterEnd, end: exitStart, phase: "base" });
  if (exitDuration > 0 && exitAnimation) segments.push({ start: exitStart, end, phase: "exit", animation: exitAnimation });
  if (!segments.length) segments.push({ start, end, phase: "base" });
  return segments;
}

function alphaTag(opacity: number | undefined): string {
  const alpha = Math.round((1 - clamp(opacity ?? 1, 0, 1)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${alpha}&`;
}

function transitionTag(
  position: AssPosition,
  fontSize: number,
  visual: AssLayerVisual | undefined,
  phase: AnimationPhase,
  animation: AssLayerAnimation | undefined,
  spanSeconds: number,
): string {
  const rotation = Number.isFinite(visual?.rotation) && visual?.rotation ? `\\frz${visual.rotation}` : "";
  const basePosition = `\\pos(${position.x},${position.y})`;
  if (phase === "base" || !animation?.preset || animation.preset === "none") return `\\an5${basePosition}${rotation}`;

  const duration = Math.max(0, Math.round(spanSeconds * 1000));
  const baseAlpha = alphaTag(visual?.opacity);
  const transparent = "&HFF&";
  const distance = Math.max(18, Math.round(fontSize * 0.18));
  const movingUp = animation.preset === "slide-up";
  const direction = movingUp ? -1 : 1;
  const startY = position.y - direction * distance;
  const endY = position.y + direction * distance;

  if (animation.preset === "slide-up" || animation.preset === "slide-down") {
    const move = phase === "enter"
      ? `\\move(${position.x},${startY},${position.x},${position.y},0,${duration})`
      : `\\move(${position.x},${position.y},${position.x},${endY},0,${duration})`;
    const alpha = phase === "enter"
      ? `\\alpha${transparent}\\t(0,${duration},\\alpha${baseAlpha})`
      : `\\t(0,${duration},\\alpha${transparent})`;
    return `\\an5${move}${rotation}${alpha}`;
  }

  if (animation.preset === "scale") {
    const scale = phase === "enter"
      ? `\\fscx82\\fscy82\\alpha${transparent}\\t(0,${duration},\\fscx100\\fscy100\\alpha${baseAlpha})`
      : `\\t(0,${duration},\\fscx112\\fscy112\\alpha${transparent})`;
    return `\\an5${basePosition}${rotation}${scale}`;
  }

  const fade = phase === "enter"
    ? `\\alpha${transparent}\\t(0,${duration},\\alpha${baseAlpha})`
    : `\\t(0,${duration},\\alpha${transparent})`;
  return `\\an5${basePosition}${rotation}${fade}`;
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

function contextLine(
  word: AlignedWord,
  index: QuranIndex,
  wordsPerCaption: number,
  baseColor: string | undefined,
  activeColor: string | undefined,
): string {
  const normal = `${assColour(baseColor)}&`;
  const activeTag = `${assColour(activeColor ?? "#FFD700")}&`;
  const verse = index.verses.get(word.verseKey);
  if (!verse || wordsPerCaption === 1) {
    return `{\\c${activeTag}\\b1}${isolatedArabic(word.arabic)}{\\c${normal}\\b0}`;
  }
  const activePosition = Math.max(0, word.position - 1);
  const start = Math.floor(activePosition / wordsPerCaption) * wordsPerCaption;
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
        ? `{\\c${activeTag}\\b1}${isolated}{\\c${normal}\\b0}`
        : isolated;
    })
    .join("\u00A0");
  // The token sequence is intentionally left-to-right because its array was
  // reversed above; right-aligned placement makes the first recited word the
  // rightmost item on screen.
  return `${LTR_EMBED}${line}${POP_DIRECTIONAL_FORMATTING}`;
}

function captionGroup(words: AlignedWord[], word: AlignedWord, wordsPerCaption: number): {
  words: AlignedWord[];
  start: number;
  end: number;
} {
  const groupStart = Math.floor((Math.max(1, word.position) - 1) / wordsPerCaption) * wordsPerCaption + 1;
  const group = words
    .filter((candidate) => candidate.verseKey === word.verseKey && candidate.position >= groupStart && candidate.position < groupStart + wordsPerCaption)
    .sort((left, right) => left.position - right.position);
  const first = group[0] ?? word;
  const last = group.at(-1) ?? word;
  return {
    words: group.length ? group : [word],
    start: first.displayStart ?? first.start,
    end: last.displayEnd ?? last.end,
  };
}

function edgeVisual(visual: AssLayerVisual | undefined, allowIn: boolean, allowOut: boolean): AssLayerVisual | undefined {
  if (!visual) return undefined;
  const next = { ...visual };
  if (!allowIn) delete next.animationIn;
  if (!allowOut) delete next.animationOut;
  return next;
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
  const minimumDisplaySeconds = options.minimumDisplaySeconds ?? 0.08;
  if (!Number.isFinite(minimumDisplaySeconds) || minimumDisplaySeconds <= 0) {
    throw new Error("minimumDisplaySeconds must be a positive number.");
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
  const arabicVisual = visualStyle(options.arabicVisual, { outline: 4, shadow: 1 }, options.arabicColor);
  const translationVisual = visualStyle(options.translationVisual, { outline: 3, shadow: 1 }, options.translationColor);
  const arabicHighlightColor = options.arabicHighlightColor ?? "#FFD700";
  const header = `[Script Info]
; Generated by transcribe-quran
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Quran,${arabicFontName},${arabicFontSize},${arabicVisual.primary},${assColour(arabicHighlightColor)},${arabicVisual.outline},${arabicVisual.back},0,0,0,0,100,100,0,0,1,${arabicVisual.outlineWidth},${arabicVisual.shadowDistance},5,70,70,0,1
Style: Translation,${translationFontName},${translationFontSize},${translationVisual.primary},${translationVisual.primary},${translationVisual.outline},${translationVisual.back},0,0,0,0,100,100,0,0,1,${translationVisual.outlineWidth},${translationVisual.shadowDistance},5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events: string[] = [];
  for (const word of words) {
    // A supplied display window has already been solved to be ordered,
    // non-overlapping, and as long as the recitation allows. Re-applying a
    // minimum here would stretch a caption the solver deliberately shortened,
    // and push it over the one after it.
    const solved = word.displayStart !== undefined && word.displayEnd !== undefined;
    const group = captionGroup(words, word, wordsPerCaption);
    const firstInGroup = group.words[0] === word;
    const lastInGroup = group.words.at(-1) === word;
    const wordStart = word.displayStart ?? word.start;
    const wordEnd = solved
      ? Math.max(word.displayEnd!, wordStart)
      : Math.max(word.end, wordStart + minimumDisplaySeconds);
    const captionStart = firstInGroup ? group.start : wordStart;
    const captionEnd = lastInGroup ? Math.max(group.end, wordEnd) : wordEnd;
    const arabicVisual = edgeVisual(options.arabicVisual, firstInGroup, lastInGroup);
    const translationVisual = edgeVisual(options.translationVisual, firstInGroup, lastInGroup);
    for (const segment of animationSegments(arabicVisual, captionStart, captionEnd)) {
      events.push(
        `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Quran,,0,0,0,,{${transitionTag(arabicPosition, arabicFontSize, arabicVisual, segment.phase, segment.animation, segment.end - segment.start)}}${contextLine(word, index, wordsPerCaption, options.arabicColor, arabicHighlightColor)}`,
      );
    }
    for (const segment of animationSegments(translationVisual, captionStart, captionEnd)) {
      events.push(
        `Dialogue: 1,${assTime(segment.start)},${assTime(segment.end)},Translation,,0,0,0,,{${transitionTag(translationPosition, translationFontSize, translationVisual, segment.phase, segment.animation, segment.end - segment.start)}}${escapeAss(word.wordTranslation)}  •  ${word.verseKey}`,
      );
    }
  }
  return header + events.join("\n") + "\n";
}
