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

export default defineBackground(() => {
    console.log('[gif-zone] background started', { id: browser.runtime.id });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type !== 'CAPTURE_REGION') return;

        (async () => {
            const tabId = sender.tab?.id;
            if (!tabId) {
                sendResponse({ ok: false, error: 'no tab' });
                return;
            }
            const { rect, dpr } = message.payload;
            const dataUrl = await browser.tabs.captureVisibleTab(sender.tab.windowId, {
                format: 'png',
            });
            const cropped = await cropDataUrl(dataUrl, rect, dpr);
            sendResponse({ ok: true, dataUrl: cropped });
        })().catch((err) => {
            console.error('[gif-zone] capture failed', err);
            sendResponse({ ok: false, error: String(err) });
        });

        return true;
    });
});
