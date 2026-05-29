// core/config.js
export const APP_CONFIG = {
    // 快捷键配置
    KEYBOARD: {},
    // UI配置
    UI: {}
};
// ... (保留 DEFAULT_DOMAIN_CONFIG) ...
export const DEFAULT_DOMAIN_CONFIG = {
    pluginEnabled: false,
};
export const appState = {
    //--------该网站独有的存储属性-------
    domainConfigStorage : storage.defineItem(`local:${window.location.hostname}`, {
        fallback: DEFAULT_DOMAIN_CONFIG //不存在则返回默认值
    }),
    domainConfig: {
        isPluginEnabled: false, //是否启用插件
    },
    saveDomainConfig:async () => {
        await appState.domainConfigStorage.setValue(appState.domainConfig)
    }
};
