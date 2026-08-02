import { readFile } from "node:fs/promises";
import { runProcess } from "../runtime/process.js";

export const SAMPLE_RATE = 16_000;

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

export async function readFloat32Pcm(path: string): Promise<Float32Array> {
  const buffer = await readFile(path);
  if (buffer.length % 4 !== 0) throw new Error(`Invalid float32 PCM byte length: ${buffer.length}`);
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy);
}

export function durationSeconds(audio: Float32Array): number {
  return audio.length / SAMPLE_RATE;
}
