import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { normalizeArabic, splitNormalizedArabic } from "../quran/normalize-arabic.js";
import type { TranscriptWord } from "../types.js";

export const DEFAULT_MODEL = "Sharjeelbaig/whisper-tiny-ar-quran-onnx";

/** Whisper reads 30 seconds at a time; a phrase longer than this must be split. */
export const MAX_SEGMENT_SECONDS = 28;
/** Whisper's decoder context. A canonical span longer than this cannot be forced. */
const MAX_ALIGNMENT_TOKENS = 400;
/** Encoder frames per second, which sets the resolution of a forced boundary. */
const FRAMES_PER_SECOND = 50;
const TIME_PRECISION = 1 / FRAMES_PER_SECOND;

export function defaultCacheDirectory(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Caches", "transcribe-quran");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "transcribe-quran", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "transcribe-quran");
}

/**
 * Qur'anic pause, sajdah, and ayah-end marks are notation rather than sound.
 * Some of them also carry their own space, which would silently corrupt the
 * mapping from decoder tokens back to words.
 */
export function spokenForm(value: string): string {
  return value.replace(/[ؕ-ؚۖ-ۭ]/g, "").replace(/\s+/g, " ").trim();
}

export interface ModelSessionOptions {
  model: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  offline: boolean;
  verbose: boolean;
}

export interface ForcedSpan {
  start: number;
  end: number;
}

export interface ModelSession {
  /** Recognized Arabic for one phrase, used only to identify the passage. */
  transcribe(audio: Float32Array): Promise<TranscriptWord[]>;
  /**
   * Word boundaries for a known canonical passage, measured against the audio.
   * Returns undefined when the alignment is unusable, so a caller can fall back.
   */
  align(audio: Float32Array, words: readonly string[]): Promise<ForcedSpan[] | undefined>;
  readonly supportsForcedAlignment: boolean;
}

// The shapes below describe only what this file uses. Depending on the full
// upstream types would tie the build to their internal layout.
interface AsrPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text?: string }>;
  model: WhisperModel;
  tokenizer: { encode(text: string, options?: Record<string, unknown>): number[] };
  processor: (audio: Float32Array) => Promise<Record<string, unknown>>;
}

interface TimestampTensor {
  data: ArrayLike<number>;
  [index: number]: TimestampTensor;
}

interface WhisperModel {
  generation_config: {
    decoder_start_token_id?: number;
    lang_to_id?: Record<string, number>;
    task_to_id?: Record<string, number>;
    no_timestamps_token_id?: number;
    alignment_heads?: Array<[number, number]>;
  };
  generate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  _extract_token_timestamps(
    outputs: Record<string, unknown>,
    alignmentHeads: Array<[number, number]>,
    numFrames: number,
    timePrecision: number,
    numInputIds: number,
  ): TimestampTensor;
}

function progressReporter(verbose: boolean): Record<string, unknown> {
  if (!verbose) return {};
  const reported = new Map<string, number>();
  return {
    progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
      if (progress.status === "progress" && progress.file && progress.progress !== undefined) {
        const bucket = Math.floor(progress.progress / 5) * 5;
        if (bucket > (reported.get(progress.file) ?? -5)) {
          reported.set(progress.file, bucket);
          console.error(`Fetching ${progress.file}: ${bucket}%`);
        }
      }
      if (progress.status === "done" && progress.file && (reported.get(progress.file) ?? 0) < 100) {
        reported.set(progress.file, 100);
        console.error(`Ready ${progress.file}`);
      }
    },
  };
}

/** Token ids for the canonical text, with the word each token belongs to. */
function tokenizeWords(
  tokenizer: AsrPipeline["tokenizer"],
  words: readonly string[],
): { ids: number[]; owners: number[] } {
  const ids: number[] = [];
  const owners: number[] = [];
  words.forEach((word, position) => {
    const spoken = spokenForm(word);
    if (!spoken) return;
    // Encoding each word separately keeps the token-to-word map exact, which
    // joining the line and splitting on spaces cannot guarantee.
    const encoded = tokenizer.encode(ids.length === 0 ? spoken : ` ${spoken}`, { add_special_tokens: false });
    for (const id of encoded) {
      ids.push(id);
      owners.push(position);
    }
  });
  return { ids, owners };
}

/**
 * Rejects an alignment that cannot be true of the audio: boundaries that run
 * backwards, or a run of words collapsed onto a single instant because the
 * passage asked for more words than the phrase actually contains.
 */
function plausible(spans: ForcedSpan[], duration: number): boolean {
  if (!spans.length) return false;
  let collapsed = 0;
  for (const [position, span] of spans.entries()) {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) return false;
    if (span.start < -1e-6 || span.end > duration + 1e-6) return false;
    if (position > 0 && span.start < spans[position - 1]!.start - 1e-6) return false;
    if (span.end - span.start < 0.02) collapsed += 1;
  }
  return collapsed <= Math.max(1, Math.floor(spans.length * 0.2));
}

export async function createModelSession(options: ModelSessionOptions): Promise<ModelSession> {
  const cacheDir = defaultCacheDirectory();
  await mkdir(cacheDir, { recursive: true });
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = !options.offline;

  if (options.verbose) {
    console.error(`Loading ASR model: ${options.model}`);
    console.error(`Model cache: ${cacheDir}`);
  }

  const asr = (await transformers.pipeline("automatic-speech-recognition", options.model, {
    dtype: options.dtype,
    ...progressReporter(options.verbose),
  })) as unknown as AsrPipeline;

  const config = asr.model?.generation_config ?? {};
  const alignmentHeads = config.alignment_heads;
  const startToken = config.decoder_start_token_id;
  const languageToken = config.lang_to_id?.["<|ar|>"];
  const taskToken = config.task_to_id?.["transcribe"];
  const noTimestampsToken = config.no_timestamps_token_id;
  const supportsForcedAlignment =
    Array.isArray(alignmentHeads) &&
    alignmentHeads.length > 0 &&
    typeof startToken === "number" &&
    typeof languageToken === "number" &&
    typeof taskToken === "number" &&
    typeof noTimestampsToken === "number" &&
    typeof asr.model?._extract_token_timestamps === "function";

  if (options.verbose && !supportsForcedAlignment) {
    console.error("This model cannot force canonical text through the decoder; word timing will fall back to recognition.");
  }

  return {
    supportsForcedAlignment,

    async transcribe(audio: Float32Array): Promise<TranscriptWord[]> {
      const duration = audio.length / 16_000;
      const result = await asr(audio, { language: "ar", task: "transcribe", return_timestamps: false });
      const pieces = splitNormalizedArabic(result.text ?? "");
      if (!pieces.length) return [];
      // Only the words themselves identify the passage. Their timing comes
      // from forced alignment afterwards, so an even spread is enough here.
      const perWord = duration / pieces.length;
      return pieces.map((normalized, position) => ({
        text: normalized,
        normalized: normalizeArabic(normalized),
        start: position * perWord,
        end: (position + 1) * perWord,
      }));
    },

    async align(audio: Float32Array, words: readonly string[]): Promise<ForcedSpan[] | undefined> {
      if (!supportsForcedAlignment || !words.length) return undefined;
      const duration = audio.length / 16_000;
      const { ids, owners } = tokenizeWords(asr.tokenizer, words);
      if (!ids.length || ids.length > MAX_ALIGNMENT_TOKENS) return undefined;

      const prefix = [startToken!, languageToken!, taskToken!, noTimestampsToken!];
      let times: number[];
      try {
        const inputs = await asr.processor(audio);
        const outputs = await asr.model.generate({
          ...inputs,
          decoder_input_ids: [[...prefix, ...ids]],
          max_new_tokens: 1,
          output_attentions: true,
          return_dict_in_generate: true,
        });
        const numFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));
        const tensor = asr.model._extract_token_timestamps(
          outputs,
          alignmentHeads!,
          numFrames,
          TIME_PRECISION,
          prefix.length,
        );
        times = Array.from(tensor[0]!.data as ArrayLike<number>).slice(prefix.length);
      } catch {
        return undefined;
      }
      if (times.length < ids.length) return undefined;

      const spans: ForcedSpan[] = words.map(() => ({ start: duration, end: duration }));
      for (let position = 0; position < words.length; position += 1) {
        const first = owners.indexOf(position);
        if (first < 0) continue;
        const last = owners.lastIndexOf(position);
        const start = times[first] ?? 0;
        // A jump time marks a token's onset, so a word ends where the next one
        // begins; the closing word runs to the end of the phrase.
        const end = last + 1 < ids.length ? times[last + 1] ?? duration : duration;
        spans[position] = { start, end: Math.max(start, end) };
      }

      // Words with no tokens of their own inherit the surrounding boundary.
      for (let position = 1; position < spans.length; position += 1) {
        const previous = spans[position - 1]!;
        const current = spans[position]!;
        if (current.start < previous.start) current.start = previous.start;
        if (current.end < current.start) current.end = current.start;
      }

      return plausible(spans, duration) ? spans : undefined;
    },
  };
}
