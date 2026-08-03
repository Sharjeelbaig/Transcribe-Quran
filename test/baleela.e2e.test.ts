import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, processVideo } from "../src/index.js";

const fixture = process.env.BALEELA_FIXTURE;
const fixtureTest = fixture && existsSync(fixture) ? it : it.skip;

describe("Baleela word-timing regression", () => {
  fixtureTest("keeps Rabb visible from alignment through the generated ASS captions", async () => {
    if (!fixture) throw new Error("BALEELA_FIXTURE was not set.");
    const directory = await mkdtemp(join(tmpdir(), "transcribe-quran-baleela-"));
    try {
      const result = await processVideo({
        input: fixture,
        alignmentOutput: join(directory, "alignment.json"),
        subtitleOutput: join(directory, "captions.ass"),
        model: DEFAULT_MODEL,
        dtype: "q8",
        translation: "saheehInternational",
        confidenceThreshold: 0.5,
        burnVideo: false,
        offline: true,
        keepTemporaryFiles: false,
        verbose: false,
      });
      const rabb = result.alignment.words.find((word) => word.verseKey === "1:2" && word.position === 3);
      const frameRate = result.alignment.frameRate ?? 30;

      expect(rabb?.arabic).toBe("رَبِّ");
      expect(rabb?.inferredTiming).toBe(false);
      expect((rabb?.displayEnd ?? 0) - (rabb?.displayStart ?? 0)).toBeGreaterThanOrEqual(3 / frameRate - 0.001);
      const ass = await readFile(result.subtitlePath, "utf8");
      expect(ass).toContain("رَبِّ");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
