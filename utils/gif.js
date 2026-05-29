import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/**
 * 用 gifenc 把帧序列合成为 GIF Blob。
 * @param {Array<{width:number,height:number,data:Uint8ClampedArray}>} frames 每帧的 RGBA 像素
 * @param {number} frameDelayMs 帧间隔（毫秒）
 */
export function buildGifFromFrames(frames, frameDelayMs) {
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
    console.log('[gif-zone] GIF 合成完成', {
        frames: frames.length,
        ms: (performance.now() - t0).toFixed(0),
        kb: (blob.size / 1024).toFixed(1),
    });
    return blob;
}

/** 触发浏览器下载一个 Blob */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
