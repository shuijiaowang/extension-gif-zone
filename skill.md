技术库使用：WXT+Vue+Js，注意使用Js。

### WXT使用
#### WXT存储基础使用
```javascript
//storageAPI是异步的，所属Extension storage，content/popup/background共享的，
//与网页的Local storage隔离
//popup有独立的Local storage
//watch监听是监听的存储变化，popup修改能被content监听，反之也成立，可以用于消息通信！

import { storage } from '#imports'; //导入
permissions: ['storage','unlimitedStorage'],//存储权限,突破存储上限权限
await storage.getItem('local:installDate'); //基础使用setItem/removeItem
// 设置监听器
const unwatch = storage.watch('local:counter', (newCount, oldCount) => {
  console.log('计数器变化:', { newCount, oldCount });
});
// 移除监听器
unwatch();
const theme = storage.defineItem('local:theme', {
  fallback: 'dark', //不存在返回默认值不存储
});
const userId = storage.defineItem('local:user-id', {
  init: () => globalThis.crypto.randomUUID(), //不存在则创建并存储
});
//可定义存储项复用,就不用每次用key
const item = storage.defineItem(
  'local:showChangelogOnUpdate',
  {
    fallback: true, // 默认值
  },
);
// 使用存储项
await item.getValue().setValue.removeValue;
const unwatch = item.watch((new,old) => {});

```

#### WXT的通信
```javascript
//popup可以独立向当前活跃的标签页发送通信。

//background/popup->content
const [tab] = await browser.tabs.query({active: true, currentWindow: true});
await browser.tabs.query({url:"https://www.example.com/"})
if (!tab.url) return;
if (!tab.id) return;
await browser.tabs.sendMessage(activeTab.value.id, {type: 'CONFIG_UPDATED'});

//监听消息
browser.runtime.onMessage.addListener(async (message) => {if (message.type === 'CONFIG_UPDATED') {}});
//发送消息并监听回复
browser.runtime.sendMessage(
    {
        type: "ADD_NUMBERS",
        payload: { a: 5, b: 3 }
    }
).then(response => {
    console.log('[Content] 收到 Background 回复:', response);
}).catch(err => {
    console.error('[Content] 发送消息失败:', err);
});
//或用await语法糖
const response = await browser.runtime.sendMessage(tab.id, {type: '', payload: {}});
//监听消息并回复sendResponse
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "ADD_NUMBERS") {
      const { a, b } = message.payload;
      // 模拟异步处理
      setTimeout(() => {
        sendResponse({ok: true,result: a + b,message: '计算完成'});
      }, 1000);
      // return true;//异步回复 Manifest V3 不需要 return true
    }
  });
```

#### 多语言
```javascript
//npm install @wxt-dev/i18n
//导入
import { i18n } from '#i18n';
const t = i18n.t; // 简化i18n调用
t.("test.test1") 
//配置
export default defineConfig({
modules: ['@wxt-dev/module-vue','@wxt-dev/i18n/module'], //虚拟模块需要导入。
manifest:{
        permissions: ['storage'],
        default_locale: 'zh_CN', // 默认语言为英语
        name: '__MSG_extName__',
        description: '__MSG_extDescription__',
},
//src/locales/zh-CN.yml
//src/locales/en.yml
extName: 
extDescription: 
test:
  test1: this is test1
  test2: this is test2
```
#### 里世界
```javascript
import { defineUnlistedScript } from '#imports';
export default defineUnlistedScript(() => {
    console.log('【里世界】运行在主环境，可访问网页全局变量');
    console.log('【里世界】网页标题，document.title：', document.title);
    console.log('【里世界】隔离环境传递的问候：', document.currentScript?.dataset.greeting);
    // 监听自定义事件，获取隔离环境传递的参数
    window.addEventListener('fromIsolatedWorld', (event) => {
        if (event instanceof CustomEvent) {
            console.log('【里世界】通过事件监听，获取隔离环境传递的问候：', event.detail.greeting);
        }
    });
});

// 注入主环境脚本
const { script } = await injectScript('/example-content02-main-world.js', {
    keepInDom: true, // 是否保留脚本元素在 DOM 中
    modifyScript: (script) => {
        // 可选：注入前修改脚本元素（如传递数据）
        // script.charset = 'UTF-8';  //如果出现乱码
        script.dataset.greeting = 'Hello from Isolated World';

        script.type='module' //现代规范，默认 UTF-8 解析 //但script.dataset失效，需要用事件传参
        script.addEventListener('load', () => {
            console.log('【主世界】模块脚本加载完成，派发传参事件');
            window.dispatchEvent(
                new CustomEvent('fromIsolatedWorld', {
                    detail: { greeting: 'Hello from Isolated World' },
                    bubbles: true,
                    cancelable: true,
                })
            );
        });
    },
});

```

### 指定允许
```javascript
const res = await browser.scripting.executeScript({
    target: {tabId: tab.id}, // 关键：指定要在哪个标签页执行脚本（tabId 是标签页的唯一标识）
    files: ['content-scripts/example_scripting.js'], // 关键：指定要执行的 Content 脚本文件路径
});
```

### UI注入
```javascript

export default defineContentScript({
    matches: ['*://*.example.com/*'],
    main(ctx) {
        // 1. 创建 IFrame UI
        const ui = createIframeUi(ctx, {
            page: '/example-ui-iframe.html', // IFrame 加载的 HTML 页面路径
            position: 'inline',
            anchor: 'body',
            onMount: (wrapper, iframe) => {
                // 2. 配置 IFrame 样式（wrapper 是包裹 IFrame 的容器，iframe 是 IFrame 元素）
                iframe.width = '300px';
            },
        });
        // 3. 挂载 IFrame UI
        ui.mount();
    },
});

{
    console.log("测试")
    // 1. 创建 Integrated UI
    const ui = createIntegratedUi(ctx, {
        position: 'inline', // UI 插入位置（inline：内联插入锚点元素）
        anchor: 'body', // 挂载的锚点元素（可传入选择器或 DOM 元素）
        onMount: (container) => {
            // 2. 定义 UI 内容（container 是 WXT 自动创建的容器元素）
            const app = document.createElement('h1');
            const fullPublicImageUrl = browser.runtime.getURL(publicImageUrl);
            const img = document.createElement('img');
            img.src = fullPublicImageUrl;
            container.append(app);
            document.body.appendChild(img);
        },
    });

    // 3. 挂载 UI 到网页 DOM 中
    ui.mount();
}

```

### 打开其他窗口
```javascript
const currentWindow = await browser.windows.getCurrent();
// const width = Math.max(currentWindow.width - 400, 300);
// const height = Math.max(currentWindow.height - 300, 200);
const width = Math.max(currentWindow.width - 400, 300);
const height = Math.max(currentWindow.height - 300, 200);
const left = Math.round((currentWindow.width - width) / 2);
const top = Math.round((currentWindow.height - height) / 2);
// 打开居中窗口
await browser.windows.create({
    url: "/popup_true.html", // 你的 popup 页面 //这里需要是实际的popup.html，而不是/popup/index.html,不然会找不到
    type: "popup", // 无边栏窗口
    // type: "normal", // 无边栏窗口
    width,
    height,
    left,
    top,
});
```
### popup与background长连接
```javascript
// 存储 Popup 连接（自动管理，无需手动操作）
let popupPort = null;
export const notifyPopup = async () => {
    popupPort?.postMessage({
        type: "change",
    });
};

 // 监听 Popup 连接（自动处理，不用改）
browser.runtime.onConnect.addListener(port => {
    if (port.name === "popup") popupPort = port;
    port.onDisconnect.addListener(() => popupPort = null);
});

```
### 注意事项。

```js
//注意事项，vue的响应式变量，数组，进行storage存储时，会被转为map对象进行存储，
await appStateManager.globalConfigStorage.setValue({
    ...appState.globalConfig,
    workdayWeeks: [...appState.globalConfig.workdayWeeks] // 纯数组存进去,不然会被改为对象。
})
```

