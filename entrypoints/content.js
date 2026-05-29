import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const MSG_START_SELECT = 'START_SELECT';

let region = null;
let selectOverlay = null;
let highlightEl = null;
let isSelecting = false;
let isCapturing = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

async function buildGif(dataUrls, width, height) {
    const gif = GIFEncoder();
    for (let i = 0; i < dataUrls.length; i++) {
        const imageData = await dataUrlToImageData(dataUrls[i], width, height);
        const palette = quantize(imageData.data, 256);
        const index = applyPalette(imageData.data, palette);
        gif.writeFrame(index, width, height, { palette, delay: 1000 });
        console.log(`[gif-zone] GIF 帧 ${i + 1}/${dataUrls.length}`);
    }
    gif.finish();
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

async function startCaptureSequence() {
    if (isCapturing) {
        console.log('[gif-zone] 正在录制，请稍候');
        return;
    }
    if (!region || region.width < 1 || region.height < 1) {
        console.log('[gif-zone] 请先框选有效区域');
        return;
    }

    isCapturing = true;
    const dpr = window.devicePixelRatio || 1;
    const rect = {
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
    };
    const frames = [];
    const total = 5;

    try {
        console.log('[gif-zone] Ctrl+Alt+G 开始截图', rect);
        for (let i = 0; i < total; i++) {
            const dataUrl = await captureOneFrame(rect, dpr);
            frames.push(dataUrl);
            console.log(`[gif-zone] 截图 ${i + 1}/${total}`);
            if (i < total - 1) await sleep(1000);
        }

        console.log('[gif-zone] 合成 GIF...');
        const first = await loadImage(frames[0]);
        const blob = await buildGif(frames, first.naturalWidth, first.naturalHeight);
        downloadBlob(blob);
        console.log(`[gif-zone] GIF 已下载, ${(blob.size / 1024).toFixed(1)} KB`);
    } catch (err) {
        console.error('[gif-zone] 录制失败', err);
    } finally {
        isCapturing = false;
    }
}

function onKeyDown(e) {
    if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === 'g')) return;
    e.preventDefault();
    startCaptureSequence();
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
