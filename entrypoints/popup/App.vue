<script setup>
async function onStartSelect() {
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
    <button type="button" @click="onStartSelect">框选区域</button>
</template>

<style scoped>
button {
    padding: 8px 16px;
    cursor: pointer;
}
</style>
