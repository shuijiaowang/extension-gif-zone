import { storage } from '@wxt-dev/storage';

/** 快速模式合成后的 GIF（session，避免 sendMessage 传 Blob） */
export const gifOutputStorage = storage.defineItem('session:gif-zone-output', {
    fallback: null,
});

export const gifMetaStorage = storage.defineItem('session:gif-zone-meta', {
    fallback: null,
});

export async function saveGifOutput(blob, meta) {
    await gifOutputStorage.setValue(blob);
    await gifMetaStorage.setValue(meta);
}

export async function loadGifOutput() {
    const [blob, meta] = await Promise.all([gifOutputStorage.getValue(), gifMetaStorage.getValue()]);
    await Promise.all([gifOutputStorage.removeValue(), gifMetaStorage.removeValue()]);
    return { blob: blob instanceof Blob ? blob : null, meta };
}

export async function clearGifOutput() {
    await Promise.all([gifOutputStorage.removeValue(), gifMetaStorage.removeValue()]);
}
