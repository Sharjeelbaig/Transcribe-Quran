import { findActiveCaptionIndex } from "./caption-timing.js";

// The editor and the exporter share every line of this module. A caption is
// measured and painted exactly once, so the rendered MP4 cannot drift away from
// what the editor shows; the only difference between the two is the pixel size
// of the surface being painted.
export const DESIGN_WIDTH = 1080;
export const DESIGN_HEIGHT = 1920;

const CAPTION_COLOR = "#ffffff";
const ARABIC_WORD_GAP_EM = 0.24;
const OVERLAY_PADDING_Y = 12;

// Design-unit fallback used whenever a layer has no shadow of its own. These
// mirror the editor's resting caption look so text stays legible over video.
const BASE_SHADOWS = [
  { offsetX: 0, offsetY: 5, blur: 8, color: "rgba(0,0,0,0.95)" },
  { offsetX: 0, offsetY: 0, blur: 5, color: "rgba(0,0,0,1)" },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rgba(hex, alpha) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return `rgba(0,0,0,${clamp(alpha, 0, 1)})`;
  const value = match[1];
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${clamp(alpha, 0, 1)})`;
}

/** Normalises the optional visual block so the painter never branches on
 * undefined fields, and both callers resolve defaults identically. */
export function resolveVisual(visual = {}, defaults = {}) {
  const outlineEnabled = visual.outlineEnabled !== false;
  const shadowEnabled = visual.shadowEnabled !== false;
  return {
    opacity: clamp(numberOr(visual.opacity, 1), 0, 1),
    rotation: numberOr(visual.rotation, 0),
    outlineWidth: outlineEnabled ? Math.max(0, numberOr(visual.outlineWidth, defaults.outlineWidth ?? 0)) : 0,
    outlineColor: rgba(visual.outlineColor || "#101010", numberOr(visual.outlineOpacity, 1)),
    shadowDistance: shadowEnabled ? Math.max(0, numberOr(visual.shadowDistance, defaults.shadowDistance ?? 0)) : 0,
    shadowColor: rgba(visual.shadowColor || "#000000", numberOr(visual.shadowOpacity, 0.44)),
    shadowEnabled,
    animationIn: visual.animationIn,
    animationOut: visual.animationOut,
  };
}

function transitionMilliseconds(animation, spanSeconds) {
  if (!animation?.preset || animation.preset === "none") return 0;
  const maximum = Math.max(0, Math.floor(spanSeconds * 500));
  return clamp(Math.round(numberOr(animation.duration, 250)), 0, maximum);
}

/** Resolves an entry/exit animation into the plain opacity, offset and scale a
 * painter can apply, so the canvas needs no knowledge of animation presets. */
export function transitionState(visual, start, end, now, distanceDesign) {
  const span = Math.max(0, end - start);
  const enter = transitionMilliseconds(visual?.animationIn, span);
  const exit = transitionMilliseconds(visual?.animationOut, span);
  const inPhase = enter > 0 && now < start + enter / 1000;
  const outPhase = exit > 0 && now > end - exit / 1000;
  const animation = inPhase ? visual?.animationIn : outPhase ? visual?.animationOut : undefined;
  if (!animation?.preset || animation.preset === "none") return { opacity: 1, offsetY: 0, scale: 1 };
  const progress = inPhase
    ? clamp((now - start) / (enter / 1000), 0, 1)
    : clamp((end - now) / (exit / 1000), 0, 1);
  const distance = Math.max(12, distanceDesign * 0.18);
  if (animation.preset === "scale") {
    return {
      opacity: 0.35 + 0.65 * progress,
      offsetY: 0,
      scale: inPhase ? 0.82 + 0.18 * progress : 1 + 0.12 * (1 - progress),
    };
  }
  if (animation.preset === "slide-up" || animation.preset === "slide-down") {
    const direction = animation.preset === "slide-up" ? -1 : 1;
    return {
      opacity: progress,
      offsetY: (inPhase ? -direction : direction) * distance * (1 - progress),
      scale: 1,
    };
  }
  return { opacity: progress, offsetY: 0, scale: 1 };
}

function captionGroup(words, time, wordsPerCaption) {
  const count = Math.max(1, Math.floor(numberOr(wordsPerCaption, 1)));
  const groups = new Map();
  for (const word of words) {
    const groupStart = Math.floor((Math.max(1, word.position) - 1) / count) * count + 1;
    const key = `${word.verseKey}:${groupStart}`;
    const group = groups.get(key) || [];
    group.push(word);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.position - right.position);
    const start = numberOr(group[0]?.displayStart ?? group[0]?.start, 0);
    const end = numberOr(group.at(-1)?.displayEnd ?? group.at(-1)?.end, start);
    const lookAhead = 0.12;
    if (time < start - lookAhead || time > end) continue;
    const activeIndex = findActiveCaptionIndex(group, time, lookAhead);
    const current = activeIndex >= 0
      ? group[activeIndex]
      : [...group].reverse().find((word) => time >= numberOr(word.displayStart ?? word.start, 0)) || group[0];
    return { current, group, start, end };
  }
  return undefined;
}

function overlayWindow(overlay, duration) {
  const start = numberOr(overlay.start, 0);
  const end = Number.isFinite(Number(overlay.end)) ? Number(overlay.end) : duration || Infinity;
  return { start, end };
}

function surahNameFor(surahNames, number) {
  if (!number) return "";
  return surahNames?.get?.(number) || `Surah ${number}`;
}

function currentSurahNumber(words, time) {
  if (!words?.length) return null;
  let candidate = words[0];
  for (const word of words) {
    if (Number(word.start) <= time) candidate = word;
    else break;
  }
  return Number(String(candidate.verseKey).split(":")[0]) || null;
}

function overlayLabel(overlay, words, surahNames, time) {
  const text = overlay.text || "";
  if (!overlay.autoSurah) return text;
  return text.replace(/\{surah\}/gi, surahNameFor(surahNames, currentSurahNumber(words, time)));
}

/**
 * Resolves the project into the flat list of items visible at `time`, in design
 * coordinates. Nothing here touches the DOM, so the exporter can build the same
 * scene for a frame the editor never displayed.
 */
export function buildScene({ project, words = [], surahNames, time = 0, duration = 0 }) {
  const items = [];
  const settings = project.settings || {};
  const active = captionGroup(words, time, settings.wordsPerCaption);
  if (active) {
    const { current, group, start, end } = active;
    const ordered = group.slice().sort((left, right) => right.position - left.position);
    const arabic = project.layout.arabic;
    const translation = project.layout.translation;
    const arabicColor = arabic.color || CAPTION_COLOR;
    items.push({
      id: "caption:arabic",
      kind: "text",
      segments: ordered.map((word) => ({
        text: String(word.arabic ?? ""),
        // The inspector colour is authoritative. A playback highlight must
        // never silently replace a user-selected caption colour.
        color: arabicColor,
      })),
      gapEm: ARABIC_WORD_GAP_EM,
      center: { x: arabic.position.x, y: arabic.position.y },
      fontSize: Math.max(1, numberOr(arabic.fontSize, settings.arabicFontSize)),
      fontFamily: settings.arabicFontName || "Amiri Quran",
      fallbackFamily: "serif",
      visual: resolveVisual(arabic.visual, { outlineWidth: 4, shadowDistance: 1 }),
      transition: transitionState(
        arabic.visual,
        start,
        end,
        time,
        Math.max(1, numberOr(arabic.fontSize, settings.arabicFontSize)),
      ),
    });
    items.push({
      id: "caption:translation",
      kind: "text",
      segments: [{ text: `${current.wordTranslation ?? ""}  •  ${current.verseKey}`, color: translation.color || CAPTION_COLOR }],
      gapEm: 0,
      center: { x: translation.position.x, y: translation.position.y },
      fontSize: Math.max(1, numberOr(translation.fontSize, settings.translationFontSize)),
      fontFamily: settings.translationFontName || "Arial",
      fallbackFamily: "sans-serif",
      visual: resolveVisual(translation.visual, { outlineWidth: 3, shadowDistance: 1 }),
      transition: transitionState(
        translation.visual,
        start,
        end,
        time,
        Math.max(1, numberOr(translation.fontSize, settings.translationFontSize)),
      ),
    });
  }

  const overlays = [...(project.overlays || [])].sort(
    (left, right) => numberOr(left.zIndex, 0) - numberOr(right.zIndex, 0),
  );
  for (const overlay of overlays) {
    if (!overlay.visible) continue;
    const window = overlayWindow(overlay, duration);
    if (time < window.start || time > window.end) continue;
    const visual = resolveVisual(overlay.visual, { outlineWidth: 3, shadowDistance: 1 });
    const transition = transitionState(
      overlay.visual,
      window.start,
      Number.isFinite(window.end) ? window.end : time + 1,
      time,
      numberOr(overlay.fontSize, 72),
    );
    const box = {
      x: clamp(numberOr(overlay.position?.x, 0.5), 0, 1),
      y: clamp(numberOr(overlay.position?.y, 0.5), 0, 1),
      width: clamp(numberOr(overlay.width, 0.3), 0.01, 1),
      height: clamp(numberOr(overlay.height, 0.1), 0.01, 1),
    };
    if (overlay.type === "text") {
      const text = overlayLabel(overlay, words, surahNames, time);
      if (!text) continue;
      items.push({
        id: `overlay:${overlay.id}`,
        overlayId: overlay.id,
        kind: "text",
        segments: [{ text, color: overlay.color || CAPTION_COLOR }],
        gapEm: 0,
        box,
        anchor: "box-top",
        center: { x: box.x * DESIGN_WIDTH, y: box.y * DESIGN_HEIGHT },
        fontSize: Math.max(1, numberOr(overlay.fontSize, 72)),
        fontFamily: overlay.fontName || "Arial",
        fallbackFamily: "sans-serif",
        visual,
        transition,
      });
    } else if (overlay.source) {
      items.push({
        id: `overlay:${overlay.id}`,
        overlayId: overlay.id,
        kind: "image",
        source: overlay.source,
        box,
        visual,
        transition,
      });
    }
  }
  return { items };
}

/** Design units map to the surface exactly as the editor stage does: vertical
 * measurements (and therefore type size) scale with height, horizontal
 * positions with width. */
function surfaceScale(width, height) {
  return { x: width / DESIGN_WIDTH, y: height / DESIGN_HEIGHT };
}

function fontString(fontSizePx, family, fallback) {
  return `${fontSizePx}px "${String(family).replace(/"/g, "")}", ${fallback}`;
}

function measureRun(ctx, item, fontSizePx) {
  const gap = (item.gapEm || 0) * fontSizePx;
  const widths = item.segments.map((segment) => ctx.measureText(segment.text).width);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, item.segments.length - 1);
  const probe = ctx.measureText("Mع");
  const ascent = probe.fontBoundingBoxAscent || fontSizePx * 0.8;
  const descent = probe.fontBoundingBoxDescent || fontSizePx * 0.2;
  return { widths, gap, total, ascent, descent };
}

function applyShadow(ctx, visual, scale) {
  if (visual.shadowDistance > 0) {
    ctx.shadowColor = visual.shadowColor;
    ctx.shadowOffsetX = visual.shadowDistance * scale;
    ctx.shadowOffsetY = visual.shadowDistance * scale;
    ctx.shadowBlur = Math.max(1, visual.shadowDistance * 2) * scale;
    return true;
  }
  return false;
}

function clearShadow(ctx) {
  ctx.shadowColor = "transparent";
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 0;
}

function paintTextItem(ctx, item, surface) {
  const scale = surface.y;
  const fontSizePx = item.fontSize * scale;
  ctx.font = fontString(fontSizePx, item.fontFamily, item.fallbackFamily);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const run = measureRun(ctx, item, fontSizePx);

  let centerX;
  let baselineY;
  if (item.anchor === "box-top") {
    const boxTop = (item.box.y - item.box.height / 2) * surface.height;
    centerX = item.box.x * surface.width;
    baselineY = boxTop + OVERLAY_PADDING_Y * scale + run.ascent;
  } else {
    centerX = item.center.x * surface.x;
    baselineY = item.center.y * scale + (run.ascent - run.descent) / 2;
  }

  const transition = item.transition || { opacity: 1, offsetY: 0, scale: 1 };
  ctx.save();
  ctx.globalAlpha = clamp(item.visual.opacity * transition.opacity, 0, 1);
  ctx.translate(centerX, baselineY + transition.offsetY * scale);
  if (item.visual.rotation) ctx.rotate((item.visual.rotation * Math.PI) / 180);
  if (transition.scale !== 1) ctx.scale(transition.scale, transition.scale);

  let cursor = -run.total / 2;
  const positions = run.widths.map((width, index) => {
    const x = cursor;
    cursor += width + (index < run.widths.length - 1 ? run.gap : 0);
    return x;
  });

  const shadowed = applyShadow(ctx, item.visual, scale);
  if (shadowed) {
    item.segments.forEach((segment, index) => {
      ctx.fillStyle = segment.color;
      ctx.fillText(segment.text, positions[index], 0);
    });
  } else {
    for (const shadow of BASE_SHADOWS) {
      ctx.shadowColor = shadow.color;
      ctx.shadowOffsetX = shadow.offsetX * scale;
      ctx.shadowOffsetY = shadow.offsetY * scale;
      ctx.shadowBlur = shadow.blur * scale;
      item.segments.forEach((segment, index) => {
        ctx.fillStyle = segment.color;
        ctx.fillText(segment.text, positions[index], 0);
      });
    }
  }
  clearShadow(ctx);

  item.segments.forEach((segment, index) => {
    ctx.fillStyle = segment.color;
    ctx.fillText(segment.text, positions[index], 0);
  });
  if (item.visual.outlineWidth > 0) {
    // The editor paints -webkit-text-stroke over the glyph fill, so the stroke
    // is centred on the outline and bites into the letter. Stroking after the
    // fill reproduces that instead of the fatter outside-only outline.
    ctx.lineWidth = item.visual.outlineWidth * scale;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = item.visual.outlineColor;
    item.segments.forEach((segment, index) => {
      ctx.strokeText(segment.text, positions[index], 0);
    });
  }
  ctx.restore();

  return {
    x: centerX - run.total / 2,
    y: baselineY - run.ascent,
    width: run.total,
    height: run.ascent + run.descent,
  };
}

function paintImageItem(ctx, item, surface, images) {
  const image = images?.get?.(item.source);
  const boxWidth = item.box.width * surface.width;
  const boxHeight = item.box.height * surface.height;
  const boxLeft = item.box.x * surface.width - boxWidth / 2;
  const boxTop = item.box.y * surface.height - boxHeight / 2;
  if (image) {
    const transition = item.transition || { opacity: 1, offsetY: 0, scale: 1 };
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    // `object-fit: contain`, matching the editor's overlay image rule.
    const fit = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const drawWidth = naturalWidth * fit;
    const drawHeight = naturalHeight * fit;
    ctx.save();
    ctx.globalAlpha = clamp(item.visual.opacity * transition.opacity, 0, 1);
    ctx.translate(boxLeft + boxWidth / 2, boxTop + boxHeight / 2 + transition.offsetY * surface.y);
    if (item.visual.rotation) ctx.rotate((item.visual.rotation * Math.PI) / 180);
    if (transition.scale !== 1) ctx.scale(transition.scale, transition.scale);
    ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
  }
  return { x: boxLeft, y: boxTop, width: boxWidth, height: boxHeight };
}

/**
 * Paints a scene onto any 2D context and returns each item's bounding box in
 * surface pixels so the editor can hit-test and place handles.
 */
export function paintScene(ctx, scene, { width, height, images } = {}) {
  const scale = surfaceScale(width, height);
  const surface = { ...scale, width, height };
  const boxes = new Map();
  for (const item of scene.items) {
    const box = item.kind === "image"
      ? paintImageItem(ctx, item, surface, images)
      : paintTextItem(ctx, item, surface);
    boxes.set(item.id, { ...box, item });
  }
  return boxes;
}

/** Editor-only chrome. The exporter never calls this, so selection outlines and
 * handles can never end up burned into a rendered video. */
export function paintSelection(ctx, boxes, { selectedId, handles = true, accent = "#e0af45" } = {}) {
  const box = selectedId ? boxes.get(selectedId) : undefined;
  if (!box) return [];
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);
  ctx.setLineDash([]);
  const controls = [];
  if (handles) {
    const size = 12;
    const resize = { name: "resize", x: box.x + box.width + 4 - size / 2, y: box.y + box.height + 4 - size / 2, size };
    const rotate = { name: "rotate", x: box.x + box.width / 2 - size / 2, y: box.y - 26 - size / 2, size };
    for (const handle of [resize, rotate]) {
      ctx.fillStyle = accent;
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (handle.name === "rotate") ctx.arc(handle.x + size / 2, handle.y + size / 2, size / 2, 0, Math.PI * 2);
      else ctx.rect(handle.x, handle.y, size, size);
      ctx.fill();
      ctx.stroke();
      controls.push(handle);
    }
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.moveTo(box.x + box.width / 2, box.y - 20);
    ctx.lineTo(box.x + box.width / 2, box.y - 4);
    ctx.stroke();
  }
  ctx.restore();
  return controls;
}

/** Returns the topmost item under a surface-pixel point, or undefined. */
export function hitTest(boxes, x, y, padding = 6) {
  let found;
  for (const [id, box] of boxes) {
    if (
      x >= box.x - padding && x <= box.x + box.width + padding &&
      y >= box.y - padding && y <= box.y + box.height + padding
    ) {
      found = { id, box };
    }
  }
  return found;
}
