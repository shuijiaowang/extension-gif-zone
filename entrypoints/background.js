import { SLOW_CAPTURE_MIN_INTERVAL_SEC } from '../utils/capture-config.js';

const MIN_CAPTURE_GAP_MS = Math.ceil(SLOW_CAPTURE_MIN_INTERVAL_SEC * 1000);

let lastCaptureAt = 0;
let captureChain = Promise.resolve();

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

// captureVisibleTab 有频率上限，串行排队并按最小间隔节流
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

export default defineBackground(() => {
    log('started', { id: browser.runtime.id });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const handle = async () => {
            // 快速模式：为目标标签页生成 streamId，由该标签页的 content script 自行消费
            if (message.type === 'GET_TAB_STREAM_ID') {
                const tabId = sender.tab?.id;
                if (!tabId) return { ok: false, error: 'no tab' };
                if (!browser.tabCapture?.getMediaStreamId) {
                    return { ok: false, error: 'tabCapture not available' };
                }
                // 处理器内第一个 await 必须是 getMediaStreamId（依赖用户手势，且 streamId 数秒后过期）
                const streamId = await browser.tabCapture.getMediaStreamId({
                    targetTabId: tabId,
                    consumerTabId: tabId,
                });
                log('getMediaStreamId', { tabId });
                return { ok: true, streamId };
            }

            // 慢速模式：截可见区并裁剪后回传 dataUrl
            if (message.type === 'CAPTURE_REGION') {
                if (!sender.tab) return { ok: false, error: 'no tab' };
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
