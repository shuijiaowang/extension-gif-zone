import { defineWebExtConfig } from 'wxt';
import { resolve } from 'node:path';
export default defineWebExtConfig({
    startUrls: ["https://www.baidu.com/","https://www.example.com/"],//不知道为什么，后面这个先打开，顺序不对。
    // Windows需要使用绝对路径，resolve方法
    chromiumProfile: resolve('.wxt/chrome-data'), //.wxt/chrome-data 需要自己手动创建该文件夹
    keepProfileChanges: true, // 👈 必须开启，否则不会保存配置到指定目录
});
