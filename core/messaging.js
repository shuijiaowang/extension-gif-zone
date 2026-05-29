import {showToast} from "../utils/ui/showToast.js";
import {init} from "./init.js";

export function initMessaging(){
    // 监听来自 Popup 的消息，触发会启动插件或是更新配置参数
    browser.runtime.onMessage.addListener(async (message) => {
        showToast("收到消息")
    });
}