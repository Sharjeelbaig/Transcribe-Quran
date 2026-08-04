import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createAss } from "../captions/ass.js";
import { processVideo } from "../pipeline.js";
import { buildQuranIndex, loadQuranCorpus, type QuranIndex } from "../quran/corpus.js";
import { bundledFontDirectory, renderCaptionedVideo, type ImageOverlay } from "../video/render.js";
import type { AlignmentDocument, TranslationKey } from "../types.js";
import {
  applyCaptionEdits,
  createEmptyProject,
  defaultCaptionLayerPositions,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  projectWithVideo,
  type UiCaptionEdit,
  type UiCaptionSettings,
  type UiLayerAnimation,
  type UiLayerVisual,
  type UiProject,
  type UiOverlay,
} from "./project.js";

export interface StartUiServerOptions {
  input?: string;
  port: number;
  openBrowser: boolean;
  settings?: Partial<UiCaptionSettings>;
}

export interface UiServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

type Job = {
  status: "idle" | "running" | "complete" | "error";
  message?: string;
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function assetDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("../ui", import.meta.url)),
    fileURLToPath(new URL("../../ui", import.meta.url)),
    join(process.cwd(), "ui"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function requestBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeFilename(value: string): string {
  const name = basename(value || "video.mp4").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return name || "video.mp4";
}

async function detectFontFamily(path: string, fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("fc-scan", ["--format=%{family}\\n", path], { maxBuffer: 1024 * 1024 });
    const family = String(result.stdout).split(/\r?\n/)[0]?.split(",")[0]?.trim();
    return family || fallback;
  } catch {
    return fallback;
  }
}

async function systemFontFamilies(): Promise<string[]> {
  try {
    const result = await execFileAsync("fc-list", [":", "family"], { maxBuffer: 8 * 1024 * 1024 });
    return [...new Set(
      String(result.stdout)
        .split(/\r?\n/)
        .flatMap((line) => line.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    )];
  } catch {
    return [];
  }
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".ass") return "text/plain; charset=utf-8";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".otf") return "font/otf";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function fontFormat(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".woff2") return "woff2";
  if (extension === ".woff") return "woff";
  if (extension === ".otf") return "opentype";
  return "truetype";
}

async function serveAsset(path: string, res: ServerResponse): Promise<void> {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": contentType(path),
      "cache-control": "no-cache",
      "content-length": body.length,
    });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function streamVideo(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const information = await stat(path);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-type": contentType(path),
      "content-length": information.size,
      "accept-ranges": "bytes",
    });
    createReadStream(path).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { "content-range": `bytes */${information.size}` });
    res.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, information.size - Number(match[2] || 0));
  const requestedEnd = match[2] ? Number(match[2]) : information.size - 1;
  const end = Math.min(information.size - 1, requestedEnd);
  if (!Number.isSafeInteger(start) || start < 0 || start > end) {
    res.writeHead(416, { "content-range": `bytes */${information.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-type": contentType(path),
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${information.size}`,
    "accept-ranges": "bytes",
  });
  createReadStream(path, { start, end }).pipe(res);
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = browserCommand(url);
  const { spawn } = await import("node:child_process");
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function validTranslation(value: unknown): TranslationKey {
  const allowed: TranslationKey[] = [
    "saheehInternational",
    "abdulHaleem",
    "taqiUsmani",
    "pickthall",
    "yusufAli",
  ];
  if (typeof value !== "string" || !allowed.includes(value as TranslationKey)) {
    throw new Error(`Invalid translation. Expected one of: ${allowed.join(", ")}`);
  }
  return value as TranslationKey;
}

function validFont(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[,\\\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty font family name without commas or line breaks.`);
  }
  return value.trim();
}

function numeric(value: unknown, label: string, minimum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${label} must be at least ${minimum}.`);
  return number;
}

function captionEdits(value: unknown): UiProject["captionEdits"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const edits: UiProject["captionEdits"] = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>).slice(0, 10000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const input = raw as Record<string, unknown>;
    const edit: UiCaptionEdit = {};
    if (typeof input.arabic === "string") edit.arabic = input.arabic.slice(0, 2000);
    if (typeof input.wordTranslation === "string") edit.wordTranslation = input.wordTranslation.slice(0, 2000);
    for (const key of ["start", "end"] as const) {
      if (input[key] === undefined) continue;
      const number = Number(input[key]);
      if (Number.isFinite(number) && number >= 0) edit[key] = number;
    }
    if (input.hidden !== undefined) edit.hidden = Boolean(input.hidden);
    if (Object.keys(edit).length) edits[id.slice(0, 256)] = edit;
  }
  return edits;
}

function mergeSettings(base: UiCaptionSettings, incoming: Partial<UiCaptionSettings>): UiCaptionSettings {
  const next: UiCaptionSettings = {
    ...base,
    ...(incoming.wordsPerCaption !== undefined
      ? { wordsPerCaption: numeric(incoming.wordsPerCaption, "wordsPerCaption", 1) }
      : {}),
    ...(incoming.translation !== undefined ? { translation: validTranslation(incoming.translation) } : {}),
    ...(incoming.arabicFontName !== undefined
      ? { arabicFontName: validFont(incoming.arabicFontName, "arabicFontName") }
      : {}),
    ...(incoming.translationFontName !== undefined
      ? { translationFontName: validFont(incoming.translationFontName, "translationFontName") }
      : {}),
    ...(incoming.arabicFontSize !== undefined
      ? { arabicFontSize: numeric(incoming.arabicFontSize, "arabicFontSize", 0.1) }
      : {}),
    ...(incoming.translationFontSize !== undefined
      ? { translationFontSize: numeric(incoming.translationFontSize, "translationFontSize", 0.1) }
      : {}),
    ...(incoming.captionGap !== undefined
      ? { captionGap: numeric(incoming.captionGap, "captionGap", 0) }
      : {}),
    ...(incoming.speechPauseSeconds !== undefined
      ? { speechPauseSeconds: numeric(incoming.speechPauseSeconds, "speechPauseSeconds", 0.05) }
      : {}),
    ...(incoming.minimumWordSeconds !== undefined
      ? { minimumWordSeconds: numeric(incoming.minimumWordSeconds, "minimumWordSeconds", 0.05) }
      : {}),
    ...(incoming.captionHoldSeconds !== undefined
      ? { captionHoldSeconds: numeric(incoming.captionHoldSeconds, "captionHoldSeconds", 0) }
      : {}),
    ...(incoming.confidenceThreshold !== undefined
      ? { confidenceThreshold: numeric(incoming.confidenceThreshold, "confidenceThreshold", 0) }
      : {}),
    ...(incoming.model !== undefined ? { model: String(incoming.model) } : {}),
    ...(incoming.dtype !== undefined ? { dtype: incoming.dtype } : {}),
    ...(incoming.offline !== undefined ? { offline: Boolean(incoming.offline) } : {}),
  };
  if (!Number.isSafeInteger(next.wordsPerCaption)) throw new Error("wordsPerCaption must be a positive integer.");
  if (next.confidenceThreshold > 1) throw new Error("confidenceThreshold must be between 0 and 1.");
  const dtypes = ["fp32", "fp16", "q8", "q4"] as const;
  if (!dtypes.includes(next.dtype)) {
    throw new Error("dtype must be one of fp32, fp16, q8, or q4.");
  }
  return next;
}

const ANIMATION_PRESETS = ["none", "fade", "slide-up", "slide-down", "scale"] as const;

function layerAnimation(value: unknown, label: string): UiLayerAnimation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an animation object.`);
  const animation = value as { preset?: unknown; duration?: unknown };
  if (typeof animation.preset !== "string" || !ANIMATION_PRESETS.includes(animation.preset as (typeof ANIMATION_PRESETS)[number])) {
    throw new Error(`${label}.preset is not supported.`);
  }
  return {
    preset: animation.preset as UiLayerAnimation["preset"],
    duration: animation.duration === undefined ? 250 : clamp(numeric(animation.duration, `${label}.duration`, 0), 0, 5000),
  };
}

function layerVisual(value: unknown, label: string): UiLayerVisual | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const visual = value as Record<string, unknown>;
  const next: UiLayerVisual = {};
  if (visual.opacity !== undefined) next.opacity = clamp(numeric(visual.opacity, `${label}.opacity`, 0), 0, 1);
  if (visual.rotation !== undefined) next.rotation = numeric(visual.rotation, `${label}.rotation`, -3600);
  if (visual.outlineColor !== undefined) next.outlineColor = String(visual.outlineColor).slice(0, 32);
  if (visual.outlineWidth !== undefined) next.outlineWidth = clamp(numeric(visual.outlineWidth, `${label}.outlineWidth`, 0), 0, 20);
  if (visual.outlineEnabled !== undefined) next.outlineEnabled = Boolean(visual.outlineEnabled);
  if (visual.outlineOpacity !== undefined) next.outlineOpacity = clamp(numeric(visual.outlineOpacity, `${label}.outlineOpacity`, 0), 0, 1);
  if (visual.shadowColor !== undefined) next.shadowColor = String(visual.shadowColor).slice(0, 32);
  if (visual.shadowOpacity !== undefined) next.shadowOpacity = clamp(numeric(visual.shadowOpacity, `${label}.shadowOpacity`, 0), 0, 1);
  if (visual.shadowDistance !== undefined) next.shadowDistance = clamp(numeric(visual.shadowDistance, `${label}.shadowDistance`, 0), 0, 20);
  if (visual.shadowEnabled !== undefined) next.shadowEnabled = Boolean(visual.shadowEnabled);
  const animationIn = layerAnimation(visual.animationIn, `${label}.animationIn`);
  const animationOut = layerAnimation(visual.animationOut, `${label}.animationOut`);
  if (animationIn) next.animationIn = animationIn;
  if (animationOut) next.animationOut = animationOut;
  return next;
}

function designPosition(value: unknown, label: string): { x: number; y: number } {
  if (!value || typeof value !== "object") throw new Error(`${label} must contain x and y coordinates.`);
  const position = value as { x?: unknown; y?: unknown };
  return {
    x: numeric(position.x, `${label}.x`, 0),
    y: numeric(position.y, `${label}.y`, 0),
  };
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assColor(value: string | undefined, opacity = 1, fallback = "FFFFFF"): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? "");
  const rgb = match?.[1] ?? fallback;
  const alpha = Math.round((1 - clamp(opacity, 0, 1)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function validColor(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${label} must be a six-digit hex colour.`);
  }
  return value.toUpperCase();
}

function overlayTiming(overlay: UiOverlay, duration: number): { start: number; end: number } {
  const start = clamp(Number.isFinite(overlay.start) ? overlay.start! : 0, 0, duration);
  const requestedEnd = Number.isFinite(overlay.end) ? overlay.end! : duration;
  return { start, end: Math.max(start + 0.01, clamp(requestedEnd, 0.01, duration)) };
}

function fadeDurations(overlay: UiOverlay, span: number): { enter: number; exit: number } {
  const max = Math.max(0, Math.round(span * 500));
  const enter = overlay.visual?.animationIn?.preset === "fade" ? clamp(Math.round(overlay.visual.animationIn.duration ?? 250), 0, max) : 0;
  const exit = overlay.visual?.animationOut?.preset === "fade" ? clamp(Math.round(overlay.visual.animationOut.duration ?? 250), 0, max) : 0;
  return { enter, exit };
}

function assVisual(visual: UiOverlay["visual"] | UiProject["layout"]["arabic"]["visual"]) {
  if (!visual) return undefined;
  return {
    ...(visual.opacity !== undefined ? { opacity: visual.opacity } : {}),
    ...(visual.rotation !== undefined ? { rotation: visual.rotation } : {}),
    ...(visual.outlineColor !== undefined ? { outlineColor: visual.outlineColor } : {}),
    ...(visual.outlineWidth !== undefined ? { outlineWidth: visual.outlineWidth } : {}),
    ...(visual.outlineEnabled !== undefined ? { outlineEnabled: visual.outlineEnabled } : {}),
    ...(visual.outlineOpacity !== undefined ? { outlineOpacity: visual.outlineOpacity } : {}),
    ...(visual.shadowColor !== undefined ? { shadowColor: visual.shadowColor } : {}),
    ...(visual.shadowOpacity !== undefined ? { shadowOpacity: visual.shadowOpacity } : {}),
    ...(visual.shadowDistance !== undefined ? { shadowDistance: visual.shadowDistance } : {}),
    ...(visual.shadowEnabled !== undefined ? { shadowEnabled: visual.shadowEnabled } : {}),
    ...(visual.animationIn ? { animationIn: { preset: visual.animationIn.preset, ...(visual.animationIn.duration !== undefined ? { duration: visual.animationIn.duration } : {}) } } : {}),
    ...(visual.animationOut ? { animationOut: { preset: visual.animationOut.preset, ...(visual.animationOut.duration !== undefined ? { duration: visual.animationOut.duration } : {}) } } : {}),
  };
}

function surahDisplayName(index: QuranIndex, surahNumber: number): string {
  return index.corpus.surahs[surahNumber - 1]?.name ?? `Surah ${surahNumber}`;
}

/** Collapses consecutive words into one span per surah so the "detected surah"
 * overlay can hold a single label across an entire chapter instead of flickering
 * per word. */
function detectedSurahSegments(words: AlignmentDocument["words"]): { start: number; end: number; surah: number }[] {
  const segments: { start: number; end: number; surah: number }[] = [];
  for (const word of words) {
    const surah = Number(word.verseKey.split(":")[0]);
    if (!Number.isFinite(surah)) continue;
    const start = Number(word.start);
    const end = Number(word.end);
    const last = segments[segments.length - 1];
    if (last && last.surah === surah) last.end = Math.max(last.end, end);
    else segments.push({ start, end, surah });
  }
  return segments;
}

function withTextOverlays(
  ass: string,
  overlays: UiOverlay[],
  durationSeconds: number,
  words: AlignmentDocument["words"],
  quranIndex: QuranIndex,
): string {
  const textOverlays = overlays.filter((overlay) => overlay.visible && overlay.type === "text" && overlay.text?.trim());
  if (!textOverlays.length) return ass;
  const styleLines = textOverlays.map((overlay, index) => {
    const font = validFont(overlay.fontName ?? "Arial", `overlays[${index}].fontName`);
    const size = numeric(overlay.fontSize ?? 72, `overlays[${index}].fontSize`, 0.1);
    const visual = overlay.visual;
    const back = visual?.shadowEnabled === false ? "&HFF000000" : visual?.shadowColor !== undefined || visual?.shadowOpacity !== undefined ? assColor(visual.shadowColor, visual.shadowOpacity ?? 0.44, "000000") : "&H90000000";
    const outlineWidth = visual?.outlineEnabled === false ? 0 : clamp(visual?.outlineWidth ?? 3, 0, 20);
    const shadowDistance = visual?.shadowEnabled === false ? 0 : clamp(visual?.shadowDistance ?? 1, 0, 20);
    return `Style: Overlay${index},${font},${size},${assColor(overlay.color, visual?.opacity ?? 1)},${assColor(overlay.color, visual?.opacity ?? 1)},${assColor(visual?.outlineColor, visual?.outlineOpacity ?? 1, "101010")},${back},0,0,0,0,100,100,0,0,1,${outlineWidth},${shadowDistance},5,40,40,0,1`;
  });
  const marker = "\n\n[Events]";
  const headerIndex = ass.indexOf(marker);
  if (headerIndex < 0) throw new Error("Generated ASS subtitles are missing their events section.");
  const withStyles = `${ass.slice(0, headerIndex)}\n${styleLines.join("\n")}${ass.slice(headerIndex)}`;
  const surahSegments = textOverlays.some((overlay) => overlay.autoSurah) ? detectedSurahSegments(words) : [];
  const events = textOverlays.flatMap((overlay, index) => {
    const x = Math.round(Math.min(1, Math.max(0, overlay.position.x)) * DESIGN_WIDTH);
    const y = Math.round(Math.min(1, Math.max(0, overlay.position.y)) * DESIGN_HEIGHT);
    const timing = overlayTiming(overlay, durationSeconds);
    const fade = fadeDurations(overlay, timing.end - timing.start);
    const rotation = Number.isFinite(overlay.visual?.rotation) && overlay.visual?.rotation ? `\\frz${overlay.visual.rotation}` : "";
    const fadeTag = fade.enter || fade.exit ? `\\fad(${fade.enter},${fade.exit})` : "";
    const tags = `{\\an5\\pos(${x},${y})${rotation}${fadeTag}}`;
    if (!overlay.autoSurah) {
      return [`Dialogue: 2,${assTime(timing.start)},${assTime(timing.end)},Overlay${index},,0,0,0,,${tags}${escapeAss(overlay.text ?? "")}`];
    }
    return surahSegments
      .map((segment) => ({ start: Math.max(segment.start, timing.start), end: Math.min(segment.end, timing.end), surah: segment.surah }))
      .filter((segment) => segment.end > segment.start)
      .map((segment) => {
        const text = (overlay.text ?? "").replace(/\{surah\}/gi, surahDisplayName(quranIndex, segment.surah));
        return `Dialogue: 2,${assTime(segment.start)},${assTime(segment.end)},Overlay${index},,0,0,0,,${tags}${escapeAss(text)}`;
      });
  });
  return `${withStyles.trimEnd()}\n${events.join("\n")}\n`;
}

function bodyProject(base: UiProject, incoming: unknown): UiProject {
  if (!incoming || typeof incoming !== "object") throw new Error("Project must be an object.");
  const value = incoming as Partial<UiProject> & { settings?: Partial<UiCaptionSettings> };
  const layout = value.layout;
  const arabicVisual = layout?.arabic?.visual !== undefined
    ? layerVisual(layout.arabic.visual, "layout.arabic.visual")
    : base.layout.arabic.visual;
  const translationVisual = layout?.translation?.visual !== undefined
    ? layerVisual(layout.translation.visual, "layout.translation.visual")
    : base.layout.translation.visual;
  const arabicColor = layout?.arabic?.color !== undefined
    ? validColor(layout.arabic.color, "layout.arabic.color")
    : base.layout.arabic.color;
  const translationColor = layout?.translation?.color !== undefined
    ? validColor(layout.translation.color, "layout.translation.color")
    : base.layout.translation.color;
  const next: UiProject = {
    ...base,
    settings: mergeSettings(base.settings, value.settings ?? {}),
    layout: {
      arabic: {
        position: designPosition(layout?.arabic?.position, "layout.arabic.position"),
        fontSize: numeric(layout?.arabic?.fontSize, "layout.arabic.fontSize", 0.1),
        color: arabicColor,
        ...(arabicVisual !== undefined ? { visual: arabicVisual } : {}),
      },
      translation: {
        position: designPosition(layout?.translation?.position, "layout.translation.position"),
        fontSize: numeric(layout?.translation?.fontSize, "layout.translation.fontSize", 0.1),
        color: translationColor,
        ...(translationVisual !== undefined ? { visual: translationVisual } : {}),
      },
    },
    overlays: Array.isArray(value.overlays) ? value.overlays.slice(0, 100) : [],
    captionEdits: captionEdits(value.captionEdits),
  };
  return next;
}

export async function startUiServer(options: StartUiServerOptions): Promise<UiServerHandle> {
  const inputPath = options.input ? resolve(options.input) : undefined;
  if (inputPath) {
    try {
      await access(inputPath);
    } catch {
      throw new Error(`Input video does not exist: ${inputPath}`);
    }
  }
  const workspace = await mkdtemp(join(tmpdir(), "transcribe-quran-ui-"));
  const assetRoot = assetDirectory();
  let project = createEmptyProject();
  project.settings = mergeSettings(project.settings, options.settings ?? {});
  project.layout = defaultCaptionLayerPositions(project.settings);
  let alignment: AlignmentDocument | undefined;
  let job: Job = { status: "idle" };
  let closed = false;
  let lastOutput: { subtitles?: string; video?: string } = {};
  const overlayFiles = new Map<string, string>();
  const fontFiles = new Map<string, { id: string; family: string; source: string; path: string; url: string; format: string }>();
  const fontDirectory = join(workspace, "fonts");
  await mkdir(fontDirectory, { recursive: true });
  try {
    for (const filename of await readdir(bundledFontDirectory())) {
      if (!/\.(ttf|otf|woff2?)$/i.test(filename)) continue;
      const source = join(bundledFontDirectory(), filename);
      const destination = join(fontDirectory, filename);
      await copyFile(source, destination);
      const id = `bundled-${filename.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const family = await detectFontFamily(destination, filename.replace(/\.[^.]+$/, ""));
      fontFiles.set(id, { id, family, source: "bundled", path: destination, url: `/api/font-files/${id}`, format: fontFormat(destination) });
    }
  } catch {
    // The bundled font directory is optional for development builds.
  }

  const alignmentPath = join(workspace, "alignment.json");
  const subtitlePath = join(workspace, "captions.ass");
  const videoOutputPath = join(workspace, "rendered.mp4");

  const readAlignment = async (): Promise<AlignmentDocument | undefined> => {
    if (alignment) return alignment;
    try {
      alignment = JSON.parse(await readFile(alignmentPath, "utf8")) as AlignmentDocument;
      return alignment;
    } catch {
      return undefined;
    }
  };

  const startTranscription = async (): Promise<void> => {
    if (job.status === "running") return;
    if (!project.videoPath) {
      job = { status: "error", message: "Choose a video before transcribing." };
      return;
    }
    job = { status: "running", message: "Transcribing locally and matching Qur'an words…" };
    alignment = undefined;
    project.captionEdits = {};
    try {
      await rm(alignmentPath, { force: true });
      await rm(subtitlePath, { force: true });
      const settings = project.settings;
      const result = await processVideo({
        input: project.videoPath,
        alignmentOutput: alignmentPath,
        subtitleOutput: subtitlePath,
        output: videoOutputPath,
        model: settings.model,
        dtype: settings.dtype,
        translation: settings.translation,
        wordsPerCaption: settings.wordsPerCaption,
        fontName: settings.arabicFontName,
        translationFontName: settings.translationFontName,
        fontSize: settings.arabicFontSize,
        translationFontSize: settings.translationFontSize,
        captionGap: settings.captionGap,
        speechPauseSeconds: settings.speechPauseSeconds,
        minimumWordSeconds: settings.minimumWordSeconds,
        captionHoldSeconds: settings.captionHoldSeconds,
        confidenceThreshold: settings.confidenceThreshold,
        burnVideo: false,
        offline: settings.offline,
        keepTemporaryFiles: false,
        verbose: false,
      });
      await readAlignment();
      const timing = result.alignment.diagnostics;
      const phrases = timing.phrases ?? 0;
      const forced = timing.forcedPhrases ?? 0;
      const unmatched = timing.unmatchedPhrases ?? 0;
      const voiced = timing.voicedSeconds ?? 0;
      const covered = voiced > 0 ? (1 - (timing.uncoveredSpeechSeconds ?? 0) / voiced) * 100 : 100;
      const parts = [
        `Matched ${timing.matchedWords} Qur'an words across ${phrases} phrase${phrases === 1 ? "" : "s"}.`,
        `${forced} phrase${forced === 1 ? "" : "s"} had word timings measured against the audio.`,
        `${covered.toFixed(1)}% of the recitation is captioned.`,
      ];
      if (unmatched) parts.push(`${unmatched} phrase${unmatched === 1 ? "" : "s"} could not be identified.`);
      job = { status: "complete", message: parts.join(" ") };
    } catch (error) {
      job = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const exportProject = async (burnVideo: boolean): Promise<void> => {
    const currentAlignment = await readAlignment();
    if (!currentAlignment || !project.videoPath) throw new Error("Transcribe a video before exporting.");
    const editedAlignment = applyCaptionEdits(currentAlignment, project.captionEdits);
    const corpus = await loadQuranCorpus();
    const index = buildQuranIndex(corpus);
    const settings = project.settings;
    const arabicVisual = assVisual(project.layout.arabic.visual);
    const translationVisual = assVisual(project.layout.translation.visual);
    const assOptions = {
      arabicFontName: settings.arabicFontName,
      translationFontName: settings.translationFontName,
      arabicColor: project.layout.arabic.color ?? "#FFFFFF",
      translationColor: project.layout.translation.color ?? "#FFFFFF",
      arabicFontSize: project.layout.arabic.fontSize,
      translationFontSize: project.layout.translation.fontSize,
      captionGap: settings.captionGap,
      arabicPosition: project.layout.arabic.position,
      translationPosition: project.layout.translation.position,
    };
    if (arabicVisual) Object.assign(assOptions, { arabicVisual });
    if (translationVisual) Object.assign(assOptions, { translationVisual });
    let ass = createAss(editedAlignment.words, index, settings.wordsPerCaption, assOptions);
    ass = withTextOverlays(ass, project.overlays, editedAlignment.durationSeconds, editedAlignment.words, index);
    await writeFile(subtitlePath, ass, "utf8");
    lastOutput = { subtitles: subtitlePath };
    if (burnVideo) {
      const imageOverlays: ImageOverlay[] = project.overlays
        .filter((overlay) => overlay.visible && overlay.type === "image" && overlay.source)
        .map((overlay) => ({
          path: overlayFiles.get(overlay.source!.split("/").pop() ?? "") ?? "",
          x: Math.min(1, Math.max(0, overlay.position.x)),
          y: Math.min(1, Math.max(0, overlay.position.y)),
          width: Math.min(1, Math.max(0.01, overlay.width)),
          height: Math.min(1, Math.max(0.01, overlay.height)),
          start: overlayTiming(overlay, editedAlignment.durationSeconds).start,
          end: overlayTiming(overlay, editedAlignment.durationSeconds).end,
          opacity: clamp(overlay.visual?.opacity ?? 1, 0, 1),
          fadeIn: fadeDurations(overlay, overlayTiming(overlay, editedAlignment.durationSeconds).end - overlayTiming(overlay, editedAlignment.durationSeconds).start).enter / 1000,
          fadeOut: fadeDurations(overlay, overlayTiming(overlay, editedAlignment.durationSeconds).end - overlayTiming(overlay, editedAlignment.durationSeconds).start).exit / 1000,
        }))
        .filter((overlay) => overlay.path);
      await renderCaptionedVideo(project.videoPath, subtitlePath, videoOutputPath, fontDirectory, imageOverlays);
      lastOutput.video = videoOutputPath;
    }
  };

  const sendState = async (res: ServerResponse): Promise<void> => {
    await readAlignment();
    json(res, 200, {
      project: { ...project, videoPath: project.videoPath ? basename(project.videoPath) : undefined },
      hasVideo: Boolean(project.videoPath),
      hasAlignment: Boolean(alignment),
      alignment,
      job,
      outputs: {
        subtitles: lastOutput.subtitles ? "/api/download/subtitles" : undefined,
        video: lastOutput.video ? "/api/download/video" : undefined,
      },
      design: { width: DESIGN_WIDTH, height: DESIGN_HEIGHT },
    });
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/api/state" && req.method === "GET") {
        await sendState(res);
        return;
      }
      if (url.pathname === "/api/video" && req.method === "GET") {
        if (!project.videoPath) {
          text(res, 404, "No video selected.");
          return;
        }
        await streamVideo(project.videoPath, req, res);
        return;
      }
      if (url.pathname === "/api/surahs" && req.method === "GET") {
        const corpus = await loadQuranCorpus();
        json(res, 200, { surahs: corpus.surahs.map((surah) => ({ number: surah.number, name: surah.name, arabicName: surah.arabicName })) });
        return;
      }
      if (url.pathname === "/api/fonts" && req.method === "GET") {
        const system = await systemFontFamilies();
        const registered = [...fontFiles.values()].map(({ id, family, source, url: fontUrl, format }) => ({ id, family, source, url: fontUrl, format }));
        const seen = new Set(registered.map((font) => font.family));
        const fonts = [...registered, ...system.filter((family) => !seen.has(family)).map((family) => ({ id: `system-${family}`, family, source: "system" }))];
        json(res, 200, { fonts });
        return;
      }
      if (url.pathname.startsWith("/api/font-files/") && req.method === "GET") {
        const id = url.pathname.slice("/api/font-files/".length);
        const font = fontFiles.get(id);
        if (!font) {
          text(res, 404, "Font not found.");
          return;
        }
        await serveAsset(font.path, res);
        return;
      }
      if (url.pathname === "/api/upload" && req.method === "POST") {
        if (job.status === "running") {
          json(res, 409, { error: "Transcription is currently running." });
          return;
        }
        const declaredLength = Number(req.headers["content-length"] ?? 0);
        if (declaredLength > MAX_UPLOAD_BYTES) throw new Error("Video upload is too large.");
        const filename = safeFilename(String(req.headers["x-filename"] ?? "video.mp4"));
        const destination = join(workspace, `source-${Date.now()}-${filename}`);
        await pipeline(req, createWriteStream(destination));
        const information = await stat(destination);
        if (information.size > MAX_UPLOAD_BYTES) throw new Error("Video upload is too large.");
        project = projectWithVideo(project, { path: destination, name: filename });
        project.captionEdits = {};
        alignment = undefined;
        lastOutput = {};
        await rm(alignmentPath, { force: true });
        await rm(subtitlePath, { force: true });
        await rm(videoOutputPath, { force: true });
        job = { status: "idle", message: "Video ready. Start transcription when you are ready." };
        await sendState(res);
        return;
      }
      if (url.pathname === "/api/font-upload" && req.method === "POST") {
        const declaredLength = Number(req.headers["content-length"] ?? 0);
        if (declaredLength > 30 * 1024 * 1024) throw new Error("Font file is too large.");
        const filename = safeFilename(String(req.headers["x-filename"] ?? "font.ttf"));
        if (!/\.(ttf|otf|woff2?)$/i.test(filename)) throw new Error("Choose a .ttf, .otf, .woff, or .woff2 font file.");
        const id = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const destination = join(fontDirectory, `${id}-${filename}`);
        await pipeline(req, createWriteStream(destination));
        const information = await stat(destination);
        if (information.size > 30 * 1024 * 1024) throw new Error("Font file is too large.");
        const family = await detectFontFamily(destination, filename.replace(/\.[^.]+$/, ""));
        const font = { id, family, source: "imported", path: destination, url: `/api/font-files/${id}`, format: fontFormat(destination) };
        fontFiles.set(id, font);
        json(res, 200, { id, family, source: "imported", url: font.url, format: font.format });
        return;
      }
      if (url.pathname === "/api/overlay-upload" && req.method === "POST") {
        const declaredLength = Number(req.headers["content-length"] ?? 0);
        if (declaredLength > 100 * 1024 * 1024) throw new Error("Image overlay is too large.");
        const filename = safeFilename(String(req.headers["x-filename"] ?? "overlay.png"));
        const id = `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const destination = join(workspace, `${id}-${filename}`);
        await pipeline(req, createWriteStream(destination));
        const information = await stat(destination);
        if (information.size > 100 * 1024 * 1024) throw new Error("Image overlay is too large.");
        overlayFiles.set(id, destination);
        json(res, 200, { id, source: `/api/overlays/${id}`, filename });
        return;
      }
      if (url.pathname === "/api/transcribe" && req.method === "POST") {
        const incoming = JSON.parse(await requestBody(req)) as Partial<UiCaptionSettings>;
        project.settings = mergeSettings(project.settings, incoming);
        project.layout.arabic.fontSize = project.settings.arabicFontSize;
        project.layout.translation.fontSize = project.settings.translationFontSize;
        if (!project.videoPath) {
          json(res, 400, { error: "Choose a video before transcribing." });
          return;
        }
        if (job.status !== "running") void startTranscription();
        json(res, 202, { accepted: true });
        return;
      }
      if (url.pathname === "/api/project" && req.method === "POST") {
        const incoming = JSON.parse(await requestBody(req, 16 * 1024 * 1024));
        project = bodyProject(project, incoming);
        await sendState(res);
        return;
      }
      if (url.pathname === "/api/export" && req.method === "POST") {
        const incoming = JSON.parse(await requestBody(req, 16 * 1024 * 1024)) as {
          project?: unknown;
          burnVideo?: boolean;
        };
        if (incoming.project) project = bodyProject(project, incoming.project);
        await exportProject(Boolean(incoming.burnVideo));
        await sendState(res);
        return;
      }
      if (url.pathname === "/api/download/video" && req.method === "GET") {
        if (!lastOutput.video) {
          text(res, 404, "No rendered video is available.");
          return;
        }
        await streamVideo(lastOutput.video, req, res);
        return;
      }
      if (url.pathname.startsWith("/api/overlays/") && req.method === "GET") {
        const id = url.pathname.slice("/api/overlays/".length);
        const path = overlayFiles.get(id);
        if (!path) {
          text(res, 404, "Overlay not found.");
          return;
        }
        await serveAsset(path, res);
        return;
      }
      if (url.pathname === "/api/download/subtitles" && req.method === "GET") {
        if (!lastOutput.subtitles) {
          text(res, 404, "No subtitles are available.");
          return;
        }
        await serveAsset(lastOutput.subtitles, res);
        return;
      }
      if (url.pathname === "/favicon.ico" && req.method === "GET") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "GET") {
        text(res, 405, "Method not allowed");
        return;
      }
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (requested.includes("..") || requested.includes("\\")) {
        text(res, 400, "Invalid asset path");
        return;
      }
      await serveAsset(join(assetRoot, requested), res);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine UI server port.");
  const url = `http://127.0.0.1:${address.port}/`;
  console.error(`transcribe-quran UI: ${url}`);
  if (options.openBrowser) await openBrowser(url);

  if (inputPath) {
    project = projectWithVideo(project, { path: inputPath, name: basename(inputPath) });
    void startTranscription();
  }

  return {
    port: address.port,
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
