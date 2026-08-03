import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runProcess } from "../runtime/process.js";

export const SAMPLE_RATE = 16_000;
const execFileAsync = promisify(execFile);

export async function assertFfmpeg(): Promise<void> {
  try {
    await runProcess("ffmpeg", ["-version"], { quiet: true });
  } catch {
    throw new Error("FFmpeg is required but was not found on PATH. Install FFmpeg and try again.");
  }
}

export async function extractPcmAudio(input: string, output: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-acodec",
    "pcm_f32le",
    "-f",
    "f32le",
    output,
  ]);
}

/** Returns the source video's average frames-per-second when FFprobe can read it. */
export async function probeVideoFrameRate(input: string): Promise<number | undefined> {
  try {
    const result = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=nw=1:nk=1", input],
      { maxBuffer: 1024 * 1024 },
    );
    const value = String(result.stdout).trim();
    const [numerator = Number.NaN, denominator = 1] = value.split("/").map(Number);
    const rate = denominator ? numerator / denominator : numerator;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  } catch {
    return undefined;
  }
}

export async function readFloat32Pcm(path: string): Promise<Float32Array> {
  const buffer = await readFile(path);
  if (buffer.length % 4 !== 0) throw new Error(`Invalid float32 PCM byte length: ${buffer.length}`);
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy);
}

export function durationSeconds(audio: Float32Array): number {
  return audio.length / SAMPLE_RATE;
}
