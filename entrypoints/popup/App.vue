<script setup>
import { ref, onMounted } from 'vue';
import { FAST_CAPTURE_MIN_INTERVAL_SEC } from '../../utils/capture-config.js';

const intervalSec = ref(1);
const durationSec = ref('');
const minInterval = FAST_CAPTURE_MIN_INTERVAL_SEC;

async function saveConfig() {
    const interval = Number(intervalSec.value);
    const durationRaw = String(durationSec.value).trim();
    await browser.storage.local.set({
        captureIntervalSec: interval > 0 ? Math.max(interval, minInterval) : 1,
        captureDurationSec: durationRaw === '' ? null : Math.max(0, Number(durationRaw) || 0),
    });
}

onMounted(async () => {
    const data = await browser.storage.local.get(['captureIntervalSec', 'captureDurationSec']);
    if (data.captureIntervalSec != null) intervalSec.value = data.captureIntervalSec;
    if (data.captureDurationSec != null) durationSec.value = data.captureDurationSec;
});

async function onStartSelect() {
    await saveConfig();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        console.log('[gif-zone] 无活动标签页');
        return;
    }
    await browser.tabs.sendMessage(tab.id, { type: 'START_SELECT' });
    console.log('[gif-zone] 已发送框选消息');
}
</script>

<template>
    <div class="form">
        <label>
            截图间隔(秒)
            <input v-model.number="intervalSec" type="number" :min="minInterval" step="0.05" @change="saveConfig" />
            <span class="hint">&lt;0.52s 使用 tabCapture 快速模式</span>
        </label>
        <label>
            录制时长(秒，空=不限)
            <input v-model="durationSec" type="number" min="0" step="0.1" placeholder="不限" @change="saveConfig" />
        </label>
        <button type="button" @click="onStartSelect">框选区域</button>
    </div>
</template>

<style scoped>
.form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    min-width: 200px;
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
}
button {
    padding: 8px 16px;
    cursor: pointer;
}
</style>
