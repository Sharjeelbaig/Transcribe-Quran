export function findActiveCaptionIndex(words, currentTime, lookAheadSeconds = 0.12) {
  const active = words.findIndex((word) => currentTime >= word.start && currentTime <= word.end);
  if (active >= 0) return active;
  return words.findIndex(
    (word) => currentTime < word.start && word.start - currentTime <= lookAheadSeconds,
  );
}
