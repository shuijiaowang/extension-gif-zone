import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { FAST_CAPTURE_MAX_OUTPUT_PX } from '../../utils/capture-config.js';
import { saveGifOutput } from '../../utils/gif-storage.js';

const MAX_OUTPUT_PX = FAST_CAPTURE_MAX_OUTPUT_PX;

let video = null;
let stream = null;
let cropCanvas = null;
let cropCtx = null;

let recordActive = false;
let recordConfig = null;
let frames = [];
let lastCaptureAt = 0;
let rVfcId = null;
let finishing = false;
let lastFinishResult = null;

function log(...args) {
    console.log('[gif-zone offscreen]', ...args);
}

async function waitForVideoReady(el) {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
        if (el.videoWidth > 0 && el.videoHeight > 0 && el.readyState >= 2) {
            return;
        }
        await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`video not ready (w=${el.videoWidth} h=${el.videoHeight} rs=${el.readyState})`);
}

function stopStream() {
    if (rVfcId != null && video) {
        video.cancelVideoFrameCallback(rVfcId);
        rVfcId = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) {
        video.srcObject = null;
        video.remove();
        video = null;
    }
    cropCanvas = null;
    cropCtx = null;
}

function resetCapture() {
    recordActive = false;
    finishing = false;
    lastFinishResult = null;
    frames = [];
    recordConfig = null;
    lastCaptureAt = 0;
    stopStream();
}

async function startStream(streamId) {
    const t0 = performance.now();
    stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
                maxWidth: 1920,
                maxHeight: 1080,
                maxFrameRate: 30,
            },
        },
    });
    log('getUserMedia ok', `${(performance.now() - t0).toFixed(0)}ms`);

    video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
    await video.play();
    await waitForVideoReady(video);
    log('video ready', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        ms: (performance.now() - t0).toFixed(0),
    });
}

function fitOutputSize(sw, sh) {
    const maxEdge = Math.max(sw, sh);
    if (maxEdge <= MAX_OUTPUT_PX) return { outW: sw, outH: sh };
    const scale = MAX_OUTPUT_PX / maxEdge;
    return {
        outW: Math.max(1, Math.round(sw * scale)),
        outH: Math.max(1, Math.round(sh * scale)),
    };
}

function ensureCropCanvas(outW, outH) {
    if (!cropCanvas || cropCanvas.width !== outW || cropCanvas.height !== outH) {
        cropCanvas = new OffscreenCanvas(outW, outH);
        cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
        log('crop canvas', { outW, outH });
    }
    return cropCtx;
}

function grabFrameSync() {
    if (!video?.videoWidth || !recordConfig) throw new Error('stream not ready');
    const t0 = performance.now();
    const { rect, viewportWidth, viewportHeight } = recordConfig;
    const scaleX = video.videoWidth / viewportWidth;
    const scaleY = video.videoHeight / viewportHeight;
    const sx = Math.round(rect.left * scaleX);
    const sy = Math.round(rect.top * scaleY);
    const sw = Math.max(1, Math.round(rect.width * scaleX));
    const sh = Math.max(1, Math.round(rect.height * scaleY));
    const { outW, outH } = fitOutputSize(sw, sh);
    const ctx = ensureCropCanvas(outW, outH);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    const imageData = ctx.getImageData(0, 0, outW, outH);
    return {
        width: outW,
        height: outH,
        data: new Uint8ClampedArray(imageData.data),
        grabMs: performance.now() - t0,
    };
}

function notifyFrame(count, grabMs) {
    chrome.runtime
        .sendMessage({ type: 'FAST_CAPTURE_FRAME', frameCount: count, timing: { totalMs: grabMs } })
        .catch(() => {});
}

function scheduleVideoCapture() {
    if (!recordActive || !video) return;

    rVfcId = video.requestVideoFrameCallback(() => {
        rVfcId = null;
        if (!recordActive || !recordConfig) return;

        const now = performance.now();
        const { intervalMs, maxDurationMs, startedAt } = recordConfig;
        const elapsed = now - startedAt;

        if (maxDurationMs != null && elapsed >= maxDurationMs) {
            log('duration reached in offscreen', { elapsed: elapsed.toFixed(0), frames: frames.length });
            finishCapture(recordConfig.frameDelayMs);
            return;
        }

        if (now - lastCaptureAt >= intervalMs) {
            try {
                const packet = grabFrameSync();
                frames.push(packet);
                lastCaptureAt = now;
                notifyFrame(frames.length, packet.grabMs);
                if (frames.length <= 3 || frames.length % 10 === 0) {
                    log('frame', frames.length, { grabMs: packet.grabMs.toFixed(1) });
                }
            } catch (err) {
                console.warn('[gif-zone offscreen] frame failed', err);
            }
        }

        scheduleVideoCapture();
    });
}

function buildGifFromFrames(frameDelayMs) {
    const t0 = performance.now();
    const gif = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
        const { width, height, data } = frames[i];
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, width, height, { palette, delay: frameDelayMs });
    }
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    log('gif built', {
        frames: frames.length,
        ms: (performance.now() - t0).toFixed(0),
        kb: (blob.size / 1024).toFixed(1),
    });
    return blob;
}

async function finishCapture(frameDelayMs) {
    if (lastFinishResult) return lastFinishResult;
    if (finishing) return { frameCount: 0, hasGif: false };
    finishing = true;
    recordActive = false;

    const frameCount = frames.length;
    const delay = frameDelayMs ?? recordConfig?.frameDelayMs ?? 100;
    let gifBlob = null;

    try {
        if (frameCount > 0) {
            gifBlob = buildGifFromFrames(delay);
            await saveGifOutput(gifBlob, {
                frameCount,
                kb: Number((gifBlob.size / 1024).toFixed(1)),
                at: Date.now(),
            });
            log('gif → wxt storage', { frameCount, kb: (gifBlob.size / 1024).toFixed(1) });
        } else {
            log('finish with 0 frames');
        }
    } catch (err) {
        console.error('[gif-zone offscreen] finish failed', err);
        throw err;
    } finally {
        frames = [];
        recordConfig = null;
        stopStream();
    }

    lastFinishResult = { frameCount, hasGif: !!gifBlob };

    chrome.runtime
        .sendMessage({ type: 'FAST_CAPTURE_READY', frameCount, hasGif: !!gifBlob })
        .catch(() => {});

    return lastFinishResult;
}

async function startRecording(streamId, config) {
    const wall0 = performance.now();
    resetCapture();
    await startStream(streamId);
    frames = [];
    recordConfig = {
        ...config,
        startedAt: performance.now(),
        frameDelayMs: config.intervalMs,
    };
    recordActive = true;
    lastCaptureAt = 0;
    log('recording armed', {
        startupMs: (performance.now() - wall0).toFixed(0),
        rect: config.rect,
        intervalMs: config.intervalMs,
        maxDurationMs: config.maxDurationMs,
    });
    scheduleVideoCapture();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'OFFSCREEN_START_RECORDING') {
        startRecording(message.streamId, message.config)
            .then(() => sendResponse({ ok: true }))
            .catch((err) => {
                console.error('[gif-zone offscreen] start failed', err);
                sendResponse({ ok: false, error: String(err) });
            });
        return true;
    }

    if (message.type === 'OFFSCREEN_FINISH') {
        (async () => {
            try {
                const result = await finishCapture(message.frameDelayMs);
                sendResponse({ ok: true, frameCount: result.frameCount, hasGif: result.hasGif });
            } catch (err) {
                sendResponse({ ok: false, error: String(err), frameCount: 0 });
            }
        })();
        return true;
    }
});
