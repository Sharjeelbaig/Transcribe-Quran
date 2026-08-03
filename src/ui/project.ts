import {
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_ARABIC_FONT_SIZE,
  DEFAULT_CAPTION_GAP,
  DEFAULT_TRANSLATION_FONT_NAME,
  DEFAULT_TRANSLATION_FONT_SIZE,
} from "../captions/ass.js";
import { DEFAULT_MODEL } from "../model/transcriber.js";
import type { AlignmentDocument, AlignedWord, TranslationKey } from "../types.js";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const DESIGN_WIDTH = 1080;
export const DESIGN_HEIGHT = 1920;

export interface UiCaptionSettings {
  wordsPerCaption: number;
  translation: TranslationKey;
  arabicFontName: string;
  translationFontName: string;
  arabicFontSize: number;
  translationFontSize: number;
  captionGap: number;
  confidenceThreshold: number;
  model: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  offline: boolean;
}

export interface UiPoint {
  x: number;
  y: number;
}

export interface UiCaptionLayer {
  position: UiPoint;
  fontSize: number;
  visual?: UiLayerVisual;
}

export type UiAnimationPreset = "none" | "fade" | "slide-up" | "slide-down" | "scale";

export interface UiLayerAnimation {
  preset: UiAnimationPreset;
  duration: number;
}

/** Shared appearance controls for caption and overlay layers. All fields are
 * optional so projects created by earlier releases stay valid. */
export interface UiLayerVisual {
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
  animationIn?: UiLayerAnimation;
  animationOut?: UiLayerAnimation;
}

export interface UiOverlay {
  id: string;
  type: "text" | "image";
  text?: string;
  source?: string;
  position: UiPoint;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  color?: string;
  visible: boolean;
  start?: number;
  end?: number;
  locked?: boolean;
  zIndex?: number;
  visual?: UiLayerVisual;
}

export interface UiCaptionEdit {
  arabic?: string;
  wordTranslation?: string;
  start?: number;
  end?: number;
  hidden?: boolean;
}

export type UiCaptionEdits = Record<string, UiCaptionEdit>;

export interface UiProject {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  videoName?: string;
  videoPath?: string;
  durationSeconds?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  settings: UiCaptionSettings;
  layout: {
    arabic: UiCaptionLayer;
    translation: UiCaptionLayer;
  };
  overlays: UiOverlay[];
  captionEdits: UiCaptionEdits;
}

/** Stable within one generated alignment and shared by the UI and exporter. */
export function captionEventId(word: Pick<AlignedWord, "verseKey" | "position" | "canonicalIndex">, index: number): string {
  return `${word.verseKey}:${word.position}:${word.canonicalIndex}:${index}`;
}

function clampTime(value: number, duration: number): number {
  return Math.max(0, Math.min(duration, value));
}

export function applyCaptionEdits(alignment: AlignmentDocument, edits: UiCaptionEdits): AlignmentDocument {
  const words = alignment.words.flatMap((word, index) => {
    const edit = edits[captionEventId(word, index)];
    if (!edit) return [word];
    if (edit.hidden) return [];
    const maxStart = Math.max(0, alignment.durationSeconds - 0.01);
    const start = Math.min(maxStart, clampTime(edit.start ?? word.start, alignment.durationSeconds));
    const requestedEnd = clampTime(edit.end ?? word.end, alignment.durationSeconds);
    const end = Math.max(start + 0.01, requestedEnd);
    return [{
      ...word,
      ...(edit.arabic !== undefined ? { arabic: edit.arabic } : {}),
      ...(edit.wordTranslation !== undefined ? { wordTranslation: edit.wordTranslation } : {}),
      start,
      end: Math.min(alignment.durationSeconds, end),
      displayStart: start,
      displayEnd: Math.min(alignment.durationSeconds, end),
    }];
  });
  return {
    ...alignment,
    words,
    diagnostics: {
      ...alignment.diagnostics,
      matchedWords: words.length,
      inferredWords: words.filter((word) => word.inferredTiming).length,
    },
  };
}

export function defaultCaptionLayerPositions(settings: Pick<UiCaptionSettings, "arabicFontSize" | "translationFontSize" | "captionGap">): UiProject["layout"] {
  const centerY = DESIGN_HEIGHT / 2;
  return {
    arabic: {
      position: {
        x: DESIGN_WIDTH / 2,
        y: Math.round(centerY - (settings.translationFontSize + settings.captionGap) / 2),
      },
      fontSize: settings.arabicFontSize,
    },
    translation: {
      position: {
        x: DESIGN_WIDTH / 2,
        y: Math.round(centerY + (settings.arabicFontSize + settings.captionGap) / 2),
      },
      fontSize: settings.translationFontSize,
    },
  };
}

export function defaultUiSettings(): UiCaptionSettings {
  return {
    wordsPerCaption: 1,
    translation: "saheehInternational",
    arabicFontName: DEFAULT_ARABIC_FONT_NAME,
    translationFontName: DEFAULT_TRANSLATION_FONT_NAME,
    arabicFontSize: DEFAULT_ARABIC_FONT_SIZE,
    translationFontSize: DEFAULT_TRANSLATION_FONT_SIZE,
    captionGap: DEFAULT_CAPTION_GAP,
    confidenceThreshold: 0.5,
    model: DEFAULT_MODEL,
    dtype: "q8",
    offline: false,
  };
}

export function createEmptyProject(): UiProject {
  const settings = defaultUiSettings();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    settings,
    layout: defaultCaptionLayerPositions(settings),
    overlays: [],
    captionEdits: {},
  };
}

export function projectWithVideo(
  base: UiProject,
  video: { path: string; name: string; durationSeconds?: number; width?: number; height?: number },
): UiProject {
  return {
    ...base,
    videoPath: video.path,
    videoName: video.name,
    ...(video.durationSeconds !== undefined ? { durationSeconds: video.durationSeconds } : {}),
    ...(video.width !== undefined ? { sourceWidth: video.width } : {}),
    ...(video.height !== undefined ? { sourceHeight: video.height } : {}),
  };
}
