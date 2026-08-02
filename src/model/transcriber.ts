import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { TranscriptWord, TranscriptionResult } from "../types.js";
import { normalizeArabic, splitNormalizedArabic } from "../quran/normalize-arabic.js";

export const DEFAULT_MODEL = "Sharjeelbaig/whisper-tiny-ar-quran-onnx";

interface PipelineChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

interface PipelineResult {
  text?: string;
  chunks?: PipelineChunk[];
}

function defaultCacheDirectory(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Caches", "transcribe-quran");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "transcribe-quran", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "transcribe-quran");
}

function timestampPair(chunk: PipelineChunk, fallbackStart: number, fallbackEnd: number): [number, number] {
  const start = chunk.timestamp?.[0] ?? fallbackStart;
  const reportedEnd = chunk.timestamp?.[1];
  // Whisper sometimes emits 0 for the last word's open-ended timestamp.
  const end =
    reportedEnd !== null && reportedEnd !== undefined && reportedEnd > start
      ? reportedEnd
      : Math.max(start + 0.08, fallbackEnd);
  return [Math.max(0, start), Math.max(start + 0.02, end)];
}

function chunksToWords(chunks: PipelineChunk[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const chunk of chunks) {
    const raw = chunk.text?.trim() ?? "";
    const pieces = splitNormalizedArabic(raw);
    if (!pieces.length) continue;
    const [start, end] = timestampPair(chunk, words.at(-1)?.end ?? 0, (words.at(-1)?.end ?? 0) + 0.5);
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

  const result = (await transcriber(audio, {
    language: "ar",
    task: "transcribe",
    chunk_length_s: 28,
    stride_length_s: 4,
    return_timestamps: "word",
  })) as PipelineResult;

  const words = chunksToWords(result.chunks ?? []);
  if (!words.length && result.text) {
    const pieces = splitNormalizedArabic(result.text);
    const secondsPerWord = Math.max(0.08, audio.length / 16_000 / Math.max(1, pieces.length));
    pieces.forEach((normalized, index) => {
      words.push({
        text: normalized,
        normalized,
        start: index * secondsPerWord,
        end: (index + 1) * secondsPerWord,
      });
    });
  }
  if (!words.length) throw new Error("The local model returned no Arabic transcription.");

  const audioDuration = audio.length / 16_000;
  const last = words.at(-1);
  if (last && last.end - last.start < 0.08) {
    last.end = Math.max(last.start + 0.08, audioDuration);
  }

  // Ensure custom model outputs containing unusual spacing or marks are always
  // normalized before entering the Qur'an matcher.
  for (const word of words) word.normalized = normalizeArabic(word.normalized);
  return { text: result.text ?? words.map((word) => word.text).join(" "), words };
}
