import { findActiveCaptionIndex } from "./caption-timing.js";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  buildScene,
  hitTest,
  paintScene,
  paintSelection,
} from "./renderer.js";
import { exportMp4, exportSupport } from "./export.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");
const stageCanvas = $("stage-canvas");
const stageContext = stageCanvas.getContext("2d");
const status = $("status");
const dropZone = $("drop-zone");
const stageWrap = $("stage-wrap");
const timeline = $("timeline");
const playButton = $("play-button");
const timeLabel = $("time-label");
const transcribeButton = $("transcribe-button");
const exportSubtitles = $("export-subtitles");
const exportVideo = $("export-video");
const exportPrimary = $("export-primary");
const downloadVideo = $("download-video");
const downloadLinks = $("download-links");
const videoInput = $("video-input");
const projectInput = $("project-input");
const imageInput = $("image-input");
const fontInput = $("font-input");
const captionTrack = $("caption-track");
const timelineSummary = $("timeline-summary");
const renderProgress = $("render-progress");
const toast = $("toast");
const captionEditor = $("caption-editor");
const shortcutsDialog = $("shortcuts-dialog");

let state = {
  project: {
    settings: {
      wordsPerCaption: 1,
      translation: "saheehInternational",
      arabicFontName: "Amiri Quran",
      translationFontName: "Arial",
      arabicFontSize: 310,
      translationFontSize: 92,
      captionGap: 40,
      speechPauseSeconds: 0.6,
      minimumWordSeconds: 0.5,
      captionHoldSeconds: 0.35,
      confidenceThreshold: 0.5,
      model: "Sharjeelbaig/whisper-tiny-ar-quran-onnx",
      dtype: "q8",
      offline: false
    },
    layout: {
      arabic: { position: { x: 540, y: 894 }, fontSize: 310, color: "#FFFFFF" },
      translation: { position: { x: 540, y: 1135 }, fontSize: 92, color: "#FFFFFF" }
    },
    overlays: [],
    captionEdits: {}
  },
  hasVideo: false,
  hasAlignment: false,
  alignment: null,
  job: { status: "idle" },
  outputs: {}
};
let selectedLayer = "arabic";
let selectedOverlayId = null;
let activeCaption = null;
let drag = null;
let polling = null;
let loadedVideoKey = "";
let availableFonts = [];
let history = [];
let redoHistory = [];
let toastTimer = null;
let timelineZoom = 1;
let selectedCaptionIndex = null;
let captionEditBefore = null;
let timingDrag = null;
let previewAnimationFrame = null;
let surahNames = new Map();
let sceneBoxes = new Map();
let selectionHandles = [];
let exportJob = null;
let lastRender = null;
const overlayImages = new Map();
const pendingOverlayImages = new Map();
const requestedFonts = new Set();

function icon(button, symbol) {
  if (button) button.innerHTML = `<svg><use href="#${symbol}"/></svg>`;
}

/** Turns native selects into small, keyboard-friendly MD3-style menus while
 * keeping the original select in the DOM as the source of truth. This keeps
 * project syncing and form semantics intact without depending on a UI kit. */
function enhanceSelect(select) {
  if (!select || select.dataset.customSelect === "true") return;
  select.dataset.customSelect = "true";
  select.classList.add("native-select");
  const labelText = select.closest("label")?.childNodes[0]?.textContent?.trim();
  const shell = document.createElement("div");
  shell.className = "select-shell";
  select.parentNode.insertBefore(shell, select);
  shell.appendChild(select);
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") || labelText || "Choose an option");
  trigger.innerHTML = '<span class="select-value"></span><svg class="chevron"><use href="#i-chevron"/></svg>';
  const menu = document.createElement("div");
  menu.className = "select-menu popover hidden";
  menu.setAttribute("role", "listbox");
  if (select.id) {
    menu.id = `${select.id}-menu`;
    trigger.setAttribute("aria-controls", menu.id);
  }
  shell.insertBefore(trigger, select);
  shell.insertBefore(menu, select);

  const sync = () => {
    const option = [...select.options].find((candidate) => candidate.value === select.value) || select.options[0];
    shell.querySelector(".select-value").textContent = option?.textContent || "Choose…";
    menu.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.value === select.value;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-selected", String(active));
    });
  };
  const close = () => {
    menu.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    document.querySelectorAll(".select-menu").forEach((other) => {
      if (other !== menu) {
        other.classList.add("hidden");
        other.parentElement?.querySelector(".select-trigger")?.setAttribute("aria-expanded", "false");
      }
    });
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
  };
  const choose = (value) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    trigger.focus();
  };
  select._syncCustom = sync;
  [...select.options].forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "select-option";
    item.dataset.value = option.value;
    item.setAttribute("role", "option");
    item.textContent = option.textContent;
    item.addEventListener("click", () => choose(option.value));
    item.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll(".select-option")];
      const index = items.indexOf(item);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(option.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
        trigger.focus();
      }
    });
    menu.appendChild(item);
  });
  trigger.addEventListener("click", () => {
    if (menu.classList.contains("hidden")) open(); else close();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
      menu.querySelector("button.selected")?.focus();
    }
    if (event.key === "Escape") close();
  });
  select.addEventListener("change", sync);
  sync();
}

function enhanceSelects() {
  document.querySelectorAll("select").forEach((select) => enhanceSelect(select));
}

function enhanceRange(input) {
  if (!input || input.dataset.rangeEnhanced === "true" || input.classList.contains("scrubber")) return;
  input.dataset.rangeEnhanced = "true";
  input.classList.add("range-input");
  const shell = document.createElement("div");
  shell.className = "range-shell";
  const track = document.createElement("span");
  track.className = "range-track";
  track.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = "range-fill";
  fill.setAttribute("aria-hidden", "true");
  input.parentNode.insertBefore(shell, input);
  shell.append(track, fill, input);
  const sync = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max);
    const value = Number(input.value);
    const ratio = Number.isFinite(max) && max > min
      ? Math.max(0, Math.min(1, (value - min) / (max - min)))
      : 0;
    shell.style.setProperty("--range-progress", `${ratio * 100}%`);
    input.setAttribute("aria-valuetext", `${Math.round(value)}%`);
  };
  input._syncRange = sync;
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  sync();
}

function enhanceRanges() {
  document.querySelectorAll('input[type="range"]:not(.scrubber)').forEach((input) => enhanceRange(input));
}

function syncRanges() {
  document.querySelectorAll('input[type="range"]:not(.scrubber)').forEach((input) => input._syncRange?.());
}

function projectSnapshot() {
  return JSON.stringify(state.project);
}

function updateHistoryButtons() {
  $("undo-button").disabled = history.length === 0;
  $("redo-button").disabled = redoHistory.length === 0;
}

function recordHistory(before) {
  if (!before || before === projectSnapshot()) return;
  history.push(before);
  if (history.length > 50) history.shift();
  redoHistory = [];
  updateHistoryButtons();
}

function notify(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function syncScrubber() {
  if (!timeline) return;
  const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : Math.max(0, Number(timeline.max) || 0);
  const current = Math.max(0, Math.min(duration, Number(video.currentTime) || 0));
  const progress = duration > 0 ? (current / duration) * 100 : 0;
  timeline.closest(".scrubber-shell")?.style.setProperty("--scrubber-progress", `${progress}%`);
  timeline.setAttribute("aria-valuetext", `${formatTime(current)} of ${formatTime(duration)}`);
}

function syncTimelinePlayhead() {
  if (!captionTrack) return;
  const duration = Number(state.alignment?.durationSeconds || video.duration || 0);
  const current = Math.max(0, Math.min(duration, Number(video.currentTime) || 0));
  const progress = duration > 0 ? (current / duration) * 100 : 0;
  captionTrack.style.setProperty("--timeline-progress", `${progress}%`);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `Request failed (${response.status})`);
  return body;
}

function currentLayer() {
  return state.project.layout[selectedLayer];
}

function visualFor(target) {
  target.visual ||= {};
  return target.visual;
}

function captionEventId(word, index) {
  return `${word.verseKey}:${word.position}:${word.canonicalIndex}:${index}`;
}

function captionEditFor(index) {
  const word = state.alignment?.words?.[index];
  if (!word) return undefined;
  return state.project.captionEdits?.[captionEventId(word, index)];
}

function effectiveWord(index) {
  const word = state.alignment?.words?.[index];
  if (!word) return undefined;
  const edit = captionEditFor(index);
  if (edit?.hidden) return undefined;
  const start = edit?.start !== undefined ? edit.start : word.start;
  const end = edit?.end !== undefined ? edit.end : word.end;
  const timingEdited = edit?.start !== undefined || edit?.end !== undefined;
  return {
    ...word,
    ...(edit?.arabic !== undefined ? { arabic: edit.arabic } : {}),
    ...(edit?.wordTranslation !== undefined ? { wordTranslation: edit.wordTranslation } : {}),
    start,
    end,
    ...(timingEdited ? { displayStart: start, displayEnd: end } : {}),
  };
}

function captionEntries() {
  return (state.alignment?.words || []).flatMap((word, index) => {
    const edited = effectiveWord(index);
    return edited ? [{ word: edited, index, id: captionEventId(word, index) }] : [];
  });
}

function selectedCaptionEntry() {
  if (selectedCaptionIndex === null) return undefined;
  const base = state.alignment?.words?.[selectedCaptionIndex];
  const word = effectiveWord(selectedCaptionIndex);
  if (!base) return undefined;
  return { word: word || { ...base, ...(captionEditFor(selectedCaptionIndex) || {}) }, base, index: selectedCaptionIndex, id: captionEventId(base, selectedCaptionIndex) };
}

function updateCaptionEditor() {
  if (!captionEditor) return;
  const entry = selectedCaptionEntry();
  captionEditor.classList.toggle("hidden", !entry);
  if (!entry) return;
  const edit = captionEditFor(entry.index);
  $("caption-editor-title").textContent = `${entry.word.verseKey} · word ${entry.word.position}`;
  $("caption-editor-meta").textContent = edit ? "Manual override" : "Automatic match";
  $("caption-arabic").value = entry.word.arabic || "";
  $("caption-translation").value = entry.word.wordTranslation || "";
  $("caption-start").value = Number(entry.word.start).toFixed(2);
  $("caption-end").value = Number(entry.word.end).toFixed(2);
  $("caption-hide").textContent = edit?.hidden ? "Restore caption" : "Delete caption";
  $("caption-hide").setAttribute("aria-label", edit?.hidden ? "Restore caption" : "Delete caption");
  $("caption-reset").disabled = !edit;
}

function updateLocalCaptionEdit(field, value) {
  const entry = selectedCaptionEntry();
  if (!entry) return;
  if (!state.project.captionEdits) state.project.captionEdits = {};
  const current = state.project.captionEdits[entry.id] || {};
  if (field === "start" || field === "end") {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    current[field] = Math.max(0, Math.min(Number(state.alignment?.durationSeconds || Infinity), number));
  } else {
    current[field] = String(value);
  }
  const baseValue = field === "arabic" ? entry.base.arabic : field === "wordTranslation" ? entry.base.wordTranslation : entry.base[field];
  if (current[field] === baseValue) delete current[field];
  if (!Object.keys(current).length) delete state.project.captionEdits[entry.id];
  else state.project.captionEdits[entry.id] = current;
}

function refreshCaptionEditPreview() {
  updateCaptionEditor();
  renderTimeline();
  updateStageGeometry();
  renderCaption();
}

function commitCaptionEdit(before = captionEditBefore) {
  captionEditBefore = null;
  recordHistory(before);
}

function selectCaption(index, seek = true) {
  commitCaptionEdit();
  selectedOverlayId = null;
  selectedCaptionIndex = index;
  const entry = selectedCaptionEntry();
  if (seek && entry && Number.isFinite(entry.word.start)) {
    video.currentTime = entry.word.start;
    updatePlayer();
  }
  updateCaptionEditor();
  renderOverlays();
  renderTimeline();
  showTool("captions");
}

function syncControlsFromProject() {
  const settings = state.project.settings;
  const arabicColor = state.project.layout.arabic.color || "#FFFFFF";
  const translationColor = state.project.layout.translation.color || "#FFFFFF";
  $("translation").value = settings.translation;
  $("words").value = settings.wordsPerCaption;
  $("arabic-font").value = settings.arabicFontName;
  $("translation-font").value = settings.translationFontName;
  $("arabic-size").value = settings.arabicFontSize;
  $("translation-size").value = settings.translationFontSize;
  $("caption-gap").value = settings.captionGap;
  $("arabic-color").value = arabicColor;
  $("translation-color").value = translationColor;
  $("arabic-color-value").textContent = arabicColor;
  $("translation-color-value").textContent = translationColor;
  $("speech-pause").value = settings.speechPauseSeconds ?? 0.6;
  $("min-word-seconds").value = settings.minimumWordSeconds ?? 0.5;
  $("caption-hold").value = settings.captionHoldSeconds ?? 0.35;
  $("offline").checked = Boolean(settings.offline);
  $("model").value = settings.model;
  $("dtype").value = settings.dtype;
  $("confidence").value = settings.confidenceThreshold;
  $("arabic-font-label").textContent = settings.arabicFontName;
  $("translation-font-label").textContent = settings.translationFontName;
  $("layer-x").value = Math.round(state.project.layout[selectedLayer].position.x);
  $("layer-y").value = Math.round(state.project.layout[selectedLayer].position.y);
  $("project-title").textContent = state.project.videoName ? `${state.project.videoName} · local project` : "Untitled project";
  $("video-name").textContent = state.project.videoName || "No video selected";
  document.querySelectorAll("select").forEach((select) => select._syncCustom?.());
  syncRanges();
}

function syncSettingsFromControls() {
  const settings = state.project.settings;
  settings.translation = $("translation").value;
  settings.wordsPerCaption = Math.max(1, Math.floor(Number($("words").value) || 1));
  settings.arabicFontName = $("arabic-font").value.trim() || "Amiri Quran";
  settings.translationFontName = $("translation-font").value.trim() || "Arial";
  settings.arabicFontSize = Math.max(1, Number($("arabic-size").value) || 310);
  settings.translationFontSize = Math.max(1, Number($("translation-size").value) || 92);
  settings.captionGap = Math.max(0, Number($("caption-gap").value) || 0);
  state.project.layout.arabic.color = $("arabic-color").value.toUpperCase();
  state.project.layout.translation.color = $("translation-color").value.toUpperCase();
  $("arabic-color-value").textContent = state.project.layout.arabic.color;
  $("translation-color-value").textContent = state.project.layout.translation.color;
  settings.speechPauseSeconds = Math.min(5, Math.max(0.05, Number($("speech-pause").value) || 0.6));
  settings.minimumWordSeconds = Math.min(3, Math.max(0.05, Number($("min-word-seconds").value) || 0.5));
  // Zero is a valid hold, so an empty field falls back rather than reading as 0.
  const hold = Number($("caption-hold").value);
  settings.captionHoldSeconds = Math.min(3, Math.max(0, $("caption-hold").value.trim() && Number.isFinite(hold) ? hold : 0.35));
  settings.offline = $("offline").checked;
  settings.model = $("model").value.trim() || "Sharjeelbaig/whisper-tiny-ar-quran-onnx";
  settings.dtype = $("dtype").value;
  settings.confidenceThreshold = Math.min(1, Math.max(0, Number($("confidence").value) || 0));
  state.project.layout.arabic.fontSize = settings.arabicFontSize;
  state.project.layout.translation.fontSize = settings.translationFontSize;
}

function updateLayerSelection() {
  document.querySelectorAll("[data-select-layer]").forEach((button) => {
    const active = button.dataset.selectLayer === selectedLayer;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("layer-x").value = Math.round(state.project.layout[selectedLayer].position.x);
  $("layer-y").value = Math.round(state.project.layout[selectedLayer].position.y);
  const visual = state.project.layout[selectedLayer].visual || {};
  $("layer-opacity").value = Math.round((visual.opacity ?? 1) * 100);
  $("layer-rotation").value = visual.rotation ?? 0;
  $("layer-outline").value = visual.outlineWidth ?? (selectedLayer === "arabic" ? 4 : 3);
  $("layer-shadow").value = visual.shadowDistance ?? 1;
  $("layer-outline-color").value = visual.outlineColor || "#101010";
  $("layer-shadow-color").value = visual.shadowColor || "#000000";
  $("layer-outline-enabled").checked = visual.outlineEnabled !== false;
  $("layer-shadow-enabled").checked = visual.shadowEnabled !== false;
  $("layer-outline-opacity").value = Math.round((visual.outlineOpacity ?? 1) * 100);
  $("layer-shadow-opacity").value = Math.round((visual.shadowOpacity ?? 0.44) * 100);
  $("layer-outline-opacity-value").textContent = `${$("layer-outline-opacity").value}%`;
  $("layer-shadow-opacity-value").textContent = `${$("layer-shadow-opacity").value}%`;
  $("layer-animation-in").value = visual.animationIn?.preset || "none";
  $("layer-animation-out").value = visual.animationOut?.preset || "none";
  $("layer-animation-in-duration").value = visual.animationIn?.duration ?? 250;
  $("layer-animation-out-duration").value = visual.animationOut?.duration ?? 250;
  syncRanges();
  paintStage();
}

function currentDuration() {
  return Number(state.alignment?.durationSeconds || state.project.durationSeconds || video.duration || 0);
}

/** Loads any font the scene needs into the canvas font set. Canvas silently
 * falls back to a default face for fonts the document has not loaded yet, so
 * the preview would otherwise disagree with the export for one repaint. */
function ensureFonts() {
  const families = new Set([state.project.settings.arabicFontName, state.project.settings.translationFontName]);
  for (const overlay of state.project.overlays || []) {
    if (overlay.type === "text" && overlay.fontName) families.add(overlay.fontName);
  }
  for (const family of families) {
    if (!family || requestedFonts.has(family)) continue;
    requestedFonts.add(family);
    document.fonts?.load(`64px "${String(family).replace(/"/g, "")}"`).then(() => paintStage()).catch(() => {});
  }
}

function ensureOverlayImages() {
  const loading = [];
  for (const overlay of state.project.overlays || []) {
    const source = overlay.type === "image" ? overlay.source : undefined;
    if (!source || overlayImages.has(source)) continue;
    if (pendingOverlayImages.has(source)) {
      loading.push(pendingOverlayImages.get(source));
      continue;
    }
    const image = new Image();
    image.decoding = "sync";
    const ready = new Promise((resolve) => {
      image.addEventListener("load", () => {
        pendingOverlayImages.delete(source);
        overlayImages.set(source, image);
        paintStage();
        resolve();
      });
      image.addEventListener("error", () => {
        pendingOverlayImages.delete(source);
        resolve();
      });
    });
    pendingOverlayImages.set(source, ready);
    loading.push(ready);
    image.src = source;
  }
  return Promise.all(loading);
}

function selectedSceneId() {
  if (selectedOverlayId) return `overlay:${selectedOverlayId}`;
  return `caption:${selectedLayer}`;
}

function currentScene(time = video.currentTime || 0) {
  return buildScene({
    project: state.project,
    words: captionEntries().map((entry) => entry.word),
    surahNames,
    time,
    duration: currentDuration(),
  });
}

/** The one place the editor draws captions and overlays. `exportMp4` calls the
 * same renderer against the source-resolution canvas, so anything visible here
 * is what lands in the file. */
function paintStage() {
  if (!stageCanvas || !stage.clientWidth || !stage.clientHeight) return;
  ensureFonts();
  ensureOverlayImages();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(stage.clientWidth * ratio));
  const height = Math.max(1, Math.round(stage.clientHeight * ratio));
  if (stageCanvas.width !== width || stageCanvas.height !== height) {
    stageCanvas.width = width;
    stageCanvas.height = height;
  }
  const now = video.currentTime || 0;
  stageContext.setTransform(1, 0, 0, 1, 0, 0);
  stageContext.clearRect(0, 0, width, height);
  const entries = captionEntries();
  const activeIndex = findActiveCaptionIndex(entries.map((entry) => entry.word), now);
  activeCaption = activeIndex >= 0 ? entries[activeIndex] : null;
  sceneBoxes = paintScene(stageContext, currentScene(now), { width, height, images: overlayImages });
  selectionHandles = paintSelection(stageContext, sceneBoxes, { selectedId: selectedSceneId() });
}

function updateStageGeometry() {
  paintStage();
}

function updateVideoStage() {
  if (!state.hasVideo) {
    dropZone.classList.remove("hidden");
    stageWrap.classList.add("hidden");
    playButton.disabled = true;
    timeline.disabled = true;
    transcribeButton.disabled = true;
    exportSubtitles.disabled = true;
    exportVideo.disabled = true;
    exportPrimary.disabled = true;
    downloadVideo.disabled = true;
    return;
  }
  dropZone.classList.add("hidden");
  stageWrap.classList.remove("hidden");
  transcribeButton.disabled = state.job.status === "running";
  exportSubtitles.disabled = !state.hasAlignment;
  exportVideo.disabled = !state.hasAlignment;
  exportPrimary.disabled = !state.hasAlignment;
  // Only offered once a render exists to download.
  downloadVideo.disabled = !lastRender && !state.outputs?.video;
  if (state.project.videoPath && loadedVideoKey !== state.project.videoPath) {
    loadedVideoKey = state.project.videoPath;
    video.src = `/api/video?source=${encodeURIComponent(loadedVideoKey)}&t=${Date.now()}`;
    video.load();
  }
}

function renderCaption() {
  paintStage();
}

function updatePlayer() {
  if (!Number.isFinite(video.duration)) {
    syncScrubber();
    syncTimelinePlayhead();
    return;
  }
  timeline.max = String(video.duration);
  timeline.value = String(Math.max(0, Math.min(video.duration, video.currentTime || 0)));
  syncScrubber();
  syncTimelinePlayhead();
  timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  icon(playButton, video.paused ? "i-play" : "i-pause");
  playButton.setAttribute("aria-label", video.paused ? "Play preview" : "Pause preview");
  document.querySelectorAll(".timeline-word").forEach((element) => {
    const index = Number(element.dataset.index);
    const word = effectiveWord(index);
    const displayStart = word?.displayStart ?? word?.start;
    const displayEnd = word?.displayEnd ?? word?.end;
    element.classList.toggle("active", Boolean(word && video.currentTime >= displayStart && video.currentTime <= displayEnd));
    element.classList.toggle("selected", selectedCaptionIndex === index);
    element.setAttribute("aria-pressed", String(selectedCaptionIndex === index));
  });
  renderCaption();
  renderOverlays();
}

function animateCaptionPreview() {
  if (video.paused || video.ended) {
    previewAnimationFrame = null;
    return;
  }
  renderCaption();
  previewAnimationFrame = requestAnimationFrame(animateCaptionPreview);
}

function startCaptionPreviewAnimation() {
  if (previewAnimationFrame === null) previewAnimationFrame = requestAnimationFrame(animateCaptionPreview);
}

function stopCaptionPreviewAnimation() {
  if (previewAnimationFrame !== null) cancelAnimationFrame(previewAnimationFrame);
  previewAnimationFrame = null;
}

function renderTimeline() {
  if (!captionTrack) return;
  captionTrack.style.width = `${timelineZoom * 100}%`;
  captionTrack.innerHTML = "";
  const entries = captionEntries();
  const words = entries.map((entry) => entry.word);
  const duration = Number(state.alignment?.durationSeconds || video.duration || 0);
  if (!words.length || !duration) {
    captionTrack.innerHTML = '<div class="track-empty">Caption events will appear here.</div><span class="timeline-playhead" aria-hidden="true"></span>';
    timelineSummary.textContent = "Transcribe a video to see ayahs and words.";
    syncTimelinePlayhead();
    return;
  }
  const fragment = document.createDocumentFragment();
  const ayahs = new Map();
  words.forEach((word) => {
    if (!ayahs.has(word.verseKey)) ayahs.set(word.verseKey, Number(word.displayStart ?? word.start));
  });
  timelineSummary.textContent = `${words.length} matched words · ${ayahs.size} ayahs`;
  ayahs.forEach((start, verseKey) => {
    const marker = document.createElement("span");
    marker.className = "timeline-ayah-marker";
    marker.textContent = verseKey || "Ayah";
    marker.title = `Ayah ${verseKey || ""}`.trim();
    marker.style.left = `${Math.max(0, start / duration) * 100}%`;
    marker.setAttribute("aria-hidden", "true");
    fragment.appendChild(marker);
  });
  entries.forEach((entry) => {
    const word = entry.word;
    const displayStart = Number(word.displayStart ?? word.start);
    const displayEnd = Number(word.displayEnd ?? word.end);
    const event = document.createElement("button");
    event.className = "timeline-word";
    event.type = "button";
    event.dataset.index = String(entry.index);
    event.title = `${word.verseKey} · ${word.arabic}`;
    event.setAttribute("aria-label", `Caption ${word.verseKey}, ${word.arabic}, ${formatTime(displayStart)} to ${formatTime(displayEnd)}`);
    event.setAttribute("aria-pressed", String(selectedCaptionIndex === entry.index));
    event.style.left = `${Math.max(0, displayStart / duration) * 100}%`;
    event.style.width = `${Math.max(.25, (displayEnd - displayStart) / duration * 100)}%`;
    event.innerHTML = '<span class="timeline-handle timeline-handle-start" aria-hidden="true"></span><span class="timeline-handle timeline-handle-end" aria-hidden="true"></span>';
    event.querySelector(".timeline-handle-start").addEventListener("pointerdown", (pointerEvent) => beginTimingDrag(pointerEvent, entry.index, "start"));
    event.querySelector(".timeline-handle-end").addEventListener("pointerdown", (pointerEvent) => beginTimingDrag(pointerEvent, entry.index, "end"));
    event.addEventListener("click", () => {
      selectCaption(entry.index);
    });
    fragment.appendChild(event);
  });
  const playhead = document.createElement("span");
  playhead.className = "timeline-playhead";
  playhead.setAttribute("aria-hidden", "true");
  fragment.appendChild(playhead);
  captionTrack.appendChild(fragment);
  syncTimelinePlayhead();
}

function beginTimingDrag(event, index, edge) {
  event.preventDefault();
  event.stopPropagation();
  const word = effectiveWord(index);
  if (!word) return;
  selectedCaptionIndex = index;
  timingDrag = {
    index,
    edge,
    rect: captionTrack.getBoundingClientRect(),
    duration: Number(state.alignment?.durationSeconds || video.duration || 0),
    before: projectSnapshot(),
  };
  updateCaptionEditor();
}

function moveTimingDrag(event) {
  if (!timingDrag) return;
  const word = effectiveWord(timingDrag.index);
  if (!word) return;
  const ratio = Math.max(0, Math.min(1, (event.clientX - timingDrag.rect.left) / timingDrag.rect.width));
  const time = ratio * timingDrag.duration;
  const minimum = 0.01;
  const next = timingDrag.edge === "start"
    ? Math.min(time, word.end - minimum)
    : Math.max(time, word.start + minimum);
  updateLocalCaptionEdit(timingDrag.edge, Math.max(0, next));
  updateCaptionEditor();
  updatePlayer();
}

function endTimingDrag() {
  if (!timingDrag) return;
  const before = timingDrag.before;
  timingDrag = null;
  renderTimeline();
  updateCaptionEditor();
  recordHistory(before);
}

function renderOverlays() {
  paintStage();
  syncOverlayControls();
  renderOverlayList();
}

function renderOverlayList() {
  const list = $("overlay-list");
  if (!list) return;
  list.innerHTML = "";
  const overlays = state.project.overlays || [];
  if (!overlays.length) {
    list.innerHTML = '<div class="list-empty">No extra overlays yet.</div>';
    return;
  }
  for (const overlay of overlays) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `overlay-row${overlay.id === selectedOverlayId ? " active" : ""}`;
    const label = overlay.type === "text" ? (overlay.autoSurah ? "Detected chapter" : overlay.text || "Text overlay") : "Image overlay";
    row.innerHTML = `<span>${escapeHtml(label)}</span><span>${overlay.visible ? overlay.type : "hidden"}</span>`;
    row.setAttribute("aria-pressed", String(overlay.id === selectedOverlayId));
    row.addEventListener("click", () => {
      selectedOverlayId = overlay.id;
      selectedCaptionIndex = null;
      updateCaptionEditor();
      renderTimeline();
      renderOverlays();
    });
    list.appendChild(row);
  }
}

function selectedOverlay() {
  return (state.project.overlays || []).find((overlay) => overlay.id === selectedOverlayId);
}

function deleteSelectedOverlay() {
  if (!selectedOverlay()) return false;
  const before = projectSnapshot();
  state.project.overlays = state.project.overlays.filter((overlay) => overlay.id !== selectedOverlayId);
  selectedOverlayId = null;
  renderOverlays();
  recordHistory(before);
  setStatus("Overlay deleted. Use Undo to restore it.");
  return true;
}

function syncOverlayControls() {
  const overlay = selectedOverlay();
  $("overlay-editor").classList.toggle("hidden", !overlay);
  $("delete-overlay").disabled = !overlay;
  if (!overlay) return;
  $("overlay-text-wrap").classList.toggle("hidden", overlay.type !== "text");
  $("overlay-font").closest("label").classList.toggle("hidden", overlay.type !== "text");
  $("overlay-size").closest("label").classList.toggle("hidden", overlay.type !== "text");
  $("overlay-text").value = overlay.text || "";
  $("overlay-font").value = overlay.fontName || "Arial";
  $("overlay-size").value = overlay.fontSize || 72;
  $("overlay-start").value = Number(overlay.start ?? 0).toFixed(2);
  $("overlay-end").value = Number(overlay.end ?? state.project.durationSeconds ?? video.duration ?? 0).toFixed(2);
  const visual = overlay.visual || {};
  $("overlay-opacity").value = Math.round((visual.opacity ?? 1) * 100);
  $("overlay-rotation").value = visual.rotation ?? 0;
  $("overlay-outline").value = visual.outlineWidth ?? 3;
  $("overlay-shadow").value = visual.shadowDistance ?? 1;
  $("overlay-outline-color").value = visual.outlineColor || "#101010";
  $("overlay-shadow-color").value = visual.shadowColor || "#000000";
  $("overlay-outline-enabled").checked = visual.outlineEnabled !== false;
  $("overlay-shadow-enabled").checked = visual.shadowEnabled !== false;
  $("overlay-outline-opacity").value = Math.round((visual.outlineOpacity ?? 1) * 100);
  $("overlay-shadow-opacity").value = Math.round((visual.shadowOpacity ?? 0.44) * 100);
  $("overlay-outline-opacity-value").textContent = `${$("overlay-outline-opacity").value}%`;
  $("overlay-shadow-opacity-value").textContent = `${$("overlay-shadow-opacity").value}%`;
  $("overlay-animation-in").value = visual.animationIn?.preset || "none";
  $("overlay-animation-out").value = visual.animationOut?.preset || "none";
  $("overlay-animation-duration").value = visual.animationIn?.duration ?? visual.animationOut?.duration ?? 250;
  $("overlay-lock").checked = Boolean(overlay.locked);
  $("overlay-visible").checked = overlay.visible !== false;
  $("overlay-text-wrap").querySelector("input").placeholder = overlay.autoSurah ? "e.g. Detected chapter: {surah}" : "";
  syncRanges();
}

function renderState(next) {
  state = next;
  syncControlsFromProject();
  updateVideoStage();
  updateLayerSelection();
  renderOverlays();
  syncOverlayControls();
  renderTimeline();
  updateCaptionEditor();
  const alignmentBadge = $("alignment-badge");
  alignmentBadge.textContent = state.hasAlignment ? "Ready" : state.job.status === "running" ? "Working…" : "Not transcribed";
  alignmentBadge.setAttribute("aria-live", "polite");
  transcribeButton.setAttribute("aria-busy", String(state.job.status === "running"));
  if (state.job.status === "running") setStatus(state.job.message || "Working locally…");
  else if (state.job.status === "error") setStatus(state.job.message || "Something went wrong.", true);
  else if (state.job.status === "complete") setStatus(state.job.message || "Ready to edit.");
  if (state.outputs?.video || state.outputs?.subtitles) {
    downloadLinks.innerHTML = [
      state.outputs.video ? `<a href="${state.outputs.video}" download>Download rendered MP4</a>` : "",
      state.outputs.subtitles ? `<a href="${state.outputs.subtitles}" download>Download ASS subtitles</a>` : ""
    ].join("");
  }
  updateStageGeometry();
  renderCaption();
}

async function refresh() {
  try {
    renderState(await api("/api/state"));
    if (state.job.status === "running" && !polling) {
      polling = setInterval(async () => {
        try {
          const next = await api("/api/state");
          renderState(next);
          if (next.job.status !== "running") {
            clearInterval(polling);
            polling = null;
          }
        } catch (error) {
          setStatus(error.message, true);
        }
      }, 1000);
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function uploadVideo(file) {
  if (!file) return;
  setStatus(`Uploading ${file.name}…`);
  try {
    const next = await api("/api/upload", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name },
      body: file
    });
    renderState(next);
    setStatus("Video ready. Start transcription when you are ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function transcribe() {
  commitCaptionEdit();
  syncSettingsFromControls();
  setStatus("Starting local transcription…");
  try {
    await api("/api/project", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.project) });
    await api("/api/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.project.settings) });
    await refresh();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function exportOutput(burnVideo) {
  commitCaptionEdit();
  syncSettingsFromControls();
  setStatus(burnVideo ? "Rendering the edited video…" : "Generating edited ASS subtitles…");
  try {
    const result = await api("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.project, burnVideo }) });
    renderState(result);
    setStatus(burnVideo ? "Rendered video is ready." : "ASS subtitles are ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function showRenderProgress(visible) {
  renderProgress.classList.toggle("hidden", !visible);
  renderProgress.setAttribute("aria-hidden", String(!visible));
  document.body.classList.toggle("rendering", visible);
  if (!visible) {
    $("render-bar-fill").style.width = "0%";
    $("render-progress-label").textContent = "Rendering…";
  }
}

function updateRenderProgress({ phase, progress, message }) {
  // Frame rendering dominates the wall clock, so it owns most of the bar and
  // the audio and container passes share the tail.
  const weighted = phase === "video" ? progress * 0.9 : phase === "audio" ? 0.9 + progress * 0.08 : phase === "finalize" ? 0.99 : 0;
  $("render-bar-fill").style.width = `${Math.round(Math.max(0, Math.min(1, weighted)) * 100)}%`;
  $("render-progress-label").textContent = `${Math.round(weighted * 100)}% · ${message}`;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

function exportFileName() {
  const base = String(state.project.videoName || "transcribe-quran").replace(/\.[^.]+$/, "");
  return `${base}-captioned.mp4`;
}

/** Renders the MP4 in the page with the editor's own renderer. The server's
 * FFmpeg path stays available only for browsers without WebCodecs, where it is
 * the difference between an approximate render and none at all. */
async function renderVideoLocally() {
  if (exportJob) {
    setStatus("A render is already running.");
    return;
  }
  commitCaptionEdit();
  syncSettingsFromControls();
  const support = exportSupport();
  if (!support.supported) {
    notify(support.reason);
    setStatus(`${support.reason} Falling back to the server renderer, which can differ slightly from this preview.`, true);
    await exportOutput(true);
    return;
  }
  const controller = new AbortController();
  exportJob = controller;
  exportVideo.disabled = true;
  $("export-menu").classList.add("hidden");
  showRenderProgress(true);
  setStatus("Rendering every frame with the editor's renderer. Keep this tab open.");
  try {
    ensureFonts();
    // Fonts, chapter names and overlay images all feed the renderer. Starting
    // before they land would burn placeholders into the file, or drop an
    // overlay whose image had not finished decoding.
    if (!surahNames.size) await loadSurahs();
    await Promise.all([ensureOverlayImages(), document.fonts?.ready]);
    const result = await exportMp4({
      project: state.project,
      words: captionEntries().map((entry) => entry.word),
      surahNames,
      videoUrl: video.currentSrc || video.src,
      duration: currentDuration(),
      // The pipeline already probed the container, and that beats guessing from
      // playback: a 50 fps recitation resampled to 30 judders.
      frameRate: Number(state.alignment?.diagnostics?.timingFrameRate) || undefined,
      images: overlayImages,
      signal: controller.signal,
      onProgress: updateRenderProgress,
    });
    lastRender = { blob: result.blob, name: exportFileName() };
    downloadVideo.disabled = false;
    downloadBlob(result.blob, lastRender.name);
    const size = (result.blob.size / 1_048_576).toFixed(1);
    setStatus(`Exported ${result.width}×${result.height} at ${result.frameRate} fps · ${result.frames} frames · ${size} MB${result.hasAudio ? "" : " · no audio track found"}.`);
    notify("Export finished. The file matches the preview frame for frame.");
  } catch (error) {
    if (error?.name === "AbortError") setStatus("Render cancelled.");
    else setStatus(error.message, true);
  } finally {
    exportJob = null;
    exportVideo.disabled = !state.hasAlignment;
    showRenderProgress(false);
  }
}

/** Canvas pixels for a pointer event, matching the coordinate space the
 * renderer reports its boxes in. */
function stagePoint(event) {
  const rect = stageCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * stageCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * stageCanvas.height,
    rect,
  };
}

function handleUnderPoint(point) {
  return selectionHandles.find((handle) =>
    point.x >= handle.x - 3 && point.x <= handle.x + handle.size + 3 &&
    point.y >= handle.y - 3 && point.y <= handle.y + handle.size + 3,
  );
}

function selectCaptionLayer(layerName) {
  if (selectedOverlayId) selectedOverlayId = null;
  const current = activeCaption?.word;
  if (current && activeCaption.index >= 0) {
    selectedCaptionIndex = activeCaption.index;
    updateCaptionEditor();
    renderTimeline();
  }
  selectedLayer = layerName;
  updateLayerSelection();
}

function onStagePointerDown(event) {
  if (!state.hasVideo) return;
  const point = stagePoint(event);
  const selectedBox = sceneBoxes.get(selectedSceneId());
  const handle = selectedBox ? handleUnderPoint(point) : undefined;
  const target = handle ? { id: selectedSceneId(), box: selectedBox } : hitTest(sceneBoxes, point.x, point.y);
  if (!target) {
    if (selectedOverlayId) {
      selectedOverlayId = null;
      renderOverlays();
    }
    paintStage();
    return;
  }
  event.preventDefault();
  stageCanvas.setPointerCapture?.(event.pointerId);
  const before = projectSnapshot();
  const base = { startX: event.clientX, startY: event.clientY, rect: point.rect, before };
  if (target.id.startsWith("caption:")) {
    const layerName = target.id.slice("caption:".length);
    selectCaptionLayer(layerName);
    const layer = state.project.layout[layerName];
    drag = handle?.name === "resize"
      ? { ...base, kind: "resize", layerName, startSize: layer.fontSize }
      : { ...base, kind: "move", layerName, startPosition: { ...layer.position } };
    paintStage();
    return;
  }
  const overlay = (state.project.overlays || []).find((item) => `overlay:${item.id}` === target.id);
  if (!overlay) return;
  if (overlay.id !== selectedOverlayId) {
    selectedOverlayId = overlay.id;
    selectedCaptionIndex = null;
    syncOverlayControls();
    updateCaptionEditor();
    renderTimeline();
    renderOverlays();
    // Selecting an unselected overlay only reveals its handles; the first press
    // must not also start a resize aimed at whatever was selected before.
    if (handle) return;
  }
  if (overlay.locked) return;
  if (handle?.name === "resize") {
    drag = { ...base, kind: "overlay-resize", overlay, startWidth: overlay.width, startHeight: overlay.height };
  } else if (handle?.name === "rotate") {
    const centerX = point.rect.left + ((target.box.x + target.box.width / 2) / stageCanvas.width) * point.rect.width;
    const centerY = point.rect.top + ((target.box.y + target.box.height / 2) / stageCanvas.height) * point.rect.height;
    drag = {
      ...base,
      kind: "overlay-rotate",
      overlay,
      centerX,
      centerY,
      startAngle: (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI,
      startRotation: Number(overlay.visual?.rotation || 0),
    };
  } else {
    drag = { ...base, kind: "overlay", overlay, startPosition: { ...overlay.position } };
  }
  stageCanvas.classList.add("grabbing");
}

function onStagePointerMove(event) {
  if (drag) return;
  if (!state.hasVideo) return;
  const point = stagePoint(event);
  const overHandle = sceneBoxes.get(selectedSceneId()) ? handleUnderPoint(point) : undefined;
  const cursor = overHandle?.name === "rotate" ? "grab" : overHandle ? "nwse-resize" : hitTest(sceneBoxes, point.x, point.y) ? "move" : "default";
  stageCanvas.style.cursor = cursor;
}

function moveDrag(event) {
  if (!drag) return;
  const dx = drag.rect ? ((event.clientX - drag.startX) / drag.rect.width) * DESIGN_WIDTH : 0;
  const dy = drag.rect ? ((event.clientY - drag.startY) / drag.rect.height) * DESIGN_HEIGHT : 0;
  if (drag.kind === "resize") {
    const layer = state.project.layout[drag.layerName];
    layer.fontSize = Math.max(8, Math.round(drag.startSize + dy));
    if (drag.layerName === "arabic") $("arabic-size").value = layer.fontSize;
    else $("translation-size").value = layer.fontSize;
  } else if (drag.kind === "overlay") {
    drag.overlay.position.x = Math.min(1, Math.max(0, drag.startPosition.x + dx / DESIGN_WIDTH));
    drag.overlay.position.y = Math.min(1, Math.max(0, drag.startPosition.y + dy / DESIGN_HEIGHT));
  } else if (drag.kind === "overlay-resize") {
    drag.overlay.width = Math.min(1, Math.max(0.03, drag.startWidth + (event.clientX - drag.startX) / drag.rect.width));
    drag.overlay.height = Math.min(1, Math.max(0.03, drag.startHeight + (event.clientY - drag.startY) / drag.rect.height));
  } else if (drag.kind === "overlay-rotate") {
    const angle = Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX) * 180 / Math.PI;
    visualFor(drag.overlay).rotation = Math.round(drag.startRotation + angle - drag.startAngle);
  } else {
    const layer = state.project.layout[drag.layerName];
    layer.position.x = Math.min(DESIGN_WIDTH, Math.max(0, drag.startPosition.x + dx));
    layer.position.y = Math.min(DESIGN_HEIGHT, Math.max(0, drag.startPosition.y + dy));
  }
  updateStageGeometry();
}

function endDrag() {
  if (drag?.before) recordHistory(drag.before);
  drag = null;
  stageCanvas.classList.remove("grabbing");
}

function resetLayout() {
  const before = projectSnapshot();
  const settings = state.project.settings;
  state.project.layout.arabic.position = { x: DESIGN_WIDTH / 2, y: Math.round(DESIGN_HEIGHT / 2 - (settings.translationFontSize + settings.captionGap) / 2) };
  state.project.layout.translation.position = { x: DESIGN_WIDTH / 2, y: Math.round(DESIGN_HEIGHT / 2 + (settings.arabicFontSize + settings.captionGap) / 2) };
  updateStageGeometry();
  syncControlsFromProject();
  recordHistory(before);
}

function applyLayerPosition() {
  const layer = currentLayer();
  const before = projectSnapshot();
  layer.position.x = Math.min(DESIGN_WIDTH, Math.max(0, Number($("layer-x").value) || 0));
  layer.position.y = Math.min(DESIGN_HEIGHT, Math.max(0, Number($("layer-y").value) || 0));
  updateStageGeometry();
  recordHistory(before);
}

function addTextOverlay() {
  const before = projectSnapshot();
  const overlay = {
    id: `text-${Date.now()}`,
    type: "text",
    text: "New text",
    position: { x: 0.5, y: 0.25 },
    width: 0.32,
    height: 0.08,
    fontName: "Arial",
    fontSize: 72,
    color: "#ffffff",
    visible: true,
    start: 0,
    end: Number(state.project.durationSeconds || video.duration || 0),
    visual: { opacity: 1, outlineWidth: 3, shadowDistance: 1, animationIn: { preset: "none", duration: 250 }, animationOut: { preset: "none", duration: 250 } }
  };
  state.project.overlays.push(overlay);
  selectedOverlayId = overlay.id;
  selectedCaptionIndex = null;
  renderOverlays();
  recordHistory(before);
  showTool("overlays");
  $("overlay-text").focus();
  $("overlay-text").select();
  setStatus("Text overlay added. Edit it in the inspector or drag it in the preview.");
}

function addSurahOverlay() {
  const before = projectSnapshot();
  const overlay = {
    id: `surah-${Date.now()}`,
    type: "text",
    text: "Detected chapter: {surah}",
    autoSurah: true,
    position: { x: 0.78, y: 0.06 },
    width: 0.4,
    height: 0.06,
    fontName: "Arial",
    fontSize: 48,
    color: "#ffffff",
    visible: true,
    start: 0,
    end: Number(state.project.durationSeconds || video.duration || 0),
    visual: { opacity: 1, outlineWidth: 3, shadowDistance: 1, animationIn: { preset: "none", duration: 250 }, animationOut: { preset: "none", duration: 250 } }
  };
  state.project.overlays.push(overlay);
  selectedOverlayId = overlay.id;
  selectedCaptionIndex = null;
  renderOverlays();
  recordHistory(before);
  showTool("overlays");
  setStatus("Detected-chapter overlay added. Drag it to place it, and keep {surah} in the text where the chapter name should appear.");
}

async function loadSurahs() {
  try {
    const result = await api("/api/surahs");
    surahNames = new Map((result.surahs || []).map((surah) => [surah.number, surah.name]));
    // The names arrive after the first paint, and a detected-chapter overlay
    // drawn before them would read "Surah 1" in the preview and the export.
    paintStage();
  } catch (error) {
    // Non-fatal: the detected-chapter overlay falls back to "Surah N" without this.
  }
}

async function uploadImage(file) {
  if (!file) return;
  setStatus(`Uploading ${file.name}…`);
  try {
    const result = await api("/api/overlay-upload", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name },
      body: file
    });
    const before = projectSnapshot();
    const overlay = {
      id: result.id,
      type: "image",
      source: result.source,
      position: { x: 0.5, y: 0.25 },
      width: 0.22,
      height: 0.12,
      visible: true,
      start: 0,
      end: Number(state.project.durationSeconds || video.duration || 0),
      visual: { opacity: 1, animationIn: { preset: "none", duration: 250 }, animationOut: { preset: "none", duration: 250 } }
    };
    state.project.overlays.push(overlay);
    selectedOverlayId = overlay.id;
    selectedCaptionIndex = null;
    renderOverlays();
    recordHistory(before);
    setStatus("Image overlay added. Drag it in the preview and export when ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function saveProject() {
  commitCaptionEdit();
  syncSettingsFromControls();
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.project.videoName || "transcribe-quran"}.tqproject.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Project downloaded.");
}

async function loadProject(file) {
  if (!file) return;
  try {
    commitCaptionEdit();
    const loaded = JSON.parse(await file.text());
    if (!loaded || loaded.schemaVersion !== 1 || !loaded.settings || !loaded.layout) throw new Error("Unsupported project file.");
    state.project = { ...state.project, ...loaded, videoPath: state.project.videoPath, videoName: state.project.videoName };
    state.project.captionEdits ||= {};
    await api("/api/project", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.project) });
    renderState({ ...state, project: state.project });
    setStatus("Project loaded. Choose the matching video if it is not already open.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function installFontFace(font) {
  if (!font.url || document.getElementById(`font-face-${font.id}`)) return;
  const style = document.createElement("style");
  style.id = `font-face-${font.id}`;
  const extension = String(font.format || font.url).split("?")[0].split(".").pop()?.toLowerCase();
  const format = font.format || (extension === "woff2" ? "woff2" : extension === "woff" ? "woff" : extension === "otf" ? "opentype" : "truetype");
  style.textContent = `@font-face{font-family:"${String(font.family).replace(/"/g, "")}";src:url("${font.url}") format("${format}");font-display:swap}`;
  document.head.appendChild(style);
}

function renderFontOptions(kind, query = "") {
  const options = $(`${kind}-font-options`);
  const needle = query.trim().toLowerCase();
  const selected = $(kind === "arabic" ? "arabic-font" : "translation-font").value;
  options.innerHTML = "";
  const fonts = availableFonts.filter((font) => !needle || font.family.toLowerCase().includes(needle));
  if (!fonts.length) {
    options.innerHTML = '<div class="list-empty">No matching fonts.</div>';
    return;
  }
  for (const font of fonts.slice(0, 150)) {
    installFontFace(font);
    const option = document.createElement("button");
    option.type = "button";
    option.className = `font-option${font.family === selected ? " active" : ""}`;
    option.style.fontFamily = `"${font.family}", sans-serif`;
    option.innerHTML = `<span>${escapeHtml(font.family)}</span><small>${escapeHtml(font.source || "system")}</small>`;
    option.addEventListener("click", () => {
      const inputId = kind === "arabic" ? "arabic-font" : "translation-font";
      const labelId = kind === "arabic" ? "arabic-font-label" : "translation-font-label";
      $(inputId).value = font.family;
      $(labelId).textContent = font.family;
      $(`${kind}-font-menu`).classList.add("hidden");
      syncSettingsFromControls();
      updateStageGeometry();
    });
    options.appendChild(option);
  }
}

async function loadFonts() {
  try {
    const result = await api("/api/fonts");
    availableFonts = (result.fonts || result || []).sort((a, b) => a.family.localeCompare(b.family));
    // Every bundled or imported face is registered up front, not just the ones
    // the picker happens to list: the canvas silently substitutes a default
    // face for a family the document never loaded.
    for (const font of availableFonts) installFontFace(font);
    renderFontOptions("arabic");
    renderFontOptions("translation");
    paintStage();
  } catch (error) {
    setStatus(`Fonts could not be listed: ${error.message}`, true);
  }
}

async function uploadFont(file) {
  if (!file) return;
  setStatus(`Importing ${file.name}…`);
  try {
    const result = await api("/api/font-upload", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name },
      body: file,
    });
    availableFonts = [...availableFonts.filter((font) => font.family !== result.family), result];
    renderFontOptions("arabic");
    renderFontOptions("translation");
    const inputId = selectedLayer === "arabic" ? "arabic-font" : "translation-font";
    const labelId = selectedLayer === "arabic" ? "arabic-font-label" : "translation-font-label";
    $(inputId).value = result.family;
    $(labelId).textContent = result.family;
    syncSettingsFromControls();
    updateStageGeometry();
    setStatus(`${result.family} is ready to use.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function showTool(tool) {
  document.querySelectorAll(".select-menu").forEach((menu) => menu.classList.add("hidden"));
  document.querySelectorAll(".select-trigger").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
  document.querySelectorAll("[data-tool]").forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll(".inspector-section").forEach((section) => section.classList.toggle("hidden", section.id !== `tool-${tool}`));
}

function undo() {
  const previous = history.pop();
  if (!previous) return;
  redoHistory.push(projectSnapshot());
  state.project = JSON.parse(previous);
  renderState({ ...state, project: state.project });
  updateHistoryButtons();
}

function redo() {
  const next = redoHistory.pop();
  if (!next) return;
  history.push(projectSnapshot());
  state.project = JSON.parse(next);
  renderState({ ...state, project: state.project });
  updateHistoryButtons();
}

function toggleTheme() {
  const dark = document.body.classList.toggle("theme-dark");
  localStorage.setItem("transcribe-quran-theme", dark ? "dark" : "light");
  icon($("theme-toggle"), dark ? "i-moon" : "i-sun");
  $("theme-toggle").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  $("theme-toggle").dataset.tooltip = dark ? "Switch to light theme" : "Switch to dark theme";
}

function openShortcuts() {
  if (shortcutsDialog?.showModal) shortcutsDialog.showModal();
}

function closeShortcuts() {
  if (shortcutsDialog?.open) shortcutsDialog.close();
}

function startCaptionEditHistory() {
  if (captionEditBefore === null) captionEditBefore = projectSnapshot();
}

function previewCaptionEdit() {
  renderTimeline();
  updateStageGeometry();
  renderCaption();
  updatePlayer();
}

function nudgeCaption(delta) {
  const entry = selectedCaptionEntry();
  if (!entry) return;
  const before = projectSnapshot();
  if (!state.project.captionEdits) state.project.captionEdits = {};
  const edit = { ...(state.project.captionEdits[entry.id] || {}) };
  const duration = Number(state.alignment?.durationSeconds || video.duration || 0);
  const originalStart = Number(edit.start ?? entry.base.start);
  const originalEnd = Number(edit.end ?? entry.base.end);
  const length = Math.max(0.01, originalEnd - originalStart);
  const start = Math.max(0, Math.min(Math.max(0, duration - length), originalStart + delta));
  edit.start = start;
  edit.end = Math.min(duration, start + length);
  state.project.captionEdits[entry.id] = edit;
  previewCaptionEdit();
  updateCaptionEditor();
  recordHistory(before);
}

function toggleCaptionHidden() {
  const entry = selectedCaptionEntry();
  if (!entry) return;
  const before = projectSnapshot();
  if (!state.project.captionEdits) state.project.captionEdits = {};
  const edit = { ...(state.project.captionEdits[entry.id] || {}) };
  edit.hidden = !edit.hidden;
  state.project.captionEdits[entry.id] = edit;
  previewCaptionEdit();
  updateCaptionEditor();
  recordHistory(before);
}

function deleteSelectedCaption() {
  const entry = selectedCaptionEntry();
  if (!entry || captionEditFor(entry.index)?.hidden) return false;
  const before = projectSnapshot();
  if (!state.project.captionEdits) state.project.captionEdits = {};
  state.project.captionEdits[entry.id] = {
    ...(state.project.captionEdits[entry.id] || {}),
    hidden: true,
  };
  previewCaptionEdit();
  updateCaptionEditor();
  recordHistory(before);
  setStatus("Caption deleted. Use Restore caption or Undo to bring it back.");
  return true;
}

function resetCaptionEdit() {
  const entry = selectedCaptionEntry();
  if (!entry || !state.project.captionEdits?.[entry.id]) return;
  const before = projectSnapshot();
  delete state.project.captionEdits[entry.id];
  previewCaptionEdit();
  updateCaptionEditor();
  recordHistory(before);
}

function closeCaptionEditor() {
  commitCaptionEdit();
  selectedCaptionIndex = null;
  updateCaptionEditor();
  renderTimeline();
}

video.addEventListener("loadedmetadata", () => {
  playButton.disabled = false;
  timeline.disabled = false;
  updateStageGeometry();
  updatePlayer();
});
video.addEventListener("seeked", paintStage);
video.addEventListener("loadeddata", paintStage);
video.addEventListener("timeupdate", updatePlayer);
video.addEventListener("play", () => { updatePlayer(); startCaptionPreviewAnimation(); });
video.addEventListener("pause", () => { stopCaptionPreviewAnimation(); updatePlayer(); });
video.addEventListener("ended", () => { stopCaptionPreviewAnimation(); updatePlayer(); });
playButton.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
timeline.addEventListener("input", () => {
  const duration = Number(video.duration) || Number(timeline.max) || 0;
  const next = Math.max(0, Math.min(duration, Number(timeline.value) || 0));
  timeline.value = String(next);
  video.currentTime = next;
  syncScrubber();
  updatePlayer();
});
$("speed-select").addEventListener("change", (event) => { video.playbackRate = Number(event.target.value); });

stageCanvas.addEventListener("pointerdown", onStagePointerDown);
stageCanvas.addEventListener("pointermove", onStagePointerMove);
document.addEventListener("pointermove", moveDrag);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointermove", moveTimingDrag);
document.addEventListener("pointerup", endTimingDrag);
window.addEventListener("resize", updateStageGeometry);

document.querySelectorAll("[data-select-layer]").forEach((button) => button.addEventListener("click", () => {
  selectedLayer = button.dataset.selectLayer;
  updateLayerSelection();
  showTool("layout");
}));
$("reset-layout").addEventListener("click", resetLayout);
$("apply-layer-position").addEventListener("click", applyLayerPosition);
for (const id of ["layer-opacity", "layer-rotation", "layer-outline", "layer-shadow", "layer-outline-color", "layer-shadow-color", "layer-outline-enabled", "layer-shadow-enabled", "layer-outline-opacity", "layer-shadow-opacity", "layer-animation-in", "layer-animation-out", "layer-animation-in-duration", "layer-animation-out-duration"]) {
  $(id).addEventListener("input", () => {
    const visual = visualFor(currentLayer());
    visual.opacity = Number($("layer-opacity").value) / 100;
    visual.rotation = Number($("layer-rotation").value) || 0;
    visual.outlineWidth = Math.max(0, Number($("layer-outline").value) || 0);
    visual.shadowDistance = Math.max(0, Number($("layer-shadow").value) || 0);
    visual.outlineColor = $("layer-outline-color").value;
    visual.shadowColor = $("layer-shadow-color").value;
    visual.outlineEnabled = $("layer-outline-enabled").checked;
    visual.shadowEnabled = $("layer-shadow-enabled").checked;
    visual.outlineOpacity = Number($("layer-outline-opacity").value) / 100;
    visual.shadowOpacity = Number($("layer-shadow-opacity").value) / 100;
    visual.animationIn = {
      preset: $("layer-animation-in").value,
      duration: Math.min(5000, Math.max(0, Number($("layer-animation-in-duration").value) || 0)),
    };
    visual.animationOut = {
      preset: $("layer-animation-out").value,
      duration: Math.min(5000, Math.max(0, Number($("layer-animation-out-duration").value) || 0)),
    };
    $("layer-outline-opacity-value").textContent = `${$("layer-outline-opacity").value}%`;
    $("layer-shadow-opacity-value").textContent = `${$("layer-shadow-opacity").value}%`;
    updateStageGeometry();
    renderCaption();
  });
}
$("timeline-zoom").addEventListener("click", () => {
  changeTimelineZoom(0);
});
$("caption-close").addEventListener("click", closeCaptionEditor);
$("caption-shift-back").addEventListener("click", () => nudgeCaption(-0.05));
$("caption-shift-forward").addEventListener("click", () => nudgeCaption(0.05));
$("caption-hide").addEventListener("click", toggleCaptionHidden);
$("caption-reset").addEventListener("click", resetCaptionEdit);
for (const [id, field] of [["caption-arabic", "arabic"], ["caption-translation", "wordTranslation"], ["caption-start", "start"], ["caption-end", "end"]]) {
  const input = $(id);
  input.addEventListener("focus", startCaptionEditHistory);
  input.addEventListener("input", () => {
    updateLocalCaptionEdit(field, input.value);
    previewCaptionEdit();
  });
  input.addEventListener("change", () => commitCaptionEdit());
}
$("choose-button").addEventListener("click", () => videoInput.click());
$("drop-choose-button").addEventListener("click", () => videoInput.click());
videoInput.addEventListener("change", () => uploadVideo(videoInput.files?.[0]));
$("load-project").addEventListener("click", () => projectInput.click());
projectInput.addEventListener("change", () => loadProject(projectInput.files?.[0]));
$("save-project").addEventListener("click", saveProject);
$("add-text").addEventListener("click", addTextOverlay);
$("add-image").addEventListener("click", () => imageInput.click());
$("add-surah").addEventListener("click", addSurahOverlay);
imageInput.addEventListener("change", () => uploadImage(imageInput.files?.[0]));
$("delete-overlay").addEventListener("click", deleteSelectedOverlay);
transcribeButton.addEventListener("click", transcribe);
exportSubtitles.addEventListener("click", () => exportOutput(false));
exportVideo.addEventListener("click", renderVideoLocally);
exportPrimary.addEventListener("click", renderVideoLocally);
$("render-cancel").addEventListener("click", () => exportJob?.abort());
downloadVideo.addEventListener("click", () => {
  if (lastRender) {
    downloadBlob(lastRender.blob, lastRender.name);
    return;
  }
  if (!state.outputs?.video) return;
  const link = document.createElement("a");
  link.href = state.outputs.video;
  link.download = "";
  link.click();
});

$("export-menu-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("export-menu");
  const open = menu.classList.toggle("hidden") === false;
  $("export-menu-button").setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("[role=menuitem]:not(:disabled)")?.focus();
});
$("export-menu-button").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("export-menu-button").click();
  } else if (event.key === "Escape") {
    $("export-menu").classList.add("hidden");
    $("export-menu-button").setAttribute("aria-expanded", "false");
  }
});
$("export-menu").addEventListener("keydown", (event) => {
  const items = [...$("export-menu").querySelectorAll("[role=menuitem]:not(:disabled)")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" && items.length) {
    event.preventDefault();
    items[(index + 1) % items.length].focus();
  } else if (event.key === "ArrowUp" && items.length) {
    event.preventDefault();
    items[(index - 1 + items.length) % items.length].focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    $("export-menu").classList.add("hidden");
    $("export-menu-button").setAttribute("aria-expanded", "false");
    $("export-menu-button").focus();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#export-menu") && !event.target.closest("#export-menu-button")) {
    $("export-menu").classList.add("hidden");
    $("export-menu-button").setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".font-picker")) document.querySelectorAll(".font-menu").forEach((menu) => menu.classList.add("hidden"));
  if (!event.target.closest(".select-shell")) {
    document.querySelectorAll(".select-menu").forEach((menu) => menu.classList.add("hidden"));
    document.querySelectorAll(".select-trigger").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
  }
});

for (const kind of ["arabic", "translation"]) {
  const trigger = $(`${kind}-font-trigger`);
  const menu = $(`${kind}-font-menu`);
  const search = $(`${kind}-font-search`);
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll(".font-menu").forEach((other) => { if (other !== menu) other.classList.add("hidden"); });
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) { renderFontOptions(kind, search.value); search.focus(); }
  });
  search.addEventListener("input", () => renderFontOptions(kind, search.value));
}
$("font-import-button").addEventListener("click", () => fontInput.click());
fontInput.addEventListener("change", () => uploadFont(fontInput.files?.[0]));

document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => showTool(button.dataset.tool)));
$("undo-button").addEventListener("click", undo);
$("redo-button").addEventListener("click", redo);
$("theme-toggle").addEventListener("click", toggleTheme);
$("shortcuts-button").addEventListener("click", openShortcuts);
$("shortcuts-close").addEventListener("click", closeShortcuts);
shortcutsDialog?.addEventListener("click", (event) => {
  if (event.target === shortcutsDialog) closeShortcuts();
});

for (const id of ["translation", "words", "arabic-font", "translation-font", "arabic-size", "translation-size", "caption-gap", "arabic-color", "translation-color", "speech-pause", "offline", "model", "dtype", "confidence"]) {
  $(id).addEventListener("input", () => { syncSettingsFromControls(); updateStageGeometry(); });
  $(id).addEventListener("change", () => { syncSettingsFromControls(); updateStageGeometry(); });
}

for (const id of ["overlay-text", "overlay-font", "overlay-size", "overlay-start", "overlay-end", "overlay-opacity", "overlay-rotation", "overlay-outline", "overlay-shadow", "overlay-outline-color", "overlay-shadow-color", "overlay-outline-enabled", "overlay-shadow-enabled", "overlay-outline-opacity", "overlay-shadow-opacity", "overlay-animation-in", "overlay-animation-out", "overlay-animation-duration", "overlay-lock", "overlay-visible"]) {
  $(id).addEventListener("input", () => {
    const overlay = selectedOverlay();
    if (!overlay) return;
    if (id === "overlay-text") overlay.text = $(id).value;
    if (id === "overlay-font") overlay.fontName = $(id).value.trim() || "Arial";
    if (id === "overlay-size") overlay.fontSize = Math.max(1, Number($(id).value) || 72);
    if (id === "overlay-start") overlay.start = Math.max(0, Number($(id).value) || 0);
    if (id === "overlay-end") overlay.end = Math.max(0.01, Number($(id).value) || 0.01);
    if (id === "overlay-lock") overlay.locked = $(id).checked;
    if (id === "overlay-visible") overlay.visible = $(id).checked;
    const visual = visualFor(overlay);
    if (id === "overlay-opacity") visual.opacity = Number($(id).value) / 100;
    if (id === "overlay-rotation") visual.rotation = Number($(id).value) || 0;
    if (id === "overlay-outline") visual.outlineWidth = Math.max(0, Number($(id).value) || 0);
    if (id === "overlay-shadow") visual.shadowDistance = Math.max(0, Number($(id).value) || 0);
    if (id === "overlay-outline-color") visual.outlineColor = $(id).value;
    if (id === "overlay-shadow-color") visual.shadowColor = $(id).value;
    if (id === "overlay-outline-enabled") visual.outlineEnabled = $(id).checked;
    if (id === "overlay-shadow-enabled") visual.shadowEnabled = $(id).checked;
    if (id === "overlay-outline-opacity") visual.outlineOpacity = Number($(id).value) / 100;
    if (id === "overlay-shadow-opacity") visual.shadowOpacity = Number($(id).value) / 100;
    $("overlay-outline-opacity-value").textContent = `${$("overlay-outline-opacity").value}%`;
    $("overlay-shadow-opacity-value").textContent = `${$("overlay-shadow-opacity").value}%`;
    const duration = Math.max(0, Number($("overlay-animation-duration").value) || 0);
    if (id === "overlay-animation-in" || id === "overlay-animation-duration") visual.animationIn = { preset: $("overlay-animation-in").value, duration };
    if (id === "overlay-animation-out" || id === "overlay-animation-duration") visual.animationOut = { preset: $("overlay-animation-out").value, duration };
    renderOverlays();
  });
}

document.body.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (dropZone.contains(event.target)) dropZone.classList.add("dragging");
});
document.body.addEventListener("dragleave", (event) => {
  if (dropZone.contains(event.target)) dropZone.classList.remove("dragging");
});
document.body.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadVideo(file);
});

function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea" || target?.isContentEditable;
}

function togglePlayback() {
  if (!state.hasVideo) return;
  if (video.paused) void video.play(); else video.pause();
}

function seekBy(delta) {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration, (video.currentTime || 0) + delta));
  updatePlayer();
}

function selectAdjacentCaption(direction) {
  const entries = captionEntries();
  if (!entries.length) return;
  const current = entries.findIndex((entry) => entry.index === selectedCaptionIndex);
  const next = current < 0
    ? (direction > 0 ? entries[0] : entries.at(-1))
    : entries[Math.max(0, Math.min(entries.length - 1, current + direction))];
  if (next) selectCaption(next.index);
}

function changeTimelineZoom(direction) {
  const levels = [1, 2, 4];
  const current = Math.max(0, levels.indexOf(timelineZoom));
  const next = direction === 0 ? (current + 1) % levels.length : Math.max(0, Math.min(levels.length - 1, current + direction));
  timelineZoom = levels[next];
  const zoomLabel = `${timelineZoom}×`;
  $("timeline-zoom-label").textContent = zoomLabel;
  $("timeline-zoom").setAttribute("aria-label", `Timeline zoom ${zoomLabel}`);
  $("timeline-zoom").dataset.tooltip = `Timeline zoom ${zoomLabel}`;
  renderTimeline();
}

function nudgeSelection(key, step) {
  const before = projectSnapshot();
  const overlay = selectedOverlay();
  if (overlay) {
    if (overlay.locked) return;
    if (key === "ArrowUp") overlay.position.y = Math.max(0, overlay.position.y - step / DESIGN_HEIGHT);
    if (key === "ArrowDown") overlay.position.y = Math.min(1, overlay.position.y + step / DESIGN_HEIGHT);
    if (key === "ArrowLeft") overlay.position.x = Math.max(0, overlay.position.x - step / DESIGN_WIDTH);
    if (key === "ArrowRight") overlay.position.x = Math.min(1, overlay.position.x + step / DESIGN_WIDTH);
    syncOverlayControls();
  } else {
    const layer = currentLayer();
    if (key === "ArrowUp") layer.position.y -= step;
    if (key === "ArrowDown") layer.position.y += step;
    if (key === "ArrowLeft") layer.position.x -= step;
    if (key === "ArrowRight") layer.position.x += step;
    layer.position.x = Math.max(0, Math.min(DESIGN_WIDTH, layer.position.x));
    layer.position.y = Math.max(0, Math.min(DESIGN_HEIGHT, layer.position.y));
    updateLayerSelection();
  }
  updateStageGeometry();
  recordHistory(before);
}

document.addEventListener("keydown", (event) => {
  const key = event.key;
  const lowerKey = key.toLowerCase();
  const modifier = event.metaKey || event.ctrlKey;
  const typing = isTypingTarget(event.target);

  if (modifier && lowerKey === "z") {
    event.preventDefault();
    commitCaptionEdit();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (modifier && lowerKey === "y") {
    event.preventDefault();
    commitCaptionEdit();
    redo();
    return;
  }
  if (modifier && lowerKey === "s") {
    event.preventDefault();
    saveProject();
    return;
  }
  if (modifier && event.shiftKey && lowerKey === "o") {
    event.preventDefault();
    projectInput.click();
    return;
  }
  if (modifier && lowerKey === "o") {
    event.preventDefault();
    videoInput.click();
    return;
  }
  if (modifier && key === "Enter") {
    event.preventDefault();
    if (!transcribeButton.disabled) void transcribe();
    return;
  }
  if (modifier && lowerKey === "e") {
    event.preventDefault();
    if (!state.hasAlignment) return;
    if (event.shiftKey) void renderVideoLocally();
    else void exportOutput(false);
    return;
  }
  if (key === "Escape") {
    if (shortcutsDialog?.open) {
      closeShortcuts();
      event.preventDefault();
      return;
    }
    if (typing) {
      event.target.blur?.();
      commitCaptionEdit();
      return;
    }
    if (selectedOverlayId) {
      selectedOverlayId = null;
      renderOverlays();
    }
    if (selectedCaptionIndex !== null) closeCaptionEditor();
    document.querySelectorAll(".font-menu").forEach((menu) => menu.classList.add("hidden"));
    document.querySelectorAll(".select-menu").forEach((menu) => menu.classList.add("hidden"));
    $("export-menu").classList.add("hidden");
    return;
  }
  if (typing) return;
  if (key === "?") {
    event.preventDefault();
    openShortcuts();
    return;
  }
  if (key === "t" || key === "T") {
    event.preventDefault();
    addTextOverlay();
    return;
  }
  if (key === "i" || key === "I") {
    event.preventDefault();
    showTool("overlays");
    imageInput.click();
    return;
  }
  if (key === "r" || key === "R") {
    event.preventDefault();
    resetLayout();
    return;
  }
  if (key === "+" || key === "=") {
    event.preventDefault();
    changeTimelineZoom(1);
    return;
  }
  if (key === "-") {
    event.preventDefault();
    changeTimelineZoom(-1);
    return;
  }
  if (key === "Delete" || key === "Backspace") {
    if (event.repeat) return;
    if (deleteSelectedOverlay() || deleteSelectedCaption()) event.preventDefault();
    return;
  }
  if (key === " ") {
    event.preventDefault();
    togglePlayback();
    return;
  }
  if (key === "k" || key === "K") {
    event.preventDefault();
    togglePlayback();
    return;
  }
  if (key === "j" || key === "J") {
    event.preventDefault();
    seekBy(-5);
    return;
  }
  if (key === "l" || key === "L") {
    event.preventDefault();
    seekBy(5);
    return;
  }
  if (key === "Home") {
    event.preventDefault();
    seekBy(-(video.currentTime || 0));
    return;
  }
  if (key === "End") {
    event.preventDefault();
    if (Number.isFinite(video.duration)) seekBy(video.duration - (video.currentTime || 0));
    return;
  }
  if (key === "[" || key === "]") {
    event.preventDefault();
    selectAdjacentCaption(key === "]" ? 1 : -1);
    return;
  }
  if (["1", "2", "3", "4"].includes(key)) {
    event.preventDefault();
    showTool(["captions", "layout", "overlays", "engine"][Number(key) - 1]);
    return;
  }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
  event.preventDefault();
  nudgeSelection(key, event.shiftKey ? 10 : 1);
});

enhanceRanges();
enhanceSelects();
updateLayerSelection();
showTool("captions");
icon(playButton, "i-play");
const prefersDarkTheme = localStorage.getItem("transcribe-quran-theme") === "dark";
if (prefersDarkTheme) document.body.classList.add("theme-dark");
icon($("theme-toggle"), prefersDarkTheme ? "i-moon" : "i-sun");
$("theme-toggle").setAttribute("aria-label", prefersDarkTheme ? "Switch to light theme" : "Switch to dark theme");
$("theme-toggle").dataset.tooltip = prefersDarkTheme ? "Switch to light theme" : "Switch to dark theme";
updateHistoryButtons();
loadFonts();
loadSurahs();
refresh();
