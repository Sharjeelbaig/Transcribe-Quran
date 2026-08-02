import { access, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { assertFfmpeg, durationSeconds, extractPcmAudio, readFloat32Pcm } from "./audio/audio.js";
import { createAss } from "./captions/ass.js";
import { transcribeAudio } from "./model/transcriber.js";
import { buildQuranIndex, loadQuranCorpus } from "./quran/corpus.js";
import { matchTranscript, materializeAlignedWords } from "./quran/matcher.js";
import { renderCaptionedVideo } from "./video/render.js";
import type { AlignmentDocument, ProcessOptions } from "./types.js";

export interface ProcessResult {
  alignmentPath: string;
  subtitlePath: string;
  videoPath?: string;
  alignment: AlignmentDocument;
}

function outputPaths(options: ProcessOptions): {
  video: string;
  alignment: string;
  subtitles: string;
} {
  const input = parse(options.input);
  const base = join(input.dir, input.name);
  return {
    video: resolve(options.output ?? `${base}.transcribed${input.ext || ".mp4"}`),
    alignment: resolve(options.alignmentOutput ?? `${base}.quran-alignment.json`),
    subtitles: resolve(options.subtitleOutput ?? `${base}.quran-captions.ass`),
  };
}

async function ensureInput(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Input video does not exist: ${path}`);
  }
}

export async function processVideo(options: ProcessOptions): Promise<ProcessResult> {
  const input = resolve(options.input);
  await ensureInput(input);
  await assertFfmpeg();
  const paths = outputPaths({ ...options, input });
  if (options.burnVideo && paths.video === input) {
    throw new Error("Output video must not overwrite the input video.");
  }
  await Promise.all([mkdir(dirname(paths.alignment), { recursive: true }), mkdir(dirname(paths.subtitles), { recursive: true })]);
  if (options.burnVideo) await mkdir(dirname(paths.video), { recursive: true });

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "transcribe-quran-"));
  const pcmPath = join(temporaryDirectory, `${basename(input, extname(input))}.f32le`);
  try {
    console.error("[1/6] Extracting audio with FFmpeg…");
    await extractPcmAudio(input, pcmPath);
    const audio = await readFloat32Pcm(pcmPath);
    const duration = durationSeconds(audio);

    console.error("[2/6] Running the local Qur'an Whisper model…");
    const transcription = await transcribeAudio(audio, {
      model: options.model,
      dtype: options.dtype,
      offline: options.offline,
      verbose: options.verbose,
    });
    if (options.verbose) console.error(`Recognized Arabic: ${transcription.text}`);

    console.error("[3/6] Loading and indexing the canonical Qur'an…");
    const corpus = await loadQuranCorpus();
    const index = buildQuranIndex(corpus);

    console.error("[4/6] Matching recognized speech to canonical verses…");
    const match = matchTranscript(transcription.words, index, options.confidenceThreshold);
    if (options.verbose) {
      console.error(`Matcher window scores: ${match.windowScores.map((score) => score.toFixed(3)).join(", ")}`);
      console.error(`Unmatched windows: ${match.unmatchedWindows}`);
    }
    const words = materializeAlignedWords(match.matched, index, options.translation);
    if (!words.length) {
      throw new Error(
        "No Qur'anic passage passed the confidence threshold. The program refused to create potentially incorrect captions.",
      );
    }
    const averageConfidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
    const alignment: AlignmentDocument = {
      schemaVersion: 1,
      sourceVideo: input,
      model: options.model,
      translation: options.translation,
      durationSeconds: duration,
      generatedAt: new Date().toISOString(),
      words,
      diagnostics: {
        transcriptWords: transcription.words.length,
        matchedWords: match.matched.length,
        inferredWords: words.filter((word) => word.inferredTiming).length,
        averageConfidence,
      },
    };
    await writeFile(paths.alignment, `${JSON.stringify(alignment, null, 2)}\n`, "utf8");

    console.error("[5/6] Generating RTL word-by-word ASS captions…");
    await writeFile(
      paths.subtitles,
      createAss(words, index, options.wordsPerCaption ?? 1, {
        ...(options.fontSize !== undefined ? { arabicFontSize: options.fontSize } : {}),
        ...(options.translationFontSize !== undefined
          ? { translationFontSize: options.translationFontSize }
          : {}),
      }),
      "utf8",
    );

    let videoPath: string | undefined;
    if (options.burnVideo) {
      console.error("[6/6] Rendering the captioned video…");
      const temporaryVideo = join(temporaryDirectory, `rendered${extname(paths.video) || ".mp4"}`);
      await renderCaptionedVideo(input, paths.subtitles, temporaryVideo);
      try {
        await rename(temporaryVideo, paths.video);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw error;
        await copyFile(temporaryVideo, paths.video);
      }
      videoPath = paths.video;
    } else {
      console.error("[6/6] Video rendering skipped (--no-burn).");
    }

    return {
      alignmentPath: paths.alignment,
      subtitlePath: paths.subtitles,
      ...(videoPath ? { videoPath } : {}),
      alignment,
    };
  } finally {
    if (options.keepTemporaryFiles) console.error(`Temporary files retained at ${temporaryDirectory}`);
    else await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
