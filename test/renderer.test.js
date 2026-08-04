import { describe, expect, it } from "vitest";
import { buildScene } from "../ui/renderer.js";

const project = {
  settings: { wordsPerCaption: 3, arabicFontName: "Amiri Quran", translationFontName: "Arial", arabicFontSize: 310, translationFontSize: 92 },
  layout: {
    arabic: { position: { x: 540, y: 894 }, fontSize: 310, color: "#FFFFFF", visual: { animationIn: { preset: "fade", duration: 500 }, animationOut: { preset: "fade", duration: 500 } } },
    translation: { position: { x: 540, y: 1135 }, fontSize: 92, color: "#FFFFFF", visual: { animationIn: { preset: "fade", duration: 500 }, animationOut: { preset: "fade", duration: 500 } } },
  },
  overlays: [],
};

const words = [
  { verseKey: "1:1", position: 1, arabic: "بِسْمِ", wordTranslation: "In", start: 1, end: 2, displayStart: 1, displayEnd: 2 },
  { verseKey: "1:1", position: 2, arabic: "اللَّهِ", wordTranslation: "the", start: 2.4, end: 3, displayStart: 2.4, displayEnd: 3 },
  { verseKey: "1:1", position: 3, arabic: "الرَّحْمَنِ", wordTranslation: "name", start: 3, end: 4, displayStart: 3, displayEnd: 4 },
];

describe("grouped caption preview scene", () => {
  it("keeps a multi-word line visible through the group gap", () => {
    const scene = buildScene({ project, words, time: 2.2 });

    expect(scene.items).toHaveLength(2);
    expect(scene.items[0].segments).toHaveLength(3);
    expect(scene.items[0].transition.opacity).toBe(1);
  });

  it("animates the group once at its outer edges", () => {
    const entering = buildScene({ project, words, time: 1.2 });
    const settled = buildScene({ project, words, time: 2.7 });
    const exiting = buildScene({ project, words, time: 3.8 });

    expect(entering.items[0].transition.opacity).toBeGreaterThan(0);
    expect(entering.items[0].transition.opacity).toBeLessThan(1);
    expect(settled.items[0].transition.opacity).toBe(1);
    expect(exiting.items[0].transition.opacity).toBeGreaterThan(0);
    expect(exiting.items[0].transition.opacity).toBeLessThan(1);
  });

  it("keeps the selected caption colour on the active word", () => {
    const singleWordProject = {
      ...project,
      settings: { ...project.settings, wordsPerCaption: 1 },
    };
    const scene = buildScene({ project: singleWordProject, words, time: 1.5 });

    expect(scene.items[0].segments[0].color).toBe("#FFFFFF");
  });
});
