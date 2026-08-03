import { ArrayBufferTarget, Muxer } from "./vendor/mp4-muxer.mjs";
import { buildScene, paintScene } from "./renderer.js";

// Rendering happens frame by frame on a canvas at the source video's own
// resolution, driven by the very renderer the editor paints with. The encoder
// only ever sees pixels the editor already agreed to, which is what makes the
// exported file match the preview instead of approximating it.

const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const AVC_CANDIDATES = ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0034", "avc1.42003e"];

export function exportSupport() {
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") {
    return { supported: false, reason: "This browser has no WebCodecs video encoder. Chrome, Edge or another Chromium browser can export." };
  }
  if (typeof HTMLVideoElement === "undefined") return { supported: false, reason: "Video playback is unavailable." };
  return { supported: true };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// A backgrounded tab has its timers clamped to about once a second, which would
// turn a render that yields between frames into an overnight job. A message
// channel round trip is a macrotask the throttler does not touch, so the loop
// keeps full speed while the user works in another tab.
const yieldChannel = typeof MessageChannel === "function" ? new MessageChannel() : undefined;
const yieldQueue = [];
if (yieldChannel) {
  yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
  yieldChannel.port1.start?.();
}

function yieldToTasks() {
  if (!yieldChannel) return wait(0);
  return new Promise((resolve) => {
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

function once(target, event, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for the video to ${event}.`));
    }, timeout);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The source video could not be read."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(event, onEvent);
    target.addEventListener("error", onError);
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
}

/** An off-screen copy of the source so exporting never disturbs the editor's
 * own playback position. */
function createSourceVideo(url) {
  const element = document.createElement("video");
  element.src = url;
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  element.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(element);
  return element;
}

function snapFrameRate(measured) {
  if (!Number.isFinite(measured) || measured <= 0) return 30;
  const closest = COMMON_FRAME_RATES.reduce(
    (best, rate) => (Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best),
    COMMON_FRAME_RATES[0],
  );
  return Math.abs(closest - measured) <= 1.5 ? closest : Math.min(120, Math.max(1, Math.round(measured)));
}

/** Samples a fraction of a second of playback to learn the source frame rate.
 * Containers do not expose it to script, and guessing 30 would resample a 25 or
 * 60 fps recitation into judder. */
async function detectFrameRate(element) {
  if (typeof element.requestVideoFrameCallback !== "function") return 30;
  try {
    element.currentTime = 0;
    await once(element, "seeked", { timeout: 10_000 });
    const samples = await new Promise((resolve) => {
      const times = [];
      const step = (_now, metadata) => {
        times.push(metadata.mediaTime);
        if (times.length >= 12) resolve(times);
        else element.requestVideoFrameCallback(step);
      };
      element.requestVideoFrameCallback(step);
      element.play().catch(() => resolve(times));
      setTimeout(() => resolve(times), 1500);
    });
    element.pause();
    if (samples.length < 3) return 30;
    const span = samples[samples.length - 1] - samples[0];
    if (!(span > 0)) return 30;
    return snapFrameRate((samples.length - 1) / span);
  } catch {
    return 30;
  }
}

async function seekTo(element, time) {
  // Assigning the position the element already holds fires no `seeked` event,
  // so waiting for one there would stall the whole render on a timeout.
  if (element.readyState >= 2 && Math.abs(element.currentTime - time) < 1e-6) return;
  const seeked = once(element, "seeked");
  element.currentTime = time;
  await seeked;
  // `seeked` can fire before the decoded frame is available to drawImage on a
  // cold seek, which would silently paint the previous frame into the export.
  if (element.readyState < 2) await once(element, "loadeddata");
}

function captureSupported(element) {
  return typeof MediaStreamTrackProcessor === "function" && typeof element.captureStream === "function";
}

/**
 * Walks the source by tapping the decoder through a capture stream. Each frame
 * arrives already decoded and stamped with its own media time, so no frame rate
 * has to be guessed and no frame is re-decoded — stepping with `currentTime`
 * instead costs a seek per frame, which dominates everything else in the loop.
 */
async function renderByCapture(element, totalSeconds, onFrame, signal) {
  const stream = element.captureStream();
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("The source video exposed no capturable picture track.");
  // The processor drops whatever overflows its buffer, so playback is held to
  // roughly the speed frames are consumed. Letting the decoder run free costs
  // frames, and a missing frame freezes the picture for its slot.
  const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 32 });
  const reader = processor.readable.getReader();
  element.playbackRate = 2;
  let rendered = 0;
  let lastTime = -1;
  try {
    await element.play();
    for (;;) {
      throwIfAborted(signal);
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      const time = frame.timestamp / 1_000_000;
      if (time > totalSeconds) {
        frame.close();
        break;
      }
      try {
        await onFrame(frame, time);
      } finally {
        frame.close();
      }
      rendered += 1;
      lastTime = time;
      const lag = element.currentTime - time;
      if (!element.paused && lag > 0.3) element.pause();
      else if (element.paused && lag < 0.1 && element.currentTime < totalSeconds && !element.ended) {
        await element.play().catch(() => {});
      }
      if (element.ended && element.currentTime - time < 0.05) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already torn down.
    }
    track.stop();
    element.pause();
  }
  return { rendered, lastTime };
}

/** Deterministic fallback for browsers without capture streams, and the pass
 * that fills any tail the capture stream ended before delivering. */
async function renderBySeeking(element, fromSeconds, totalSeconds, fps, onFrame, signal) {
  let rendered = 0;
  let lastTime = fromSeconds - 1 / fps;
  for (let time = Math.max(0, fromSeconds); time <= totalSeconds + 1e-6; time += 1 / fps) {
    throwIfAborted(signal);
    const clamped = Math.min(time, Math.max(0, totalSeconds - 1e-3));
    await seekTo(element, clamped);
    await onFrame(element, time);
    rendered += 1;
    lastTime = time;
  }
  return { rendered, lastTime };
}

async function pickVideoConfig(width, height, framerate, bitrate) {
  for (const codec of AVC_CANDIDATES) {
    const config = { codec, width, height, framerate, bitrate, avc: { format: "avc" } };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support?.supported) return config;
    } catch {
      // Try the next profile.
    }
  }
  throw new Error("No supported H.264 encoder configuration was found in this browser.");
}

/** Waits on the encoder's own `dequeue` event rather than polling a timer, for
 * the same throttling reason as `yieldToTasks`. The timer is only a safety net
 * for browsers that do not emit the event. */
async function drainEncoder(encoder, limit) {
  while (encoder.encodeQueueSize > limit) {
    await new Promise((resolve) => {
      const settle = () => {
        encoder.removeEventListener("dequeue", settle);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, 50);
      encoder.addEventListener("dequeue", settle);
    });
  }
}

const MAX_BUFFERED_SOURCE_BYTES = 800 * 1024 * 1024;

/**
 * Pulls the source into memory once and serves it from a blob URL. Stepping
 * frame by frame over an HTTP URL makes the browser issue a range request per
 * seek, which costs more than decoding and encoding the frame put together.
 */
async function loadSource(url, signal) {
  try {
    const head = await fetch(url, { method: "HEAD", ...(signal ? { signal } : {}) });
    const declared = Number(head.headers.get("content-length") || 0);
    if (declared > MAX_BUFFERED_SOURCE_BYTES) return { url, blob: undefined };
  } catch {
    // A server without HEAD support still deserves the buffered path.
  }
  try {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) return { url, blob: undefined };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BUFFERED_SOURCE_BYTES) return { url, blob: undefined };
    const blob = new Blob([bytes], { type: response.headers.get("content-type") || "video/mp4" });
    return { url: URL.createObjectURL(blob), blob, revoke: true };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { url, blob: undefined };
  }
}

async function decodeSourceAudio(source, signal) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || typeof AudioEncoder !== "function") return undefined;
  try {
    // decodeAudioData detaches the buffer it is given, so the copy handed to it
    // must not be the one backing the blob URL the video element is reading.
    const bytes = source.blob
      ? await source.blob.arrayBuffer()
      : await (await fetch(source.url, signal ? { signal } : undefined)).arrayBuffer();
    const context = new AudioContextClass();
    const buffer = await context.decodeAudioData(bytes);
    await context.close();
    return buffer;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // A silent or unreadable audio track is not a reason to fail the render.
    return undefined;
  }
}

/** Re-encodes the decoded PCM to AAC and hands it to the muxer. The picture is
 * rebuilt from scratch, so the audio has to be carried across separately. */
async function encodeAudio(buffer, muxer, signal, onProgress, maxSeconds) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  // The audio has to stop where the picture does, or the container reports a
  // duration the video track cannot fill.
  const totalFrames = Number.isFinite(maxSeconds) && maxSeconds > 0
    ? Math.min(buffer.length, Math.ceil(maxSeconds * sampleRate))
    : buffer.length;
  const chunkFrames = 4096;
  let failure;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate: 192_000 });
  const source = [];
  for (let channel = 0; channel < channels; channel += 1) source.push(buffer.getChannelData(channel));
  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    throwIfAborted(signal);
    if (failure) throw failure;
    const frames = Math.min(chunkFrames, totalFrames - offset);
    const planar = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      planar.set(source[channel].subarray(offset, offset + frames), channel * frames);
    }
    const data = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(data);
    data.close();
    await drainEncoder(encoder, 32);
    if (offset % (chunkFrames * 20) === 0) {
      onProgress?.(Math.min(1, offset / totalFrames));
      await yieldToTasks();
    }
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
}

/**
 * Renders the edited project to an MP4 and resolves with the file as a Blob.
 * Every visible pixel comes from `paintScene`, the same call the editor makes
 * on each repaint.
 */
export async function exportMp4({
  project,
  words = [],
  surahNames,
  videoUrl,
  duration,
  frameRate,
  quality = 0.15,
  images,
  signal,
  onProgress,
} = {}) {
  const support = exportSupport();
  if (!support.supported) throw new Error(support.reason);
  if (!videoUrl) throw new Error("Open a video before exporting.");

  onProgress?.({ phase: "prepare", progress: 0, message: "Reading the source video…" });
  const source = await loadSource(videoUrl, signal);
  const element = createSourceVideo(source.url);
  let muxer;
  let encoder;
  try {
    await once(element, "loadedmetadata");
    // The first frame has to be decoded before the loop starts, or its opening
    // seek to 0 waits on an event the element has no reason to fire.
    if (element.readyState < 2) await once(element, "loadeddata");
    const width = element.videoWidth;
    const height = element.videoHeight;
    if (!width || !height) throw new Error("The source video has no readable picture size.");
    const totalSeconds = Number.isFinite(duration) && duration > 0
      ? Math.min(duration, element.duration || duration)
      : element.duration;
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) throw new Error("The source video has no readable duration.");

    const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : await detectFrameRate(element);
    throwIfAborted(signal);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: false });
    context.imageSmoothingQuality = "high";

    onProgress?.({ phase: "prepare", progress: 0, message: "Decoding the original audio…" });
    const audioBuffer = await decodeSourceAudio(source, signal);
    throwIfAborted(signal);

    const bitrate = Math.round(Math.min(60_000_000, Math.max(3_000_000, width * height * fps * quality)));
    const videoConfig = await pickVideoConfig(width, height, fps, bitrate);
    const target = new ArrayBufferTarget();
    muxer = new Muxer({
      target,
      fastStart: "in-memory",
      // Capture hands over whatever timestamp the source frame carries, which
      // need not start at exactly zero.
      firstTimestampBehavior: "offset",
      video: { codec: "avc", width, height, frameRate: fps },
      ...(audioBuffer
        ? { audio: { codec: "aac", numberOfChannels: Math.min(2, audioBuffer.numberOfChannels), sampleRate: audioBuffer.sampleRate } }
        : {}),
    });

    let encoderError;
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        encoderError = error;
      },
    });
    encoder.configure(videoConfig);

    const expectedFrames = Math.max(1, Math.round(totalSeconds * fps));
    const keyFrameInterval = Math.max(1, Math.round(fps * 2));
    const frameDuration = Math.round(1_000_000 / fps);

    let index = 0;
    const onFrame = async (picture, time) => {
      if (encoderError) throw encoderError;
      context.drawImage(picture, 0, 0, width, height);
      const scene = buildScene({ project, words, surahNames, time, duration: totalSeconds });
      paintScene(context, scene, { width, height, images });
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(time * 1_000_000),
        duration: frameDuration,
      });
      encoder.encode(frame, { keyFrame: index % keyFrameInterval === 0 });
      frame.close();
      index += 1;
      await drainEncoder(encoder, 6);
      if (index % 10 === 0) {
        onProgress?.({
          phase: "video",
          progress: Math.min(1, index / expectedFrames),
          message: `Rendering frame ${index} of ${expectedFrames}`,
        });
        await yieldToTasks();
      }
    };

    element.pause();
    element.currentTime = 0;
    await once(element, "seeked").catch(() => {});
    let rendered = 0;
    let lastTime = -1 / fps;
    if (captureSupported(element)) {
      const captured = await renderByCapture(element, totalSeconds, onFrame, signal);
      rendered = captured.rendered;
      lastTime = captured.lastTime;
    }
    // A capture stream can end a few frames before the audio does. Seeking the
    // remainder keeps the picture covering the whole soundtrack.
    if (lastTime < totalSeconds - 1.5 / fps) {
      const tail = await renderBySeeking(element, lastTime + 1 / fps, totalSeconds, fps, onFrame, signal);
      rendered += tail.rendered;
      lastTime = tail.lastTime;
    }
    if (!rendered) throw new Error("The source video produced no frames to render.");
    await encoder.flush();
    if (encoderError) throw encoderError;
    encoder.close();
    encoder = undefined;

    if (audioBuffer) {
      onProgress?.({ phase: "audio", progress: 0, message: "Encoding audio…" });
      await encodeAudio(
        audioBuffer,
        muxer,
        signal,
        (progress) => onProgress?.({ phase: "audio", progress, message: "Encoding audio…" }),
        totalSeconds,
      );
    }

    onProgress?.({ phase: "finalize", progress: 1, message: "Writing the MP4 container…" });
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    muxer = undefined;
    return {
      blob,
      width,
      height,
      frameRate: fps,
      frames: rendered,
      expectedFrames,
      coveredSeconds: Math.max(0, lastTime),
      hasAudio: Boolean(audioBuffer),
    };
  } finally {
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      // The encoder is being torn down; a close failure has nothing left to report.
    }
    element.pause();
    element.removeAttribute("src");
    element.load();
    element.remove();
    if (source?.revoke) URL.revokeObjectURL(source.url);
  }
}
