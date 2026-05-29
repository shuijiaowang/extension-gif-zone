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
const screenshotScale = ref(1);
const gifScale = ref(1);
const autoDownload = ref(true);
const spaceKeyListening = ref(false);
const lastGifUrl = ref('');
const frameZipMessage = ref('');
const qqWechatMessage = ref('');
const minInterval = FAST_CAPTURE_MIN_INTERVAL_SEC;
const slowThreshold = SLOW_CAPTURE_MIN_INTERVAL_SEC;
const minGifDelay = GIF_MIN_FRAME_DELAY_SEC;

async function saveConfig() {
    const interval = Number(intervalSec.value);
    const durationRaw = String(durationSec.value).trim();
    const delayRaw = String(gifDelaySec.value).trim();
    const screenshotScaleValue = Number(screenshotScale.value) || 1;
    const gifScaleValue = Number(gifScale.value) || 1;
    await browser.storage.local.set({
        captureIntervalSec: interval > 0 ? Math.max(interval, minInterval) : 1,
        captureDurationSec: durationRaw === '' ? null : Math.max(0, Number(durationRaw) || 0),
        gifFrameDelaySec: delayRaw === '' ? null : Math.max(minGifDelay, Number(delayRaw) || 0),
        screenshotScale: Math.min(1, Math.max(0.1, screenshotScaleValue)),
        gifScale: Math.min(1, Math.max(0.1, gifScaleValue)),
        autoDownload: autoDownload.value,
        spaceKeyListening: spaceKeyListening.value,
    });
}

onMounted(async () => {
    const data = await browser.storage.local.get([
        'captureIntervalSec',
        'captureDurationSec',
        'gifFrameDelaySec',
        'screenshotScale',
        'gifScale',
        'autoDownload',
        'spaceKeyListening',
        'lastGifDataUrl',
    ]);
    if (data.captureIntervalSec != null) intervalSec.value = data.captureIntervalSec;
    if (data.captureDurationSec != null) durationSec.value = data.captureDurationSec;
    if (data.gifFrameDelaySec != null) gifDelaySec.value = data.gifFrameDelaySec;
    if (data.screenshotScale != null) screenshotScale.value = data.screenshotScale;
    if (data.gifScale != null) gifScale.value = data.gifScale;
    if (data.autoDownload != null) autoDownload.value = data.autoDownload;
    if (data.spaceKeyListening != null) spaceKeyListening.value = data.spaceKeyListening;
    if (data.lastGifDataUrl) lastGifUrl.value = data.lastGifDataUrl;
});

function downloadGif() {
    if (!lastGifUrl.value) return;
    const a = document.createElement('a');
    a.href = lastGifUrl.value;
    a.download = `gif-zone-${Date.now()}.gif`;
    a.click();
}

async function onDownloadFramesZip() {
    frameZipMessage.value = '';
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        frameZipMessage.value = '无活动标签页';
        return;
    }
    try {
        const res = await browser.tabs.sendMessage(tab.id, { type: 'DOWNLOAD_LAST_FRAMES_ZIP' });
        if (res?.ok) {
            frameZipMessage.value = `已下载 ${res.count} 张截图`;
        } else {
            frameZipMessage.value = res?.error || '下载截图失败';
        }
    } catch (err) {
        frameZipMessage.value = String(err);
    }
}

async function onDownloadQqWechatGif() {
    qqWechatMessage.value = '';
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        qqWechatMessage.value = '无活动标签页';
        return;
    }
    try {
        const res = await browser.tabs.sendMessage(tab.id, { type: 'DOWNLOAD_QQ_WECHAT_GIF' });
        if (res?.ok) {
            qqWechatMessage.value = `已下载 ${res.kb} KB，最终比例 ${res.scale}`;
        } else {
            qqWechatMessage.value = res?.error || '下载 GIF 失败';
        }
    } catch (err) {
        qqWechatMessage.value = String(err);
    }
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
        <label>
            截图压缩比
            <input v-model.number="screenshotScale" type="number" min="0.1" max="1" step="0.05" @change="saveConfig" />
            <span class="hint">影响内存里的原素材和下载截图 ZIP，1=不压缩</span>
        </label>
        <label>
            GIF 压缩比
            <input v-model.number="gifScale" type="number" min="0.1" max="1" step="0.05" @change="saveConfig" />
            <span class="hint">生成 GIF 时在截图素材基础上再压缩，1=不压缩</span>
        </label>
        <label class="checkbox">
            <input v-model="autoDownload" type="checkbox" @change="saveConfig" />
            录制结束后自动下载
        </label>
        <label class="checkbox">
            <input v-model="spaceKeyListening" type="checkbox" @change="saveConfig" />
            空格键监听
        </label>
        <button type="button" @click="onStartSelect">框选区域</button>
        <p class="hint">框选后按 <b>Ctrl+Alt+G</b> 开始/停止录制；开启空格键监听后也可用空格切换。</p>
        <div v-if="lastGifUrl" class="preview">
            <span class="hint">上次录制预览：</span>
            <img :src="lastGifUrl" alt="GIF 预览" />
            <button type="button" @click="downloadGif">下载 GIF</button>
            <button type="button" @click="onDownloadQqWechatGif">下载 QQ/微信 GIF(&lt;1MB)</button>
            <button type="button" @click="onDownloadFramesZip">下载截图 ZIP</button>
            <span v-if="frameZipMessage" class="hint">{{ frameZipMessage }}</span>
            <span v-if="qqWechatMessage" class="hint">{{ qqWechatMessage }}</span>
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
