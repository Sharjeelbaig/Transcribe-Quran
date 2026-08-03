export function captionDisplayStart(word) {
  return Number(word.displayStart ?? word.start);
}

export function captionDisplayEnd(word) {
  return Number(word.displayEnd ?? word.end);
}

export function findActiveCaptionIndex(words, currentTime, lookAheadSeconds = 0.12) {
  const active = words.findIndex((word) => currentTime >= captionDisplayStart(word) && currentTime <= captionDisplayEnd(word));
  if (active >= 0) return active;
  return words.findIndex(
    (word) => currentTime < captionDisplayStart(word) && captionDisplayStart(word) - currentTime <= lookAheadSeconds,
  );
}
