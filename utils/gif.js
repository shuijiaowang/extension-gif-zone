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

/** 把 Blob 读成 data URL（用于在 popup 中预览/重新下载） */
export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
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

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
}

const CRC_TABLE = makeCrcTable();
const encoder = new TextEncoder();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) {
    view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
    view.setUint32(offset, value, true);
}

function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

function makePngBlob(frame) {
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('png export failed'));
        }, 'image/png');
    });
}

async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

function createStoredZip(files) {
    const parts = [];
    const centralParts = [];
    const now = dosDateTime(new Date());
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const checksum = crc32(file.bytes);

        const local = new ArrayBuffer(30);
        const localView = new DataView(local);
        writeU32(localView, 0, 0x04034b50);
        writeU16(localView, 4, 20);
        writeU16(localView, 6, 0);
        writeU16(localView, 8, 0);
        writeU16(localView, 10, now.time);
        writeU16(localView, 12, now.date);
        writeU32(localView, 14, checksum);
        writeU32(localView, 18, file.bytes.length);
        writeU32(localView, 22, file.bytes.length);
        writeU16(localView, 26, nameBytes.length);
        writeU16(localView, 28, 0);
        parts.push(local, nameBytes, file.bytes);

        const central = new ArrayBuffer(46);
        const centralView = new DataView(central);
        writeU32(centralView, 0, 0x02014b50);
        writeU16(centralView, 4, 20);
        writeU16(centralView, 6, 20);
        writeU16(centralView, 8, 0);
        writeU16(centralView, 10, 0);
        writeU16(centralView, 12, now.time);
        writeU16(centralView, 14, now.date);
        writeU32(centralView, 16, checksum);
        writeU32(centralView, 20, file.bytes.length);
        writeU32(centralView, 24, file.bytes.length);
        writeU16(centralView, 28, nameBytes.length);
        writeU16(centralView, 30, 0);
        writeU16(centralView, 32, 0);
        writeU16(centralView, 34, 0);
        writeU16(centralView, 36, 0);
        writeU32(centralView, 38, 0);
        writeU32(centralView, 42, offset);
        centralParts.push(central, nameBytes);

        offset += local.byteLength + nameBytes.length + file.bytes.length;
    }

    const centralOffset = offset;
    const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
    const end = new ArrayBuffer(22);
    const endView = new DataView(end);
    writeU32(endView, 0, 0x06054b50);
    writeU16(endView, 4, 0);
    writeU16(endView, 6, 0);
    writeU16(endView, 8, files.length);
    writeU16(endView, 10, files.length);
    writeU32(endView, 12, centralSize);
    writeU32(endView, 16, centralOffset);
    writeU16(endView, 20, 0);

    return new Blob([...parts, ...centralParts, end], { type: 'application/zip' });
}

export async function buildZipFromFrames(frames) {
    const width = String(frames.length).length;
    const files = [];
    for (let i = 0; i < frames.length; i++) {
        const png = await makePngBlob(frames[i]);
        files.push({
            name: `frame-${String(i + 1).padStart(width, '0')}.png`,
            bytes: await blobToBytes(png),
        });
    }
    return createStoredZip(files);
}
