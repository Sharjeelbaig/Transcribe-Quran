import {
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_CAPTION_GAP,
  DEFAULT_TRANSLATION_FONT_NAME,
} from "../captions/ass.js";
import { DEFAULT_MODEL } from "../model/session.js";
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
  /** Sustained quiet audio required before a reciter is considered stopped. */
  speechPauseSeconds: number;
  /** Absolute floor on how long each caption stays readable. */
  minimumWordSeconds: number;
  /** Extra time a caption lingers into the silence after the reciter stops. */
  captionHoldSeconds: number;
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
  /** Fill colour for this caption layer. */
  color: string;
  /** Fill colour for the Arabic word currently being recited. */
  highlightColor?: string;
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
  /** Marks a text overlay whose text is a template (e.g. "Detected chapter: {surah}")
   * re-substituted with the recognized surah name as the recitation progresses. */
  autoSurah?: boolean;
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
  return {
    arabic: {
      position: {
        x: 540,
        y: 893.6249952746381,
      },
      fontSize: settings.arabicFontSize,
      color: "#FFFFFF",
      highlightColor: "#FFD700",
      visual: {
        opacity: 1,
        rotation: 0,
        outlineWidth: 0,
        shadowDistance: 20,
        outlineColor: "#101010",
        shadowColor: "#000000",
        outlineEnabled: false,
        shadowEnabled: true,
        outlineOpacity: 1,
        shadowOpacity: 1,
        animationIn: { preset: "none", duration: 250 },
        animationOut: { preset: "none", duration: 250 },
      },
    },
    translation: {
      position: {
        x: 540.9645317683082,
        y: 1456.3911465618266,
      },
      fontSize: settings.translationFontSize,
      color: "#E1FF00",
      visual: {
        opacity: 1,
        rotation: 0,
        outlineWidth: 10.5,
        shadowDistance: 1,
        outlineColor: "#000000",
        shadowColor: "#000000",
        outlineEnabled: false,
        shadowEnabled: true,
        outlineOpacity: 0,
        shadowOpacity: 1,
        animationIn: { preset: "none", duration: 250 },
        animationOut: { preset: "none", duration: 250 },
      },
    },
  };
}

export function defaultUiSettings(): UiCaptionSettings {
  return {
    wordsPerCaption: 3,
    translation: "saheehInternational",
    arabicFontName: DEFAULT_ARABIC_FONT_NAME,
    translationFontName: DEFAULT_TRANSLATION_FONT_NAME,
    arabicFontSize: 407,
    translationFontSize: 150,
    captionGap: DEFAULT_CAPTION_GAP,
    speechPauseSeconds: 0.6,
    minimumWordSeconds: 0.5,
    captionHoldSeconds: 0.35,
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
    overlays: [{
      id: "surah-default",
      type: "text",
      text: "{surah}",
      autoSurah: true,
      position: { x: 0.5007408352470869, y: 0.2696737610100933 },
      width: 0.37051756400442293,
      height: 0.03,
      fontName: "Arial",
      fontSize: 111,
      color: "#FFFFFF",
      visible: true,
      start: 0,
      visual: {
        opacity: 1,
        outlineWidth: 3,
        shadowDistance: 7.5,
        outlineColor: "#101010",
        shadowColor: "#000000",
        outlineEnabled: false,
        shadowEnabled: false,
        shadowOpacity: 1,
        animationIn: { preset: "none", duration: 250 },
        animationOut: { preset: "none", duration: 250 },
      },
    }],
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
