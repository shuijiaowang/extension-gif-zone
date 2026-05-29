<script setup>
import { ref, onMounted } from 'vue';
import {
    FAST_CAPTURE_MIN_INTERVAL_SEC,
    SLOW_CAPTURE_MIN_INTERVAL_SEC,
    GIF_MIN_FRAME_DELAY_SEC,
} from '../../utils/capture-config.js';

const intervalSec = ref(1);
const durationSec = ref('');
const gifDelaySec = ref('');
const autoDownload = ref(true);
const lastGifUrl = ref('');
const minInterval = FAST_CAPTURE_MIN_INTERVAL_SEC;
const slowThreshold = SLOW_CAPTURE_MIN_INTERVAL_SEC;
const minGifDelay = GIF_MIN_FRAME_DELAY_SEC;

async function saveConfig() {
    const interval = Number(intervalSec.value);
    const durationRaw = String(durationSec.value).trim();
    const delayRaw = String(gifDelaySec.value).trim();
    await browser.storage.local.set({
        captureIntervalSec: interval > 0 ? Math.max(interval, minInterval) : 1,
        captureDurationSec: durationRaw === '' ? null : Math.max(0, Number(durationRaw) || 0),
        gifFrameDelaySec: delayRaw === '' ? null : Math.max(minGifDelay, Number(delayRaw) || 0),
        autoDownload: autoDownload.value,
    });
}

onMounted(async () => {
    const data = await browser.storage.local.get([
        'captureIntervalSec',
        'captureDurationSec',
        'gifFrameDelaySec',
        'autoDownload',
        'lastGifDataUrl',
    ]);
    if (data.captureIntervalSec != null) intervalSec.value = data.captureIntervalSec;
    if (data.captureDurationSec != null) durationSec.value = data.captureDurationSec;
    if (data.gifFrameDelaySec != null) gifDelaySec.value = data.gifFrameDelaySec;
    if (data.autoDownload != null) autoDownload.value = data.autoDownload;
    if (data.lastGifDataUrl) lastGifUrl.value = data.lastGifDataUrl;
});

function downloadGif() {
    if (!lastGifUrl.value) return;
    const a = document.createElement('a');
    a.href = lastGifUrl.value;
    a.download = `gif-zone-${Date.now()}.gif`;
    a.click();
}

async function onStartSelect() {
    await saveConfig();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        console.log('[gif-zone] 无活动标签页');
        return;
    }
    await browser.tabs.sendMessage(tab.id, { type: 'START_SELECT' });
    window.close();
}
</script>

<template>
    <div class="form">
        <label>
            截图间隔(秒)
            <input v-model.number="intervalSec" type="number" :min="minInterval" step="0.05" @change="saveConfig" />
            <span class="hint">&lt;{{ slowThreshold }}s 使用 tabCapture 快速模式（仅 HTTPS 页面）</span>
        </label>
        <label>
            录制时长(秒，空=不限)
            <input v-model="durationSec" type="number" min="0" step="0.1" placeholder="不限" @change="saveConfig" />
        </label>
        <label>
            GIF 拼接间隔(秒，空=同截图间隔)
            <input v-model="gifDelaySec" type="number" :min="minGifDelay" step="0.01" placeholder="同截图间隔" @change="saveConfig" />
            <span class="hint">越小播放越快；下限 {{ minGifDelay }}s，更小会被浏览器按 0.1s 播放</span>
        </label>
        <label class="checkbox">
            <input v-model="autoDownload" type="checkbox" @change="saveConfig" />
            录制结束后自动下载
        </label>
        <button type="button" @click="onStartSelect">框选区域</button>
        <p class="hint">框选后按 <b>Ctrl+Alt+G</b> 开始/停止录制。</p>
        <div v-if="lastGifUrl" class="preview">
            <span class="hint">上次录制预览：</span>
            <img :src="lastGifUrl" alt="GIF 预览" />
            <button type="button" @click="downloadGif">下载 GIF</button>
        </div>
    </div>
</template>

<style scoped>
.form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    min-width: 220px;
}
label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}
input {
    padding: 4px 6px;
}
.hint {
    font-size: 10px;
    color: #666;
    margin: 0;
}
button {
    padding: 8px 16px;
    cursor: pointer;
}
.checkbox {
    flex-direction: row;
    align-items: center;
    gap: 6px;
}
.checkbox input {
    width: auto;
}
.preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.preview img {
    max-width: 100%;
    border: 1px solid #ddd;
    border-radius: 4px;
}
</style>
