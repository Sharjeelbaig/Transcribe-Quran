import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { assertFfmpeg, durationSeconds, extractPcmAudio, probeVideoFrameRate, readFloat32Pcm } from "./audio/audio.js";
import { buildPhraseSegments } from "./audio/segmenter.js";
import { protectWordTimings } from "./audio/timing-guard.js";
import {
  DEFAULT_SPEECH_PAUSE_SECONDS,
  analyzeSpeech,
  measureCaptionCoverage,
} from "./audio/timing.js";
import { createAss } from "./captions/ass.js";
import { MAX_SEGMENT_SECONDS, createModelSession } from "./model/session.js";
import { buildQuranIndex, loadQuranCorpus } from "./quran/corpus.js";
import { matchTranscript } from "./quran/matcher.js";
import {
  MAX_BRIDGE_WORDS,
  canonicalSpanOf,
  completeVerse,
  evenTimings,
  materializeSpan,
  reconcileSpan,
  trimCollapsedTail,
} from "./quran/passage.js";
import { renderCaptionedVideo } from "./video/render.js";
import { stretchAudio } from "./audio/tempo.js";
import type { AlignedWord, AlignmentDocument, ProcessOptions, TranscriptWord } from "./types.js";

export interface ProcessResult {
  alignmentPath: string;
  subtitlePath: string;
  videoPath?: string;
  alignment: AlignmentDocument;
}

const SAMPLE_RATE = 16_000;
/** Shortest a speculatively added closing word may be and still be believed. */
const VERSE_COMPLETION_MINIMUM_SECONDS = 0.25;

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

async function installedPackageVersion(): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

function sliceAudio(audio: Float32Array, start: number, end: number): Float32Array {
  const first = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const last = Math.min(audio.length, Math.ceil(end * SAMPLE_RATE));
  return audio.slice(first, Math.max(first + 1, last));
}

export async function processVideo(options: ProcessOptions): Promise<ProcessResult> {
  const input = resolve(options.input);
  await ensureInput(input);
  await assertFfmpeg();
  const packageVersion = await installedPackageVersion();
  const detectedFrameRate = options.frameRate ?? await probeVideoFrameRate(input);
  const speechPauseSeconds = options.speechPauseSeconds ?? DEFAULT_SPEECH_PAUSE_SECONDS;
  const tempo = options.tempo ?? 1;
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error("tempo must be a positive number.");
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

    console.error("[2/6] Finding where the reciter speaks and stops…");
    const speech = analyzeSpeech(audio, { pauseSeconds: speechPauseSeconds });
    // A phrase is cut to fit the model's audio window, never to fit an ayah:
    // the passage it contains is discovered afterwards.
    const phrases = buildPhraseSegments(speech, Math.min(MAX_SEGMENT_SECONDS, MAX_SEGMENT_SECONDS / tempo));
    const voiced = speech.segments.reduce((total, segment) => total + (segment.end - segment.start), 0);
    console.error(`      ${phrases.length} phrases, ${voiced.toFixed(1)} s of recitation in ${duration.toFixed(1)} s of audio.`);

    console.error("[3/6] Loading and indexing the canonical Qur'an…");
    const corpus = await loadQuranCorpus();
    const index = buildQuranIndex(corpus);

    console.error("[4/6] Identifying each phrase and measuring its word timings…");
    const session = await createModelSession({
      model: options.model,
      dtype: options.dtype,
      offline: options.offline,
      verbose: options.verbose,
    });

    // Each phrase is recognized on its own, but the passages are identified
    // from the whole transcript at once. A two-word phrase is ambiguous in
    // isolation and unmistakable in the context of the recitation around it.
    const transcripts: Array<{ phrase: (typeof phrases)[number]; words: TranscriptWord[] }> = [];
    for (const phrase of phrases) {
      const raw = sliceAudio(audio, phrase.start, phrase.end);
      const analysed = tempo === 1 ? raw : await stretchAudio(raw, tempo, temporaryDirectory);
      const local = await session.transcribe(analysed);
      transcripts.push({
        phrase,
        words: local.map((word) => ({
          ...word,
          start: phrase.start + word.start * tempo,
          end: phrase.start + word.end * tempo,
        })),
      });
    }

    const wholeTranscript = transcripts.flatMap((entry) => entry.words);
    const transcriptWords = wholeTranscript.length;
    const match = matchTranscript(wholeTranscript, index, options.confidenceThreshold);
    if (options.verbose) {
      console.error(`      recognized ${transcriptWords} words; ${match.unmatchedWindows} window(s) unidentified.`);
    }

    const words: AlignedWord[] = [];
    let previousLast: number | undefined;
    let unmatchedPhrases = 0;
    let forcedPhrases = 0;
    let fallbackPhrases = 0;

    for (const [position, { phrase }] of transcripts.entries()) {
      const raw = sliceAudio(audio, phrase.start, phrase.end);
      const analysed = tempo === 1 ? raw : await stretchAudio(raw, tempo, temporaryDirectory);
      const analysedDuration = analysed.length / SAMPLE_RATE;

      // The passage this phrase carries is whatever the matcher placed inside
      // its span of time.
      const inside = match.matched.filter((word) => {
        const midpoint = (word.start + word.end) / 2;
        return midpoint >= phrase.start && midpoint < phrase.end;
      });
      const rawSpan = canonicalSpanOf(
        inside.map((word) => word.canonicalIndex),
        index,
        phrase.end - phrase.start,
      );
      const continued = previousLast !== undefined && rawSpan !== undefined && rawSpan.first <= previousLast + MAX_BRIDGE_WORDS;
      const span = rawSpan ? reconcileSpan(rawSpan, previousLast, continued) : undefined;
      if (!span) {
        unmatchedPhrases += 1;
        continue;
      }

      // The passage is now known, so the displayed text comes from the corpus
      // and the recognizer's own words are discarded.
      const textOf = (from: number, to: number): string[] => {
        const list: string[] = [];
        for (let item = from; item <= to; item += 1) list.push(index.words[item]!.word.text.imlaei);
        return list;
      };

      // Offer the rest of the ayah to the aligner and let the audio decide
      // whether those closing words were recited in this phrase.
      const extended = completeVerse(span, index);
      let effective = span;
      let forced = extended.last > span.last
        ? await session.align(analysed, textOf(extended.first, extended.last))
        : undefined;
      if (forced) {
        // These closing words are speculative, so they have to look like real
        // recitation to be kept. A word ending an ayah is normally drawn out,
        // never a fraction of a second.
        const keep = trimCollapsedTail(forced, span.last - span.first + 1, VERSE_COMPLETION_MINIMUM_SECONDS);
        forced = forced.slice(0, keep);
        // Whatever the discarded words were holding belongs to the last real
        // word, which runs to the end of the phrase.
        const closing = forced[keep - 1];
        if (closing) forced[keep - 1] = { start: closing.start, end: analysedDuration };
        effective = { first: extended.first, last: extended.first + keep - 1 };
      } else {
        forced = await session.align(analysed, textOf(span.first, span.last));
      }

      const wordCount = effective.last - effective.first + 1;
      const timings = forced ?? evenTimings(wordCount, analysedDuration);
      if (forced) forcedPhrases += 1;
      else fallbackPhrases += 1;

      // Timings are measured on the analysed audio. Undo the stretch and place
      // them back on the original recording's clock.
      const placed = timings.map((timing) => ({
        start: phrase.start + timing.start * tempo,
        end: phrase.start + timing.end * tempo,
      }));

      const averageConfidence = inside.length
        ? inside.reduce((total, word) => total + word.matchConfidence, 0) / inside.length
        : 0.5;
      const phraseWords = materializeSpan(effective, index, options.translation, placed, averageConfidence, forced !== undefined);
      const last = phraseWords.at(-1);
      if (last) last.endsSpeechSegment = phrase.endsOnSilence;
      words.push(...phraseWords);
      previousLast = effective.last;

      if (options.verbose) {
        const label = index.words[effective.first]!;
        console.error(
          `      phrase ${position + 1}/${phrases.length} ${phrase.start.toFixed(1)}-${phrase.end.toFixed(1)}s → ` +
            `${label.verseKey}:${label.position} +${effective.last - effective.first} words (${forced ? "forced" : "estimated"})`,
        );
      }
    }

    if (!words.length) {
      throw new Error(
        "No Qur'anic passage passed the confidence threshold. The program refused to create potentially incorrect captions.",
      );
    }

    const timing = protectWordTimings(words, words, {
      ...(detectedFrameRate !== undefined ? { frameRate: detectedFrameRate } : {}),
      ...(options.minimumCaptionFrames !== undefined ? { minimumCaptionFrames: options.minimumCaptionFrames } : {}),
      ...(options.minimumWordSeconds !== undefined ? { minimumWordSeconds: options.minimumWordSeconds } : {}),
      ...(options.captionHoldSeconds !== undefined ? { segmentHoldSeconds: options.captionHoldSeconds } : {}),
      ...(options.maximumCaptionDriftSeconds !== undefined
        ? { maximumDisplayDriftSeconds: options.maximumCaptionDriftSeconds }
        : {}),
    });
    const finalWords = timing.words;
    const averageConfidence = finalWords.reduce((sum, word) => sum + word.confidence, 0) / finalWords.length;
    const coverage = measureCaptionCoverage(
      speech,
      finalWords.map((word) => ({ start: word.displayStart ?? word.start, end: word.displayEnd ?? word.end })),
    );

    const alignment: AlignmentDocument = {
      schemaVersion: 1,
      ...(packageVersion ? { packageVersion } : {}),
      sourceVideo: input,
      model: options.model,
      translation: options.translation,
      durationSeconds: duration,
      frameRate: timing.diagnostics.frameRate,
      generatedAt: new Date().toISOString(),
      words: finalWords,
      diagnostics: {
        transcriptWords,
        matchedWords: finalWords.length,
        inferredWords: finalWords.filter((word) => word.inferredTiming).length,
        averageConfidence,
        timingFrameRate: timing.diagnostics.frameRate,
        minimumCaptionFrames: timing.diagnostics.minimumCaptionFrames,
        speechPauseSeconds,
        refinementFallbackWords: timing.diagnostics.refinementFallbackWords,
        displayExtendedWords: timing.diagnostics.displayExtendedWords,
        maximumDisplayShiftSeconds: timing.diagnostics.maximumDisplayShiftSeconds,
        minimumDisplaySeconds: timing.diagnostics.minimumDisplaySeconds,
        belowMinimumWords: timing.diagnostics.belowMinimumWords,
        speechSegments: speech.segments.length,
        voicedSeconds: coverage.voicedSeconds,
        uncoveredSpeechSeconds: coverage.uncoveredSeconds,
        phrases: phrases.length,
        forcedPhrases,
        estimatedPhrases: fallbackPhrases,
        unmatchedPhrases,
        tempo,
      },
    };
    await writeFile(paths.alignment, `${JSON.stringify(alignment, null, 2)}\n`, "utf8");

    console.error("[5/6] Generating RTL word-by-word ASS captions…");
    await writeFile(
      paths.subtitles,
      createAss(finalWords, index, options.wordsPerCaption ?? 1, {
        ...(options.fontName !== undefined ? { arabicFontName: options.fontName } : {}),
        ...(options.translationFontName !== undefined
          ? { translationFontName: options.translationFontName }
          : {}),
        ...(options.fontSize !== undefined ? { arabicFontSize: options.fontSize } : {}),
        ...(options.translationFontSize !== undefined
          ? { translationFontSize: options.translationFontSize }
          : {}),
        ...(options.captionGap !== undefined ? { captionGap: options.captionGap } : {}),
        minimumDisplaySeconds: timing.diagnostics.minimumDisplaySeconds,
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
