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
  imageOverlays: ImageOverlay[] = [],
): Promise<void> {
  const filter = `ass=filename='${filterEscape(subtitles)}':fontsdir='${filterEscape(fontDirectory)}'`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input];
  if (!imageOverlays.length) {
    args.push("-vf", filter);
  } else {
    for (const overlay of imageOverlays) args.push("-loop", "1", "-i", overlay.path);
    const graph: string[] = [`[0:v]${filter}[captioned]`];
    let previous = "captioned";
    imageOverlays.forEach((overlay, index) => {
      const scaled = `overlay${index}`;
      const base = `base${index}`;
      const outputLabel = index === imageOverlays.length - 1 ? "vout" : `composite${index}`;
      const prepared = `prepared${index}`;
      const effects = ["format=rgba", `colorchannelmixer=aa=${Math.min(1, Math.max(0, overlay.opacity ?? 1))}`];
      if (overlay.fadeIn && overlay.fadeIn > 0) effects.push(`fade=t=in:st=${overlay.start}:d=${overlay.fadeIn}:alpha=1`);
      if (overlay.fadeOut && overlay.fadeOut > 0) effects.push(`fade=t=out:st=${Math.max(overlay.start, overlay.end - overlay.fadeOut)}:d=${overlay.fadeOut}:alpha=1`);
      graph.push(
        `[${index + 1}:v]${effects.join(",")}[${prepared}]`,
        `[${prepared}][${previous}]scale2ref=w=main_w*${overlay.width}:h=main_h*${overlay.height}[${scaled}][${base}]`,
        `[${base}][${scaled}]overlay=x=main_w*${overlay.x}-overlay_w/2:y=main_h*${overlay.y}-overlay_h/2:enable='between(t,${overlay.start},${overlay.end})'[${outputLabel}]`,
      );
      previous = outputLabel;
    });
    args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "0:a?");
  }
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "copy", "-movflags", "+faststart", output);
  await runProcess("ffmpeg", args);
}

export interface ImageOverlay {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
}
