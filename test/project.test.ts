import { describe, expect, it } from "vitest";
import { applyCaptionEdits, captionEventId, createEmptyProject } from "../src/ui/project.js";
import type { AlignmentDocument } from "../src/types.js";

const alignment: AlignmentDocument = {
  schemaVersion: 1,
  sourceVideo: "sample.mp4",
  model: "local",
  translation: "saheehInternational",
  durationSeconds: 10,
  generatedAt: "2026-01-01T00:00:00.000Z",
  words: [
    {
      start: 1,
      end: 2,
      surah: 1,
      verse: 1,
      verseKey: "1:1",
      position: 1,
      arabic: "بِسْمِ",
      imlaei: "بسم",
      wordTranslation: "In the name",
      verseTranslation: "In the name of Allah",
      confidence: 0.9,
      inferredTiming: false,
      canonicalIndex: 0,
    },
    {
      start: 2,
      end: 3,
      surah: 1,
      verse: 1,
      verseKey: "1:1",
      position: 2,
      arabic: "اللَّهِ",
      imlaei: "الله",
      wordTranslation: "Allah",
      verseTranslation: "In the name of Allah",
      confidence: 0.9,
      inferredTiming: false,
      canonicalIndex: 1,
    },
  ],
  diagnostics: { transcriptWords: 2, matchedWords: 2, inferredWords: 0, averageConfidence: 0.9 },
};

describe("caption edit application", () => {
  it("applies text and timing overrides without changing the source alignment", () => {
    const key = captionEventId(alignment.words[0]!, 0);
    const edited = applyCaptionEdits(alignment, {
      [key]: { arabic: "بِسْمِ اللَّهِ", wordTranslation: "In Allah's name", start: 0.25, end: 1.5 },
    });

    expect(edited.words[0]).toMatchObject({ arabic: "بِسْمِ اللَّهِ", wordTranslation: "In Allah's name", start: 0.25, end: 1.5, displayStart: 0.25, displayEnd: 1.5 });
    expect(alignment.words[0]!.arabic).toBe("بِسْمِ");
  });

  it("removes hidden words and keeps diagnostics consistent", () => {
    const key = captionEventId(alignment.words[1]!, 1);
    const edited = applyCaptionEdits(alignment, { [key]: { hidden: true } });

    expect(edited.words).toHaveLength(1);
    expect(edited.diagnostics.matchedWords).toBe(1);
  });
});

describe("empty project defaults", () => {
  it("starts without a video but uses the saved caption style and surah overlay defaults", () => {
    const project = createEmptyProject();

    expect(project.videoPath).toBeUndefined();
    expect(project.videoName).toBeUndefined();
    expect(project.settings).toMatchObject({ wordsPerCaption: 3, arabicFontSize: 407, translationFontSize: 150 });
    expect(project.layout.arabic).toMatchObject({ position: { x: 540, y: 893.6249952746381 }, color: "#FFFFFF" });
    expect(project.layout.translation).toMatchObject({ position: { x: 540.9645317683082, y: 1456.3911465618266 }, color: "#E1FF00" });
    expect(project.overlays).toEqual([expect.objectContaining({ autoSurah: true, text: "{surah}", visible: true, start: 0 })]);
  });
});
