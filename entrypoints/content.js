import {
    SLOW_CAPTURE_MIN_INTERVAL_SEC,
    FAST_CAPTURE_MIN_INTERVAL_SEC,
    FAST_CAPTURE_MAX_OUTPUT_PX,
    GIF_MIN_FRAME_DELAY_SEC,
    useFastCapture,
} from '../utils/capture-config.js';
import { buildGifFromFrames, buildZipFromFrames, downloadBlob, blobToDataUrl } from '../utils/gif.js';

const MSG_START_SELECT = 'START_SELECT';

let region = null;
let selectOverlay = null;
let highlightEl = null;
let isSelecting = false;
let isRecording = false;
let isProcessing = false;
let stopRequested = false;
let spaceKeyListening = false;
let lastFrames = [];
let hoverHandle = null;
let adjustDrag = null;

const EDGE_HIT_PX = 8;
const MIN_REGION_SIZE_PX = 1;

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

function isEditableTarget(target) {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
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

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function setRegion(left, top, right, bottom) {
    left = clamp(left, 0, window.innerWidth);
    top = clamp(top, 0, window.innerHeight);
    right = clamp(right, 0, window.innerWidth);
    bottom = clamp(bottom, 0, window.innerHeight);

    if (right - left < MIN_REGION_SIZE_PX) {
        if (right >= window.innerWidth) left = right - MIN_REGION_SIZE_PX;
        else right = left + MIN_REGION_SIZE_PX;
    }
    if (bottom - top < MIN_REGION_SIZE_PX) {
        if (bottom >= window.innerHeight) top = bottom - MIN_REGION_SIZE_PX;
        else bottom = top + MIN_REGION_SIZE_PX;
    }

    region = normalizeRect(left, top, right, bottom);
    updateHighlight(region);
}

function getRegionHit(x, y) {
    if (!region || selectOverlay || isSelecting || isRecording || isProcessing) return null;
    const { left, top, width, height } = region;
    const right = left + width;
    const bottom = top + height;
    const onVerticalSpan = y >= top - EDGE_HIT_PX && y <= bottom + EDGE_HIT_PX;
    const onHorizontalSpan = x >= left - EDGE_HIT_PX && x <= right + EDGE_HIT_PX;
    const candidates = [];

    if (onVerticalSpan && Math.abs(x - left) <= EDGE_HIT_PX) {
        candidates.push({ handle: 'left', distance: Math.abs(x - left) });
    }
    if (onVerticalSpan && Math.abs(x - right) <= EDGE_HIT_PX) {
        candidates.push({ handle: 'right', distance: Math.abs(x - right) });
    }
    if (onHorizontalSpan && Math.abs(y - top) <= EDGE_HIT_PX) {
        candidates.push({ handle: 'top', distance: Math.abs(y - top) });
    }
    if (onHorizontalSpan && Math.abs(y - bottom) <= EDGE_HIT_PX) {
        candidates.push({ handle: 'bottom', distance: Math.abs(y - bottom) });
    }
    if (candidates.length) {
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0].handle;
    }
    if (x >= left && x <= right && y >= top && y <= bottom) return 'move';
    return null;
}

function getCursorForHandle(handle) {
    if (handle === 'left' || handle === 'right') return 'ew-resize';
    if (handle === 'top' || handle === 'bottom') return 'ns-resize';
    if (handle === 'move') return 'move';
    return '';
}

function moveRegion(dx, dy) {
    const width = region.width;
    const height = region.height;
    const left = clamp(region.left + dx, 0, window.innerWidth - width);
    const top = clamp(region.top + dy, 0, window.innerHeight - height);
    setRegion(left, top, left + width, top + height);
}

function nudgeRegion(handle, key) {
    if (!region) return false;
    if (handle === 'move') {
        if (key === 'ArrowLeft') moveRegion(-1, 0);
        else if (key === 'ArrowRight') moveRegion(1, 0);
        else if (key === 'ArrowUp') moveRegion(0, -1);
        else if (key === 'ArrowDown') moveRegion(0, 1);
        else return false;
        return true;
    }

    const { left, top, x2: right, y2: bottom } = region;
    if (handle === 'left' && key === 'ArrowLeft') setRegion(left - 1, top, right, bottom);
    else if (handle === 'left' && key === 'ArrowRight') setRegion(Math.min(left + 1, right - MIN_REGION_SIZE_PX), top, right, bottom);
    else if (handle === 'right' && key === 'ArrowLeft') setRegion(left, top, Math.max(right - 1, left + MIN_REGION_SIZE_PX), bottom);
    else if (handle === 'right' && key === 'ArrowRight') setRegion(left, top, right + 1, bottom);
    else if (handle === 'top' && key === 'ArrowUp') setRegion(left, top - 1, right, bottom);
    else if (handle === 'top' && key === 'ArrowDown') setRegion(left, Math.min(top + 1, bottom - MIN_REGION_SIZE_PX), right, bottom);
    else if (handle === 'bottom' && key === 'ArrowUp') setRegion(left, top, right, Math.max(bottom - 1, top + MIN_REGION_SIZE_PX));
    else if (handle === 'bottom' && key === 'ArrowDown') setRegion(left, top, right, bottom + 1);
    else return false;
    return true;
}

function updateRegionFromDrag(e) {
    if (!adjustDrag || !region) return;
    const dx = e.clientX - adjustDrag.startX;
    const dy = e.clientY - adjustDrag.startY;
    const { left, top, width, height, x2: right, y2: bottom } = adjustDrag.startRegion;

    if (adjustDrag.handle === 'move') {
        const nextLeft = clamp(left + dx, 0, window.innerWidth - width);
        const nextTop = clamp(top + dy, 0, window.innerHeight - height);
        setRegion(nextLeft, nextTop, nextLeft + width, nextTop + height);
    } else if (adjustDrag.handle === 'left') {
        setRegion(clamp(left + dx, 0, right - MIN_REGION_SIZE_PX), top, right, bottom);
    } else if (adjustDrag.handle === 'right') {
        setRegion(left, top, clamp(right + dx, left + MIN_REGION_SIZE_PX, window.innerWidth), bottom);
    } else if (adjustDrag.handle === 'top') {
        setRegion(left, clamp(top + dy, 0, bottom - MIN_REGION_SIZE_PX), right, bottom);
    } else if (adjustDrag.handle === 'bottom') {
        setRegion(left, top, right, clamp(bottom + dy, top + MIN_REGION_SIZE_PX, window.innerHeight));
    }
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

function onRegionMouseDown(e) {
    if (e.button !== 0) return;
    const handle = getRegionHit(e.clientX, e.clientY);
    if (!handle) return;

    e.preventDefault();
    e.stopPropagation();
    hoverHandle = handle;
    adjustDrag = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startRegion: { ...region },
    };
    document.documentElement.style.cursor = getCursorForHandle(handle);
}

function onRegionMouseMove(e) {
    if (adjustDrag) {
        e.preventDefault();
        updateRegionFromDrag(e);
        return;
    }

    hoverHandle = getRegionHit(e.clientX, e.clientY);
    document.documentElement.style.cursor = getCursorForHandle(hoverHandle);
}

function onRegionMouseUp() {
    adjustDrag = null;
    document.documentElement.style.cursor = getCursorForHandle(hoverHandle);
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
        lastFrames = [];
        log('无截图，跳过 GIF');
        return;
    }
    lastFrames = frames;
    const blob = buildGifFromFrames(frames, frameDelayMs);
    if (autoDownload) downloadBlob(blob, `gif-zone-${Date.now()}.gif`);
    try {
        await browser.storage.local.set({ lastGifDataUrl: await blobToDataUrl(blob) });
    } catch (err) {
        console.warn('[gif-zone] 预览保存失败（GIF 可能过大）', err);
    }
    log(`GIF 就绪, ${(blob.size / 1024).toFixed(1)} KB, 自动下载=${autoDownload}`);
}

async function downloadLastFramesZip() {
    if (!lastFrames.length) {
        return { ok: false, error: '暂无可下载截图，请先录制一次' };
    }
    const blob = await buildZipFromFrames(lastFrames);
    downloadBlob(blob, `gif-zone-frames-${Date.now()}.zip`);
    log(`截图 ZIP 就绪, ${lastFrames.length} 张, ${(blob.size / 1024).toFixed(1)} KB`);
    return { ok: true, count: lastFrames.length };
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

function toggleRecording() {
    if (isRecording) requestStopRecording();
    else startRecording();
}

function onKeyDown(e) {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        toggleRecording();
        return;
    }

    if (
        spaceKeyListening &&
        !e.repeat &&
        e.code === 'Space' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !isEditableTarget(e.target)
    ) {
        toggleRecording();
        return;
    }

    if (!isRecording && !isProcessing && !e.ctrlKey && !e.altKey && !e.metaKey && hoverHandle && e.key.startsWith('Arrow')) {
        if (nudgeRegion(hoverHandle, e.key)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',

    main() {
        log('content 已加载');

        browser.storage.local.get('spaceKeyListening').then((data) => {
            spaceKeyListening = data.spaceKeyListening === true;
        });
        browser.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.spaceKeyListening) {
                spaceKeyListening = changes.spaceKeyListening.newValue === true;
            }
        });

        browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message.type === MSG_START_SELECT) startSelectMode();
            if (message.type === 'DOWNLOAD_LAST_FRAMES_ZIP') {
                downloadLastFramesZip()
                    .then((res) => sendResponse(res))
                    .catch((err) => sendResponse({ ok: false, error: String(err) }));
                return true;
            }
        });

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onRegionMouseDown, true);
        document.addEventListener('mousemove', onRegionMouseMove, true);
        document.addEventListener('mouseup', onRegionMouseUp, true);
    },
});
