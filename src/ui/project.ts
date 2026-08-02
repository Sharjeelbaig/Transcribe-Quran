import {
  DEFAULT_ARABIC_FONT_NAME,
  DEFAULT_ARABIC_FONT_SIZE,
  DEFAULT_CAPTION_GAP,
  DEFAULT_TRANSLATION_FONT_NAME,
  DEFAULT_TRANSLATION_FONT_SIZE,
} from "../captions/ass.js";
import { DEFAULT_MODEL } from "../model/transcriber.js";
import type { TranslationKey } from "../types.js";

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
}

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
