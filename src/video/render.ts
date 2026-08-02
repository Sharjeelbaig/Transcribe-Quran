import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runProcess } from "../runtime/process.js";

export function bundledFontDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("../assets/fonts", import.meta.url)),
    fileURLToPath(new URL("../../assets/fonts", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

function filterEscape(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function renderCaptionedVideo(
  input: string,
  subtitles: string,
  output: string,
  fontDirectory = bundledFontDirectory(),
): Promise<void> {
  const filter = `ass=filename='${filterEscape(subtitles)}':fontsdir='${filterEscape(fontDirectory)}'`;
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
}
