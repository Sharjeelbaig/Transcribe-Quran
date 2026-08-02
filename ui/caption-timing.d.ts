export interface CaptionTimingWord {
  start: number;
  end: number;
}

export function findActiveCaptionIndex(
  words: CaptionTimingWord[],
  currentTime: number,
  lookAheadSeconds?: number,
): number;
