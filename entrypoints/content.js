import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import {
    SLOW_CAPTURE_MIN_INTERVAL_SEC,
    FAST_CAPTURE_MIN_INTERVAL_SEC,
    useFastCapture,
} from '../utils/capture-config.js';
import { loadGifOutput } from '../utils/gif-storage.js';

const MSG_START_SELECT = 'START_SELECT';

let region = null;
let selectOverlay = null;
let highlightEl = null;
let isSelecting = false;
let isRecording = false;
let isProcessing = false;
let stopRecording = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(deadline) {
    while (Date.now() < deadline) {
        if (stopRecording) return;
        await sleep(Math.min(100, deadline - Date.now()));
    }
}

function normalizeRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    return { left, top, width, height, x1: left, y1: top, x2: left + width, y2: top + height };
}

function removeSelectOverlay() {
    selectOverlay?.remove();
    selectOverlay = null;
}

function ensureHighlight() {
    if (highlightEl) return highlightEl;
    highlightEl = document.createElement('div');
    highlightEl.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #00ff88;background:rgba(0,255,136,0.15);box-sizing:border-box;';
    document.documentElement.appendChild(highlightEl);
    return highlightEl;
}

function updateHighlight(rect) {
    const el = ensureHighlight();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.display = rect.width && rect.height ? 'block' : 'none';
}

function hideHighlight() {
    if (highlightEl) highlightEl.style.display = 'none';
}

function showHighlight() {
    if (region?.width > 0 && region?.height > 0) updateHighlight(region);
}

async function getRecordConfig() {
    const data = await browser.storage.local.get(['captureIntervalSec', 'captureDurationSec']);
    let intervalSec = Number(data.captureIntervalSec) > 0 ? Number(data.captureIntervalSec) : 1;
    if (intervalSec < FAST_CAPTURE_MIN_INTERVAL_SEC) {
        console.log(`[gif-zone] 截图间隔已限制为 ${FAST_CAPTURE_MIN_INTERVAL_SEC}s`);
        intervalSec = FAST_CAPTURE_MIN_INTERVAL_SEC;
    }
    const durationSec =
        data.captureDurationSec == null || data.captureDurationSec === ''
            ? null
            : Number(data.captureDurationSec);
    const fast = useFastCapture(intervalSec);
    return {
        intervalSec,
        durationSec: durationSec > 0 ? durationSec : null,
        useFastCapture: fast,
    };
}

function startSelectMode() {
    if (selectOverlay) return;
    console.log('[gif-zone] 进入框选模式，拖拽选择区域');

    selectOverlay = document.createElement('div');
    selectOverlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.05);';
    document.documentElement.appendChild(selectOverlay);

    let startX = 0;
    let startY = 0;

    const onMouseDown = (e) => {
        isSelecting = true;
        startX = e.clientX;
        startY = e.clientY;
        region = normalizeRect(startX, startY, startX, startY);
        updateHighlight(region);
    };

    const onMouseMove = (e) => {
        if (!isSelecting) return;
        region = normalizeRect(startX, startY, e.clientX, e.clientY);
        updateHighlight(region);
    };

    const onMouseUp = () => {
        if (!isSelecting) return;
        isSelecting = false;
        removeSelectOverlay();
        if (region && region.width > 0 && region.height > 0) {
            console.log('[gif-zone] 区域对角坐标', {
                x1: region.x1,
                y1: region.y1,
                x2: region.x2,
                y2: region.y2,
                width: region.width,
                height: region.height,
            });
        } else {
            console.log('[gif-zone] 区域无效，请重新框选');
            region = null;
            highlightEl?.remove();
            highlightEl = null;
        }
    };

    selectOverlay.addEventListener('mousedown', onMouseDown);
    selectOverlay.addEventListener('mousemove', onMouseMove);
    selectOverlay.addEventListener('mouseup', onMouseUp);
}

async function captureOneFrame(rect, dpr) {
    const res = await browser.runtime.sendMessage({
        type: 'CAPTURE_REGION',
        payload: { rect, dpr },
    });
    if (!res?.ok) throw new Error(res?.error || 'capture failed');
    return res.dataUrl;
}

async function captureOneFrameRetry(rect, dpr, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            return await captureOneFrame(rect, dpr);
        } catch (err) {
            lastErr = err;
            const isQuota = String(err).includes('MAX_CAPTURE_VISIBLE_TAB');
            console.warn(`[gif-zone] 截图失败 ${i + 1}/${retries}`, err);
            if (isQuota) await sleep(Math.ceil(SLOW_CAPTURE_MIN_INTERVAL_SEC * 1000));
            else await sleep(200);
        }
    }
    throw lastErr;
}

async function startFastCaptureSession(rect, intervalMs, maxDurationMs) {
    const t0 = performance.now();
    const res = await browser.runtime.sendMessage({
        type: 'START_FAST_CAPTURE',
        payload: {
            rect,
            intervalMs,
            maxDurationMs,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        },
    });
    console.log('[gif-zone] START_FAST_CAPTURE', {
        ok: res?.ok,
        ms: (performance.now() - t0).toFixed(0),
        error: res?.error,
    });
    if (!res?.ok) throw new Error(res?.error || 'fast capture start failed');
}

async function stopFastCaptureSession(frameDelayMs) {
    const t0 = performance.now();
    const res = await browser.runtime.sendMessage({
        type: 'STOP_FAST_CAPTURE',
        frameDelayMs,
    });
    const { blob: gifBlob, meta } = await loadGifOutput();
    console.log('[gif-zone] STOP_FAST_CAPTURE', {
        ok: res?.ok,
        frameCount: res?.frameCount ?? meta?.frameCount ?? 0,
        hasGif: res?.hasGif,
        gifLoaded: gifBlob instanceof Blob,
        gifKB: gifBlob ? (gifBlob.size / 1024).toFixed(1) : 0,
        meta,
        ms: (performance.now() - t0).toFixed(0),
    });
    if (!res?.ok) throw new Error(res?.error || 'fast capture stop failed');
    return {
        gifBlob,
        frameCount: res?.frameCount ?? meta?.frameCount ?? 0,
    };
}

function onFastCaptureProgress(message) {
    if (message.type === 'FAST_CAPTURE_FRAME') {
        const ms = message.timing?.totalMs;
        const detail = ms != null ? `${ms.toFixed(1)}ms` : '';
        if (message.frameCount <= 3 || message.frameCount % 10 === 0) {
            console.log(`[gif-zone] 截图 ${message.frameCount} (快速) ${detail}`);
        }
        return;
    }
    if (message.type === 'FAST_CAPTURE_READY') {
        console.log('[gif-zone] offscreen 已完成', {
            frameCount: message.frameCount,
            hasGif: message.hasGif,
        });
        stopRecording = true;
    }
}

async function loadImage(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
    });
    return img;
}

async function dataUrlToImageData(dataUrl, width, height) {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
}

async function blobFrameToImageData({ blob, width, height }) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, width, height);
}

async function buildGif(dataUrls, width, height, frameDelayMs) {
    const gif = GIFEncoder();
    for (let i = 0; i < dataUrls.length; i++) {
        const imageData = await dataUrlToImageData(dataUrls[i], width, height);
        const palette = quantize(imageData.data, 256);
        const index = applyPalette(imageData.data, palette);
        gif.writeFrame(index, width, height, { palette, delay: frameDelayMs });
        console.log(`[gif-zone] GIF 帧 ${i + 1}/${dataUrls.length}`);
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
}

async function buildGifFromBlobFrames(blobFrames, frameDelayMs) {
    const t0 = performance.now();
    const gif = GIFEncoder();
    for (let i = 0; i < blobFrames.length; i++) {
        const { width, height } = blobFrames[i];
        const imageData = await blobFrameToImageData(blobFrames[i]);
        const palette = quantize(imageData.data, 256);
        const index = applyPalette(imageData.data, palette);
        gif.writeFrame(index, width, height, { palette, delay: frameDelayMs });
        console.log(`[gif-zone] GIF 帧 ${i + 1}/${blobFrames.length}`);
    }
    gif.finish();
    console.log('[gif-zone] GIF 编码完成', {
        frames: blobFrames.length,
        ms: (performance.now() - t0).toFixed(0),
    });
    return new Blob([gif.bytes()], { type: 'image/gif' });
}

function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gif-zone-${Date.now()}.gif`;
    a.click();
    URL.revokeObjectURL(url);
}

function shouldEndRecording(startTime, maxDurationMs) {
    if (stopRecording) return true;
    if (maxDurationMs != null && Date.now() - startTime >= maxDurationMs) return true;
    return false;
}

async function recordLoopSlow(rect, dpr, intervalMs, maxDurationMs) {
    const frames = [];
    const startTime = Date.now();
    let nextAt = startTime;

    while (!shouldEndRecording(startTime, maxDurationMs)) {
        try {
            const dataUrl = await captureOneFrameRetry(rect, dpr);
            frames.push(dataUrl);
            console.log(`[gif-zone] 截图 ${frames.length}`);
        } catch (err) {
            console.error('[gif-zone] 截图连续失败，结束录制', err);
            break;
        }

        if (shouldEndRecording(startTime, maxDurationMs)) break;

        nextAt += intervalMs;
        if (nextAt > Date.now()) await sleepUntil(nextAt);
    }

    return frames;
}

async function recordLoopFast(_rect, intervalMs, maxDurationMs) {
    const startTime = Date.now();
    browser.runtime.onMessage.addListener(onFastCaptureProgress);
    const maxWait = (maxDurationMs ?? 60000) + 20000;

    try {
        while (!stopRecording) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= maxWait) {
                console.warn('[gif-zone] 等待 offscreen 超时', { elapsed, maxWait });
                break;
            }
            await sleep(100);
        }
    } finally {
        browser.runtime.onMessage.removeListener(onFastCaptureProgress);
    }

    const result = await stopFastCaptureSession(intervalMs);
    const elapsed = Date.now() - startTime;
    const fps = result.frameCount > 0 ? result.frameCount / (elapsed / 1000) : 0;
    console.log('[gif-zone] 快速录制统计', {
        frameCount: result.frameCount,
        elapsedMs: elapsed,
        intervalMs,
        actualFps: fps.toFixed(2),
        hasGif: !!result.gifBlob,
    });
    return result;
}

async function finishRecording(framesOrFast, frameDelayMs) {
    if (framesOrFast?.gifBlob instanceof Blob) {
        console.log('[gif-zone] 使用 offscreen 预合成 GIF', {
            frameCount: framesOrFast.frameCount,
            kb: (framesOrFast.gifBlob.size / 1024).toFixed(1),
        });
        downloadBlob(framesOrFast.gifBlob);
        console.log(`[gif-zone] GIF 已下载, ${(framesOrFast.gifBlob.size / 1024).toFixed(1)} KB`);
        return;
    }

    if (framesOrFast?.frameCount > 0 && !framesOrFast?.gifBlob) {
        console.error('[gif-zone] 已截帧但 GIF 未取到', {
            frameCount: framesOrFast.frameCount,
        });
        return;
    }

    const frames = Array.isArray(framesOrFast) ? framesOrFast : [];
    if (frames.length === 0) {
        console.log('[gif-zone] 无截图，跳过 GIF');
        return;
    }

    const isBlobPacket = frames[0]?.blob != null && frames[0]?.width > 0;
    console.log('[gif-zone] 合成 GIF...', {
        frames: frames.length,
        type: isBlobPacket ? 'jpeg-blob' : 'dataUrl',
    });
    const blob = isBlobPacket
        ? await buildGifFromBlobFrames(frames, frameDelayMs)
        : await (async () => {
              const first = await loadImage(frames[0]);
              return buildGif(frames, first.naturalWidth, first.naturalHeight, frameDelayMs);
          })();
    downloadBlob(blob);
    console.log(`[gif-zone] GIF 已下载, ${(blob.size / 1024).toFixed(1)} KB`);
}

async function startRecording() {
    if (isRecording || isProcessing) {
        console.log('[gif-zone] 正在录制或合成中');
        return;
    }
    if (!region || region.width < 1 || region.height < 1) {
        console.log('[gif-zone] 请先框选有效区域');
        return;
    }

    const { intervalSec, durationSec, useFastCapture: useFast } = await getRecordConfig();
    const intervalMs = intervalSec * 1000;
    const maxDurationMs = durationSec != null ? durationSec * 1000 : null;
    const dpr = window.devicePixelRatio || 1;
    const rect = {
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
    };

    isRecording = true;
    stopRecording = false;
    hideHighlight();
    console.log('[gif-zone] 开始录制', {
        intervalSec,
        durationSec: durationSec ?? '不限',
        mode: useFast ? 'tabCapture' : 'captureVisibleTab',
    });

    let frames = [];
    let endedByUser = false;
    let fastStarted = false;
    try {
        if (useFast) {
            await startFastCaptureSession(rect, intervalMs, maxDurationMs);
            fastStarted = true;
            frames = await recordLoopFast(rect, intervalMs, maxDurationMs);
        } else {
            frames = await recordLoopSlow(rect, dpr, intervalMs, maxDurationMs);
        }
        endedByUser = stopRecording;
    } catch (err) {
        console.error('[gif-zone] 录制异常', err);
        if (fastStarted) {
            await browser.runtime.sendMessage({ type: 'STOP_FAST_CAPTURE' }).catch(() => {});
        }
    } finally {
        isRecording = false;
        stopRecording = false;
    }

    const frameCount = frames?.gifBlob ? frames.frameCount : frames?.length ?? 0;
    if (endedByUser) console.log('[gif-zone] 手动停止录制');
    else if (maxDurationMs != null && frameCount > 0) console.log('[gif-zone] 达到录制时长，自动停止');

    isProcessing = true;
    try {
        await finishRecording(frames, intervalMs);
    } catch (err) {
        console.error('[gif-zone] GIF 合成失败', err);
    } finally {
        isProcessing = false;
        showHighlight();
    }
}

function requestStopRecording() {
    if (!isRecording) return;
    stopRecording = true;
    console.log('[gif-zone] 收到停止录制');
}

function onKeyDown(e) {
    if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === 'g')) return;
    e.preventDefault();
    if (isRecording) {
        requestStopRecording();
        return;
    }
    startRecording();
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',

    main() {
        console.log('[gif-zone] content 已加载');

        browser.runtime.onMessage.addListener((message) => {
            if (message.type === MSG_START_SELECT) {
                startSelectMode();
            }
        });

        document.addEventListener('keydown', onKeyDown, true);
    },
});
