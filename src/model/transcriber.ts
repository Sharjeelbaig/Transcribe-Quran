import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { TranscriptWord, TranscriptionResult } from "../types.js";
import { normalizeArabic, splitNormalizedArabic } from "../quran/normalize-arabic.js";

export const DEFAULT_MODEL = "Sharjeelbaig/whisper-tiny-ar-quran-onnx";

export interface PipelineChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

interface PipelineResult {
  text?: string;
  chunks?: PipelineChunk[];
}

interface AsrPipeline {
  (
    audio: Float32Array,
    options: { language: string; task: string; return_timestamps: "word" },
  ): Promise<PipelineResult>;
}

function defaultCacheDirectory(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Caches", "transcribe-quran");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "transcribe-quran", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "transcribe-quran");
}

// A single Arabic word can be elongated, but a timestamp spanning most of a
// short inference window is a decoder failure rather than a real word span.
// Treat it as missing so an adjacent overlapping window can provide timing.
const MAX_REASONABLE_WORD_SECONDS = 5;

function timestampPair(chunk: PipelineChunk, fallbackStart: number, fallbackEnd: number): [number, number] {
  const start = chunk.timestamp?.[0] ?? fallbackStart;
  const reportedEnd = chunk.timestamp?.[1];
  // Whisper sometimes emits 0 for the last word's open-ended timestamp.
  const end =
    reportedEnd !== null &&
    reportedEnd !== undefined &&
    reportedEnd > start &&
    reportedEnd - start <= MAX_REASONABLE_WORD_SECONDS
      ? reportedEnd
      : Math.max(start + 0.08, fallbackEnd);
  return [Math.max(0, start), Math.max(start + 0.02, end)];
}

export function chunksToWords(chunks: PipelineChunk[], windowDuration?: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const [chunkIndex, originalChunk] of chunks.entries()) {
    let chunk = originalChunk;
    const raw = chunk.text?.trim() ?? "";
    const pieces = splitNormalizedArabic(raw);
    if (!pieces.length) continue;
    const reportedStart = chunk.timestamp?.[0];
    const reportedEnd = chunk.timestamp?.[1];
    const invalidEnd =
      reportedEnd === null ||
      reportedEnd === undefined ||
      reportedEnd <= (reportedStart ?? 0);
    if (invalidEnd && chunks.length === 1 && windowDuration !== undefined) {
      const center = windowDuration / 2;
      chunk = {
        ...chunk,
        timestamp: [Math.max(0, center - 1), Math.min(windowDuration, center + 1)],
      };
    }
    const previousEnd = words.at(-1)?.end ?? 0;
    const fallbackEnd =
      chunkIndex === chunks.length - 1 && windowDuration !== undefined
        ? Math.min(windowDuration, (chunk.timestamp?.[0] ?? previousEnd) + 2.5)
        : previousEnd + 0.5;
    const [start, end] = timestampPair(chunk, previousEnd, fallbackEnd);
    const duration = Math.max(0.02, (end - start) / pieces.length);
    pieces.forEach((normalized, index) => {
      words.push({
        text: pieces.length === 1 ? raw : normalized,
        normalized,
        start: start + duration * index,
        end: index === pieces.length - 1 ? end : start + duration * (index + 1),
      });
    });
  }
  return words;
}

const WINDOW_SECONDS = 9;
const WINDOW_HOP_SECONDS = 6;

async function transcribeInShortWindows(
  transcriber: AsrPipeline,
  audio: Float32Array,
): Promise<TranscriptionResult> {
  const duration = audio.length / 16_000;
  const overlap = WINDOW_SECONDS - WINDOW_HOP_SECONDS;
  const words: TranscriptWord[] = [];

  for (let windowStart = 0; windowStart < duration; windowStart += WINDOW_HOP_SECONDS) {
    const windowEnd = Math.min(duration, windowStart + WINDOW_SECONDS);
    const windowDuration = windowEnd - windowStart;
    const sampleStart = Math.floor(windowStart * 16_000);
    const sampleEnd = Math.min(audio.length, Math.ceil(windowEnd * 16_000));
    const result = (await transcriber(audio.slice(sampleStart, sampleEnd), {
      language: "ar",
      task: "transcribe",
      return_timestamps: "word",
    })) as PipelineResult;

    let localWords = chunksToWords(result.chunks ?? [], windowDuration);
    if (!localWords.length && result.text) {
      const pieces = splitNormalizedArabic(result.text);
      const secondsPerWord = windowDuration / Math.max(1, pieces.length);
      localWords = pieces.map((normalized, index) => ({
        text: normalized,
        normalized,
        start: index * secondsPerWord,
        end: (index + 1) * secondsPerWord,
      }));
    }

    // Each overlapping window owns its middle region. Keeping only that
    // region removes duplicate words while still giving the recognizer audio
    // context on both sides of every boundary.
    const ownedStart = windowStart === 0 ? 0 : windowStart + overlap / 2;
    const ownedEnd = windowEnd >= duration ? duration : windowEnd - overlap / 2;
    for (const word of localWords) {
      const midpoint = windowStart + (word.start + word.end) / 2;
      if (midpoint < ownedStart || midpoint >= ownedEnd) continue;
      words.push({
        ...word,
        start: windowStart + word.start,
        end: Math.min(duration, windowStart + word.end),
      });
    }
    if (windowEnd >= duration) break;
  }

  if (!words.length) throw new Error("The local model returned no Arabic transcription.");
  return { text: words.map((word) => word.text).join(" "), words };
}

export interface TranscriberOptions {
  model: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  offline: boolean;
  verbose: boolean;
}

export async function transcribeAudio(
  audio: Float32Array,
  options: TranscriberOptions,
): Promise<TranscriptionResult> {
  const cacheDir = defaultCacheDirectory();
  await mkdir(cacheDir, { recursive: true });
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = !options.offline;

  if (options.verbose) {
    console.error(`Loading ASR model: ${options.model}`);
    console.error(`Model cache: ${cacheDir}`);
  }

  const reportedProgress = new Map<string, number>();
  const modelOptions = options.verbose
    ? {
        dtype: options.dtype,
        progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
          if (progress.status === "progress" && progress.file && progress.progress !== undefined) {
            const bucket = Math.floor(progress.progress / 5) * 5;
            if (bucket > (reportedProgress.get(progress.file) ?? -5)) {
              reportedProgress.set(progress.file, bucket);
              console.error(`Fetching ${progress.file}: ${bucket}%`);
            }
          }
          if (progress.status === "done" && progress.file && (reportedProgress.get(progress.file) ?? 0) < 100) {
            reportedProgress.set(progress.file, 100);
            console.error(`Ready ${progress.file}`);
          }
        },
      }
    : { dtype: options.dtype };

  const transcriber = await transformers.pipeline(
    "automatic-speech-recognition",
    options.model,
    modelOptions,
  );

  const result = await transcribeInShortWindows(transcriber as unknown as AsrPipeline, audio);
  const words = result.words;

  const audioDuration = audio.length / 16_000;
  const last = words.at(-1);
  if (last && last.end - last.start < 0.08) {
    last.end = Math.max(last.start + 0.08, audioDuration);
  }

  // Ensure custom model outputs containing unusual spacing or marks are always
  // normalized before entering the Qur'an matcher.
  for (const word of words) word.normalized = normalizeArabic(word.normalized);
  return { text: result.text, words };
}
