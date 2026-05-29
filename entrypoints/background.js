import { SLOW_CAPTURE_MIN_INTERVAL_SEC } from '../utils/capture-config.js';
import { clearGifOutput } from '../utils/gif-storage.js';

const MIN_CAPTURE_GAP_MS = Math.ceil(SLOW_CAPTURE_MIN_INTERVAL_SEC * 1000);
const OFFSCREEN_PATH = '/offscreen.html';

let lastCaptureAt = 0;
let captureChain = Promise.resolve();
let creatingOffscreen = null;
let fastCaptureTabId = null;

function log(...args) {
    console.log('[gif-zone bg]', ...args);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function cropDataUrl(dataUrl, rect, dpr) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const sx = Math.round(rect.left * dpr);
    const sy = Math.round(rect.top * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(out);
    });
}

async function throttledCaptureVisibleTab(windowId, rect, dpr) {
    const run = async () => {
        const wait = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
        if (wait > 0) await sleep(wait);
        const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
        lastCaptureAt = Date.now();
        return cropDataUrl(dataUrl, rect, dpr);
    };
    const task = captureChain.then(run, run);
    captureChain = task.catch(() => {});
    return task;
}

async function ensureOffscreen() {
    const offscreenUrl = browser.runtime.getURL(OFFSCREEN_PATH);
    const existing = await browser.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
    });
    if (existing.length > 0) return;

    if (creatingOffscreen) {
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = browser.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'High-speed region capture via tab media stream',
    });
    try {
        await creatingOffscreen;
    } finally {
        creatingOffscreen = null;
    }
}

function sendToOffscreen(message) {
    return browser.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function startFastCapture(tabId, config) {
    const t0 = performance.now();
    await clearGifOutput();
    if (!browser.tabCapture?.getMediaStreamId) {
        throw new Error('tabCapture not available');
    }
    await ensureOffscreen();
    const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
    log('getMediaStreamId', `${(performance.now() - t0).toFixed(0)}ms`, { tabId });

    const res = await sendToOffscreen({
        type: 'OFFSCREEN_START_RECORDING',
        streamId,
        config,
    });
    if (!res?.ok) throw new Error(res?.error || 'offscreen recording failed');
    log('recording started', { totalMs: (performance.now() - t0).toFixed(0) });
    fastCaptureTabId = tabId;
}

async function finishFastCapture(frameDelayMs) {
    const t0 = performance.now();
    fastCaptureTabId = null;
    let frameCount = 0;
    let hasGif = false;
    try {
        const res = await sendToOffscreen({ type: 'OFFSCREEN_FINISH', frameDelayMs });
        frameCount = res?.frameCount ?? 0;
        hasGif = !!res?.hasGif;
        log('finish', { frameCount, hasGif, ms: (performance.now() - t0).toFixed(0) });
    } catch (err) {
        log('finish error', err);
    }
    try {
        await browser.offscreen.closeDocument();
    } catch {
        /* ignore */
    }
    return { frameCount, hasGif };
}

export default defineBackground(() => {
    log('started', { id: browser.runtime.id });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.target === 'offscreen') return;

        const handle = async () => {
            if (message.type === 'START_FAST_CAPTURE') {
                const tabId = sender.tab?.id;
                if (!tabId) return { ok: false, error: 'no tab' };
                await startFastCapture(tabId, message.payload);
                return { ok: true };
            }

            if (message.type === 'STOP_FAST_CAPTURE') {
                const result = await finishFastCapture(message.frameDelayMs);
                return { ok: true, ...result };
            }

            if (message.type === 'CAPTURE_REGION') {
                const tabId = sender.tab?.id;
                if (!tabId) return { ok: false, error: 'no tab' };
                const { rect, dpr } = message.payload;
                const dataUrl = await throttledCaptureVisibleTab(sender.tab.windowId, rect, dpr);
                return { ok: true, dataUrl };
            }

            return undefined;
        };

        const result = handle();
        if (result === undefined) return;

        result
            .then((res) => sendResponse(res))
            .catch((err) => {
                console.error('[gif-zone bg] handler failed', err);
                sendResponse({ ok: false, error: String(err) });
            });

        return true;
    });
});
