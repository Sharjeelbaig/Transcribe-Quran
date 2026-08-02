import { findActiveCaptionIndex } from "./caption-timing.js";

const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 1920;

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");
const overlayStage = $("overlay-stage");
const status = $("status");
const dropZone = $("drop-zone");
const stageWrap = $("stage-wrap");
const timeline = $("timeline");
const playButton = $("play-button");
const timeLabel = $("time-label");
const transcribeButton = $("transcribe-button");
const exportSubtitles = $("export-subtitles");
const exportVideo = $("export-video");
const downloadLinks = $("download-links");
const videoInput = $("video-input");
const projectInput = $("project-input");
const imageInput = $("image-input");
const fontInput = $("font-input");
const arabicLayer = $("arabic-layer");
const translationLayer = $("translation-layer");
const captionTrack = $("caption-track");
const timelineSummary = $("timeline-summary");
const toast = $("toast");
const captionEditor = $("caption-editor");

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
      confidenceThreshold: 0.5,
      model: "Sharjeelbaig/whisper-tiny-ar-quran-onnx",
      dtype: "q8",
      offline: false
    },
    layout: {
      arabic: { position: { x: 540, y: 894 }, fontSize: 310 },
      translation: { position: { x: 540, y: 1135 }, fontSize: 92 }
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

function icon(button, symbol) {
  if (button) button.innerHTML = `<svg><use href="#${symbol}"/></svg>`;
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
  return {
    ...word,
    ...(edit?.arabic !== undefined ? { arabic: edit.arabic } : {}),
    ...(edit?.wordTranslation !== undefined ? { wordTranslation: edit.wordTranslation } : {}),
    ...(edit?.start !== undefined ? { start: edit.start } : {}),
    ...(edit?.end !== undefined ? { end: edit.end } : {}),
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
  $("caption-hide").textContent = edit?.hidden ? "Restore caption" : "Hide caption";
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
  selectedCaptionIndex = index;
  const entry = selectedCaptionEntry();
  if (seek && entry && Number.isFinite(entry.word.start)) {
    video.currentTime = entry.word.start;
    updatePlayer();
  }
  updateCaptionEditor();
  renderTimeline();
  showTool("captions");
}

function syncControlsFromProject() {
  const settings = state.project.settings;
  $("translation").value = settings.translation;
  $("words").value = settings.wordsPerCaption;
  $("arabic-font").value = settings.arabicFontName;
  $("translation-font").value = settings.translationFontName;
  $("arabic-size").value = settings.arabicFontSize;
  $("translation-size").value = settings.translationFontSize;
  $("caption-gap").value = settings.captionGap;
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
  });
  $("layer-x").value = Math.round(state.project.layout[selectedLayer].position.x);
  $("layer-y").value = Math.round(state.project.layout[selectedLayer].position.y);
  arabicLayer.classList.toggle("selected", selectedLayer === "arabic");
  translationLayer.classList.toggle("selected", selectedLayer === "translation");
}

function updateStageGeometry() {
  if (!stage.clientHeight) return;
  for (const [name, element] of [["arabic", arabicLayer], ["translation", translationLayer]]) {
    const layer = state.project.layout[name];
    element.style.left = `${(layer.position.x / DESIGN_WIDTH) * 100}%`;
    element.style.top = `${(layer.position.y / DESIGN_HEIGHT) * 100}%`;
    element.style.fontSize = `${Math.max(8, layer.fontSize * stage.clientHeight / DESIGN_HEIGHT)}px`;
    element.style.fontFamily = name === "arabic" ? `"${state.project.settings.arabicFontName}", serif` : `"${state.project.settings.translationFontName}", sans-serif`;
  }
  for (const overlay of state.project.overlays || []) {
    const element = document.querySelector(`[data-overlay-id="${CSS.escape(overlay.id)}"]`);
    if (!element) continue;
    element.style.left = `${overlay.position.x * 100}%`;
    element.style.top = `${overlay.position.y * 100}%`;
    element.style.width = `${overlay.width * 100}%`;
    element.style.height = `${overlay.height * 100}%`;
    if (overlay.fontSize) element.style.fontSize = `${Math.max(8, overlay.fontSize * stage.clientHeight / DESIGN_HEIGHT)}px`;
  }
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
    return;
  }
  dropZone.classList.add("hidden");
  stageWrap.classList.remove("hidden");
  transcribeButton.disabled = state.job.status === "running";
  exportSubtitles.disabled = !state.hasAlignment;
  exportVideo.disabled = !state.hasAlignment;
  if (state.project.videoPath && loadedVideoKey !== state.project.videoPath) {
    loadedVideoKey = state.project.videoPath;
    video.src = `/api/video?source=${encodeURIComponent(loadedVideoKey)}&t=${Date.now()}`;
    video.load();
  }
}

function renderCaption() {
  const entries = captionEntries();
  const words = entries.map((entry) => entry.word);
  const now = video.currentTime || 0;
  const index = findActiveCaptionIndex(words, now);
  if (!words.length || index < 0) {
    activeCaption = null;
    arabicLayer.classList.add("hidden");
    translationLayer.classList.add("hidden");
    return;
  }
  const current = words[index];
  const count = Math.max(1, Number(state.project.settings.wordsPerCaption) || 1);
  const groupStart = Math.floor((Math.max(1, current.position) - 1) / count) * count + 1;
  const groupEnd = groupStart + count - 1;
  const group = words.filter((word) => word.verseKey === current.verseKey && word.position >= groupStart && word.position <= groupEnd);
  activeCaption = { current, group };
  arabicLayer.classList.remove("hidden");
  translationLayer.classList.remove("hidden");
  const ordered = group.slice().sort((left, right) => right.position - left.position);
  arabicLayer.querySelector(".caption-content").innerHTML = `<span class="arabic-line">${ordered.map((word) => `<span class="arabic-word${word.position === current.position ? " active" : ""}">${escapeHtml(word.arabic)}</span>`).join("")}</span>`;
  translationLayer.querySelector(".caption-content").textContent = `${current.wordTranslation}  •  ${current.verseKey}`;
  updateStageGeometry();
}

function updatePlayer() {
  if (!Number.isFinite(video.duration)) return;
  timeline.max = String(video.duration);
  timeline.value = String(video.currentTime || 0);
  timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  icon(playButton, video.paused ? "i-play" : "i-pause");
  document.querySelectorAll(".timeline-word").forEach((element) => {
    const index = Number(element.dataset.index);
    const word = effectiveWord(index);
    element.classList.toggle("active", Boolean(word && video.currentTime >= word.start && video.currentTime <= word.end));
    element.classList.toggle("selected", selectedCaptionIndex === index);
  });
  renderCaption();
}

function renderTimeline() {
  if (!captionTrack) return;
  captionTrack.style.width = `${timelineZoom * 100}%`;
  captionTrack.innerHTML = "";
  const entries = captionEntries();
  const words = entries.map((entry) => entry.word);
  const duration = Number(state.alignment?.durationSeconds || video.duration || 0);
  if (!words.length || !duration) {
    captionTrack.innerHTML = '<div class="track-empty">Caption events will appear here.</div>';
    timelineSummary.textContent = "Transcribe a video to see ayahs and words.";
    return;
  }
  const fragment = document.createDocumentFragment();
  const ayahs = new Set(words.map((word) => word.verseKey));
  timelineSummary.textContent = `${words.length} matched words · ${ayahs.size} ayahs`;
  entries.forEach((entry) => {
    const word = entry.word;
    const event = document.createElement("button");
    event.className = "timeline-word";
    event.type = "button";
    event.dataset.index = String(entry.index);
    event.title = `${word.verseKey} · ${word.arabic}`;
    event.style.left = `${Math.max(0, word.start / duration) * 100}%`;
    event.style.width = `${Math.max(.25, (word.end - word.start) / duration * 100)}%`;
    event.innerHTML = '<span class="timeline-handle timeline-handle-start" aria-hidden="true"></span><span class="timeline-handle timeline-handle-end" aria-hidden="true"></span>';
    event.querySelector(".timeline-handle-start").addEventListener("pointerdown", (pointerEvent) => beginTimingDrag(pointerEvent, entry.index, "start"));
    event.querySelector(".timeline-handle-end").addEventListener("pointerdown", (pointerEvent) => beginTimingDrag(pointerEvent, entry.index, "end"));
    event.addEventListener("click", () => {
      selectCaption(entry.index);
    });
    fragment.appendChild(event);
  });
  captionTrack.appendChild(fragment);
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
  const root = $("custom-overlays");
  root.innerHTML = "";
  for (const overlay of state.project.overlays || []) {
    if (!overlay.visible) continue;
    const element = document.createElement("div");
    element.className = "custom-overlay";
    if (overlay.id === selectedOverlayId) element.classList.add("selected");
    element.dataset.overlayId = overlay.id;
    if (overlay.type === "text") {
      element.textContent = overlay.text || "Text overlay";
    } else if (overlay.source) {
      const image = document.createElement("img");
      image.src = overlay.source;
      image.alt = "Image overlay";
      image.draggable = false;
      element.appendChild(image);
    }
    if (overlay.color) element.style.color = overlay.color;
    element.addEventListener("pointerdown", (event) => {
      selectedOverlayId = overlay.id;
      syncOverlayControls();
      renderOverlays();
      beginOverlayDrag(event, overlay, element);
    });
    root.appendChild(element);
  }
  updateStageGeometry();
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
    row.innerHTML = `<span>${escapeHtml(overlay.type === "text" ? overlay.text || "Text overlay" : "Image overlay")}</span><span>${overlay.type}</span>`;
    row.addEventListener("click", () => {
      selectedOverlayId = overlay.id;
      renderOverlays();
    });
    list.appendChild(row);
  }
}

function selectedOverlay() {
  return (state.project.overlays || []).find((overlay) => overlay.id === selectedOverlayId);
}

function syncOverlayControls() {
  const overlay = selectedOverlay();
  $("overlay-editor").classList.toggle("hidden", !overlay || overlay.type !== "text");
  if (!overlay || overlay.type !== "text") return;
  $("overlay-text").value = overlay.text || "";
  $("overlay-font").value = overlay.fontName || "Arial";
  $("overlay-size").value = overlay.fontSize || 72;
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
  $("alignment-badge").textContent = state.hasAlignment ? "Ready" : state.job.status === "running" ? "Working…" : "Not transcribed";
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
  setStatus(burnVideo ? "Rendering the edited video with FFmpeg…" : "Generating edited ASS subtitles…");
  try {
    const result = await api("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.project, burnVideo }) });
    renderState(result);
    setStatus(burnVideo ? "Rendered video is ready." : "ASS subtitles are ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function beginLayerDrag(event, layerName, element) {
  if (event.target.closest(".resize-handle")) return;
  event.preventDefault();
  selectedLayer = layerName;
  updateLayerSelection();
  const rect = overlayStage.getBoundingClientRect();
  const layer = state.project.layout[layerName];
  drag = { kind: "move", layerName, startX: event.clientX, startY: event.clientY, startPosition: { ...layer.position }, rect, element, before: projectSnapshot() };
  element.setPointerCapture?.(event.pointerId);
}

function beginLayerResize(event, layerName, element) {
  event.preventDefault();
  event.stopPropagation();
  selectedLayer = layerName;
  updateLayerSelection();
  drag = { kind: "resize", layerName, startX: event.clientX, startY: event.clientY, startSize: state.project.layout[layerName].fontSize, rect: overlayStage.getBoundingClientRect(), element, before: projectSnapshot() };
  element.setPointerCapture?.(event.pointerId);
}

function beginOverlayDrag(event, overlay, element) {
  event.preventDefault();
  const rect = overlayStage.getBoundingClientRect();
  drag = { kind: "overlay", overlay, startX: event.clientX, startY: event.clientY, startPosition: { ...overlay.position }, rect, element, before: projectSnapshot() };
  element.setPointerCapture?.(event.pointerId);
}

function moveDrag(event) {
  if (!drag) return;
  const dx = ((event.clientX - drag.startX) / drag.rect.width) * DESIGN_WIDTH;
  const dy = ((event.clientY - drag.startY) / drag.rect.height) * DESIGN_HEIGHT;
  if (drag.kind === "resize") {
    const layer = state.project.layout[drag.layerName];
    layer.fontSize = Math.max(8, Math.round(drag.startSize + dy));
    if (drag.layerName === "arabic") $("arabic-size").value = layer.fontSize;
    else $("translation-size").value = layer.fontSize;
  } else if (drag.kind === "overlay") {
    drag.overlay.position.x = Math.min(1, Math.max(0, drag.startPosition.x + dx / DESIGN_WIDTH));
    drag.overlay.position.y = Math.min(1, Math.max(0, drag.startPosition.y + dy / DESIGN_HEIGHT));
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
    visible: true
  };
  state.project.overlays.push(overlay);
  selectedOverlayId = overlay.id;
  renderOverlays();
  recordHistory(before);
  showTool("overlays");
  $("overlay-text").focus();
  $("overlay-text").select();
  setStatus("Text overlay added. Edit it in the inspector or drag it in the preview.");
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
      visible: true
    };
    state.project.overlays.push(overlay);
    selectedOverlayId = overlay.id;
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
    renderFontOptions("arabic");
    renderFontOptions("translation");
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
  document.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
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
  const width = video.videoWidth || 16;
  const height = video.videoHeight || 9;
  stage.style.aspectRatio = `${width} / ${height}`;
  playButton.disabled = false;
  timeline.disabled = false;
  updateStageGeometry();
  updatePlayer();
});
video.addEventListener("timeupdate", updatePlayer);
video.addEventListener("play", updatePlayer);
video.addEventListener("pause", updatePlayer);
video.addEventListener("ended", updatePlayer);
playButton.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
timeline.addEventListener("input", () => { video.currentTime = Number(timeline.value); updatePlayer(); });
$("speed-select").addEventListener("change", (event) => { video.playbackRate = Number(event.target.value); });

for (const [name, element] of [["arabic", arabicLayer], ["translation", translationLayer]]) {
  element.addEventListener("pointerdown", (event) => beginLayerDrag(event, name, element));
  element.querySelector(".resize-handle").addEventListener("pointerdown", (event) => beginLayerResize(event, name, element));
}
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
$("timeline-zoom").addEventListener("click", () => {
  timelineZoom = timelineZoom === 1 ? 2 : timelineZoom === 2 ? 4 : 1;
  $("timeline-zoom").setAttribute("aria-label", `Timeline zoom ${timelineZoom}x`);
  $("timeline-zoom").dataset.tooltip = `Timeline zoom ${timelineZoom}x`;
  renderTimeline();
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
imageInput.addEventListener("change", () => uploadImage(imageInput.files?.[0]));
$("delete-overlay").addEventListener("click", () => {
  if (!selectedOverlayId) return;
  const before = projectSnapshot();
  state.project.overlays = state.project.overlays.filter((overlay) => overlay.id !== selectedOverlayId);
  selectedOverlayId = null;
  renderOverlays();
  recordHistory(before);
});
transcribeButton.addEventListener("click", transcribe);
exportSubtitles.addEventListener("click", () => exportOutput(false));
exportVideo.addEventListener("click", () => exportOutput(true));

$("export-menu-button").addEventListener("click", (event) => {
  event.stopPropagation();
  $("export-menu").classList.toggle("hidden");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#export-menu") && !event.target.closest("#export-menu-button")) $("export-menu").classList.add("hidden");
  if (!event.target.closest(".font-picker")) document.querySelectorAll(".font-menu").forEach((menu) => menu.classList.add("hidden"));
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

for (const id of ["translation", "words", "arabic-font", "translation-font", "arabic-size", "translation-size", "caption-gap", "offline", "model", "dtype", "confidence"]) {
  $(id).addEventListener("input", () => { syncSettingsFromControls(); updateStageGeometry(); });
  $(id).addEventListener("change", () => { syncSettingsFromControls(); updateStageGeometry(); });
}

for (const id of ["overlay-text", "overlay-font", "overlay-size"]) {
  $(id).addEventListener("input", () => {
    const overlay = selectedOverlay();
    if (!overlay) return;
    if (id === "overlay-text") overlay.text = $(id).value;
    if (id === "overlay-font") overlay.fontName = $(id).value.trim() || "Arial";
    if (id === "overlay-size") overlay.fontSize = Math.max(1, Number($(id).value) || 72);
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

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName?.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if ((tag === "input" || tag === "select" || tag === "textarea") && event.key !== "Escape") return;
  if (event.key === " ") { event.preventDefault(); video.paused ? video.play() : video.pause(); return; }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const before = projectSnapshot();
  const layer = currentLayer();
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowUp") layer.position.y -= step;
  if (event.key === "ArrowDown") layer.position.y += step;
  if (event.key === "ArrowLeft") layer.position.x -= step;
  if (event.key === "ArrowRight") layer.position.x += step;
  layer.position.x = Math.max(0, Math.min(DESIGN_WIDTH, layer.position.x));
  layer.position.y = Math.max(0, Math.min(DESIGN_HEIGHT, layer.position.y));
  updateLayerSelection();
  updateStageGeometry();
  recordHistory(before);
});

updateLayerSelection();
showTool("captions");
icon(playButton, "i-play");
icon($("theme-toggle"), localStorage.getItem("transcribe-quran-theme") === "dark" ? "i-moon" : "i-sun");
if (localStorage.getItem("transcribe-quran-theme") === "dark") document.body.classList.add("theme-dark");
updateHistoryButtons();
loadFonts();
refresh();
