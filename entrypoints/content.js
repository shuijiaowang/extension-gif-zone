import {
    SLOW_CAPTURE_MIN_INTERVAL_SEC,
    FAST_CAPTURE_MIN_INTERVAL_SEC,
    FAST_CAPTURE_MAX_OUTPUT_PX,
    GIF_MIN_FRAME_DELAY_SEC,
    useFastCapture,
} from '../utils/capture-config.js';
import { buildGifFromFrames, downloadBlob, blobToDataUrl } from '../utils/gif.js';

const MSG_START_SELECT = 'START_SELECT';

let region = null;
let selectOverlay = null;
let highlightEl = null;
let isSelecting = false;
let isRecording = false;
let isProcessing = false;
let stopRequested = false;

// 快速模式（tabCapture 流）相关，全部在 content 内消费，无需 offscreen
let mediaStream = null;
let mediaVideo = null;
let cropCanvas = null;
let cropCtx = null;

function log(...args) {
    console.log('[gif-zone]', ...args);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(deadline) {
    while (Date.now() < deadline) {
        if (stopRequested) return;
        await sleep(Math.min(100, deadline - Date.now()));
    }
}

function shouldEndRecording(startTime, maxDurationMs) {
    if (stopRequested) return true;
    if (maxDurationMs != null && Date.now() - startTime >= maxDurationMs) return true;
    return false;
}

// ---------------------------------------------------------------------------
// 区域框选
// ---------------------------------------------------------------------------

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

function startSelectMode() {
    if (selectOverlay) return;
    log('进入框选模式，拖拽选择区域');

    selectOverlay = document.createElement('div');
    selectOverlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.05);';
    document.documentElement.appendChild(selectOverlay);

    let startX = 0;
    let startY = 0;

    selectOverlay.addEventListener('mousedown', (e) => {
        isSelecting = true;
        startX = e.clientX;
        startY = e.clientY;
        region = normalizeRect(startX, startY, startX, startY);
        updateHighlight(region);
    });

    selectOverlay.addEventListener('mousemove', (e) => {
        if (!isSelecting) return;
        region = normalizeRect(startX, startY, e.clientX, e.clientY);
        updateHighlight(region);
    });

    selectOverlay.addEventListener('mouseup', () => {
        if (!isSelecting) return;
        isSelecting = false;
        removeSelectOverlay();
        if (region && region.width > 0 && region.height > 0) {
            log('已选择区域', { width: region.width, height: region.height });
        } else {
            log('区域无效，请重新框选');
            region = null;
            highlightEl?.remove();
            highlightEl = null;
        }
    });
}

// ---------------------------------------------------------------------------
// 录制配置
// ---------------------------------------------------------------------------

async function getRecordConfig() {
    const data = await browser.storage.local.get([
        'captureIntervalSec',
        'captureDurationSec',
        'gifFrameDelaySec',
        'autoDownload',
    ]);
    let intervalSec = Number(data.captureIntervalSec) > 0 ? Number(data.captureIntervalSec) : 1;
    if (intervalSec < FAST_CAPTURE_MIN_INTERVAL_SEC) {
        log(`截图间隔已限制为 ${FAST_CAPTURE_MIN_INTERVAL_SEC}s`);
        intervalSec = FAST_CAPTURE_MIN_INTERVAL_SEC;
    }
    const durationSec =
        data.captureDurationSec == null || data.captureDurationSec === ''
            ? null
            : Number(data.captureDurationSec);
    const gifFrameDelaySec =
        data.gifFrameDelaySec == null || data.gifFrameDelaySec === ''
            ? null
            : Number(data.gifFrameDelaySec);
    return {
        intervalSec,
        durationSec: durationSec > 0 ? durationSec : null,
        gifFrameDelaySec: gifFrameDelaySec >= 0 ? gifFrameDelaySec : null,
        autoDownload: data.autoDownload !== false,
        useFast: useFastCapture(intervalSec),
    };
}

// ---------------------------------------------------------------------------
// 慢速模式：background captureVisibleTab + 裁剪
// ---------------------------------------------------------------------------

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function dataUrlToFrame(dataUrl) {
    const img = await loadImage(dataUrl);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { width, height, data };
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
            await sleep(isQuota ? Math.ceil(SLOW_CAPTURE_MIN_INTERVAL_SEC * 1000) : 200);
        }
    }
    throw lastErr;
}

async function recordSlow(rect, dpr, intervalMs, maxDurationMs) {
    const frames = [];
    const startTime = Date.now();
    let nextAt = startTime;

    while (!shouldEndRecording(startTime, maxDurationMs)) {
        try {
            const dataUrl = await captureOneFrameRetry(rect, dpr);
            frames.push(await dataUrlToFrame(dataUrl));
            log(`截图 ${frames.length}`);
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

// ---------------------------------------------------------------------------
// 快速模式：tabCapture 流，直接在 content 内 getUserMedia 抓帧
// ---------------------------------------------------------------------------

async function requestTabStreamId() {
    const res = await browser.runtime.sendMessage({ type: 'GET_TAB_STREAM_ID' });
    if (!res?.ok) throw new Error(res?.error || 'no stream id');
    return res.streamId;
}

async function waitForVideoReady(el) {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
        if (el.videoWidth > 0 && el.videoHeight > 0 && el.readyState >= 2) return;
        await sleep(30);
    }
    throw new Error(`video not ready (w=${el.videoWidth} h=${el.videoHeight} rs=${el.readyState})`);
}

async function startTabStream(streamId) {
    mediaStream = await navigator.mediaDevices.getUserMedia({
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
    mediaVideo = document.createElement('video');
    mediaVideo.srcObject = mediaStream;
    mediaVideo.muted = true;
    mediaVideo.playsInline = true;
    mediaVideo.style.cssText =
        'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
    document.documentElement.appendChild(mediaVideo);
    await mediaVideo.play();
    await waitForVideoReady(mediaVideo);
    log('tabCapture 流就绪', {
        videoWidth: mediaVideo.videoWidth,
        videoHeight: mediaVideo.videoHeight,
    });
}

function stopTabStream() {
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    mediaVideo?.remove();
    mediaVideo = null;
    cropCanvas = null;
    cropCtx = null;
}

function fitOutputSize(sw, sh) {
    const maxEdge = Math.max(sw, sh);
    if (maxEdge <= FAST_CAPTURE_MAX_OUTPUT_PX) return { outW: sw, outH: sh };
    const scale = FAST_CAPTURE_MAX_OUTPUT_PX / maxEdge;
    return {
        outW: Math.max(1, Math.round(sw * scale)),
        outH: Math.max(1, Math.round(sh * scale)),
    };
}

function grabFastFrame(rect) {
    if (!mediaVideo?.videoWidth) throw new Error('stream not ready');
    // tabCapture 在视口宽高比与流约束(maxWidth/maxHeight)不一致时会给视频帧加黑边，
    // 视口内容只占据视频帧中间一块。必须用「等比缩放 + 居中偏移」反推真实内容区域，
    // 否则 scaleX≠scaleY 会把选区拉变形，且偏移错误会截到黑边与外围。
    const vw = mediaVideo.videoWidth;
    const vh = mediaVideo.videoHeight;
    const scale = Math.min(vw / window.innerWidth, vh / window.innerHeight);
    const offsetX = (vw - window.innerWidth * scale) / 2;
    const offsetY = (vh - window.innerHeight * scale) / 2;
    const sx = Math.round(offsetX + rect.left * scale);
    const sy = Math.round(offsetY + rect.top * scale);
    const sw = Math.max(1, Math.round(rect.width * scale));
    const sh = Math.max(1, Math.round(rect.height * scale));
    const { outW, outH } = fitOutputSize(sw, sh);
    if (!cropCanvas || cropCanvas.width !== outW || cropCanvas.height !== outH) {
        cropCanvas = document.createElement('canvas');
        cropCanvas.width = outW;
        cropCanvas.height = outH;
        cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
    }
    cropCtx.drawImage(mediaVideo, sx, sy, sw, sh, 0, 0, outW, outH);
    const { data } = cropCtx.getImageData(0, 0, outW, outH);
    return { width: outW, height: outH, data: new Uint8ClampedArray(data) };
}

async function recordFast(rect, intervalMs, maxDurationMs) {
    const streamId = await requestTabStreamId();
    await startTabStream(streamId);

    const frames = [];
    const startTime = Date.now();
    let nextAt = startTime;
    try {
        while (!shouldEndRecording(startTime, maxDurationMs)) {
            try {
                frames.push(grabFastFrame(rect));
                if (frames.length <= 3 || frames.length % 10 === 0) log(`截图 ${frames.length} (快速)`);
            } catch (err) {
                console.warn('[gif-zone] 抓帧失败', err);
            }
            if (shouldEndRecording(startTime, maxDurationMs)) break;
            nextAt += intervalMs;
            if (nextAt > Date.now()) await sleepUntil(nextAt);
        }
    } finally {
        stopTabStream();
    }
    return frames;
}

// ---------------------------------------------------------------------------
// 录制总流程
// ---------------------------------------------------------------------------

async function finishRecording(frames, frameDelayMs, autoDownload) {
    if (!frames.length) {
        log('无截图，跳过 GIF');
        return;
    }
    const blob = buildGifFromFrames(frames, frameDelayMs);
    if (autoDownload) downloadBlob(blob, `gif-zone-${Date.now()}.gif`);
    try {
        await browser.storage.local.set({ lastGifDataUrl: await blobToDataUrl(blob) });
    } catch (err) {
        console.warn('[gif-zone] 预览保存失败（GIF 可能过大）', err);
    }
    log(`GIF 就绪, ${(blob.size / 1024).toFixed(1)} KB, 自动下载=${autoDownload}`);
}

async function startRecording() {
    if (isRecording || isProcessing) {
        log('正在录制或合成中');
        return;
    }
    if (!region || region.width < 1 || region.height < 1) {
        log('请先框选有效区域');
        return;
    }

    const { intervalSec, durationSec, gifFrameDelaySec, autoDownload, useFast } = await getRecordConfig();
    const intervalMs = intervalSec * 1000;
    let gifDelayMs = gifFrameDelaySec != null ? gifFrameDelaySec * 1000 : intervalMs;
    const gifMinDelayMs = GIF_MIN_FRAME_DELAY_SEC * 1000;
    if (gifDelayMs < gifMinDelayMs) {
        log(`GIF 拼接间隔已限制为 ${GIF_MIN_FRAME_DELAY_SEC}s（更小会被浏览器按 0.1s 播放）`);
        gifDelayMs = gifMinDelayMs;
    }
    const maxDurationMs = durationSec != null ? durationSec * 1000 : null;
    const dpr = window.devicePixelRatio || 1;
    const rect = {
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
    };

    isRecording = true;
    stopRequested = false;
    hideHighlight();
    log('开始录制', {
        intervalSec,
        durationSec: durationSec ?? '不限',
        mode: useFast ? 'tabCapture(快速)' : 'captureVisibleTab(慢速)',
    });

    let frames = [];
    try {
        frames = useFast
            ? await recordFast(rect, intervalMs, maxDurationMs)
            : await recordSlow(rect, dpr, intervalMs, maxDurationMs);
    } catch (err) {
        console.error('[gif-zone] 录制异常', err);
        stopTabStream();
    } finally {
        isRecording = false;
        stopRequested = false;
    }

    isProcessing = true;
    try {
        await finishRecording(frames, gifDelayMs, autoDownload);
    } catch (err) {
        console.error('[gif-zone] GIF 合成失败', err);
    } finally {
        isProcessing = false;
        showHighlight();
    }
}

function requestStopRecording() {
    if (!isRecording) return;
    stopRequested = true;
    log('收到停止录制');
}

function onKeyDown(e) {
    if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === 'g')) return;
    e.preventDefault();
    if (isRecording) requestStopRecording();
    else startRecording();
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',

    main() {
        log('content 已加载');

        browser.runtime.onMessage.addListener((message) => {
            if (message.type === MSG_START_SELECT) startSelectMode();
        });

        document.addEventListener('keydown', onKeyDown, true);
    },
});
