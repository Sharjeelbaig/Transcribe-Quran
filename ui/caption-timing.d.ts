export interface CaptionTimingWord {
  start: number;
  end: number;
  displayStart?: number;
  displayEnd?: number;
}

export function captionDisplayStart(word: CaptionTimingWord): number;
export function captionDisplayEnd(word: CaptionTimingWord): number;

export function findActiveCaptionIndex(
  words: CaptionTimingWord[],
  currentTime: number,
  lookAheadSeconds?: number,
): number;
