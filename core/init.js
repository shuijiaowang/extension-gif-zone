import {appState} from "./config.js";

export async function init() {
    //初始化数据
    appState.domainConfig = await appState.domainConfigStorage.getValue()

}