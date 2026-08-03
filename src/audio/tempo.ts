import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAMPLE_RATE = 16_000;

/**
 * Builds an atempo chain for the requested rate. A single atempo stage only
 * accepts 0.5–100, so anything slower is reached by chaining halvings.
 */
export function atempoFilters(tempo: number): string[] {
  const filters: string[] = [];
  let remaining = tempo;
  while (remaining < 0.5 - 1e-9) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 100 + 1e-9) {
    filters.push("atempo=100");
    remaining /= 100;
  }
  if (Math.abs(remaining - 1) > 1e-9) filters.push(`atempo=${remaining}`);
  return filters;
}

let counter = 0;

/**
 * Changes the speed of a phrase without changing its pitch, so the recognizer
 * hears the same voice at a different rate. Timings measured on the result are
 * converted back by multiplying by the same tempo.
 */
export async function stretchAudio(
  audio: Float32Array,
  tempo: number,
  workingDirectory: string,
): Promise<Float32Array> {
  const filters = atempoFilters(tempo);
  if (!filters.length) return audio;

  const id = counter++;
  const source = join(workingDirectory, `tempo-${id}-in.f32le`);
  const target = join(workingDirectory, `tempo-${id}-out.f32le`);
  try {
    await writeFile(source, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
    await run("ffmpeg", [
      "-v", "error",
      "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1",
      "-i", source,
      "-af", filters.join(","),
      "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1",
      "-y", target,
    ], { maxBuffer: 1 << 28 });
    const buffer = await readFile(target);
    return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  } finally {
    await Promise.all([rm(source, { force: true }), rm(target, { force: true })]);
  }
}
