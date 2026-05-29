import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import {appState as externalAppState, DEFAULT_DOMAIN_CONFIG} from '../core/config.js';
import * as domain from "node:domain";
export const useConfigStore = defineStore('config', () => {

    //消息通信
    const notifyContentScript = async (type) => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
        if (!tab.id) return;
        await browser.tabs.sendMessage(tab.id, {type: type});
    };
    // 统一导出
    return {
        notifyContentScript
    }
})