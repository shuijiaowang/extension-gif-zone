
//仅供参考

// 控制台 GIF 录制脚本
// 使用: Alt+点击两点选区域, Alt+S 开始录制5秒并生成GIF

(function() {
    // 动态加载 gif.js
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    // 加载依赖
    async function loadDeps() {
        if (typeof GIF === 'undefined') {
            console.log('📦 正在加载 gif.js...');
            await loadScript('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js');
            // gif.js 需要 worker
            if (!window.GIF) {
                await loadScript('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
            }
            console.log('✅ gif.js 加载完成');
        }
    }

    let p1 = null;
    let p2 = null;
    let stream = null;
    let frames = [];
    let isRecording = false;

    console.log('🎥 GIF录制脚本已启动');
    console.log('📌 操作说明:');
    console.log('   Alt + 点击 = 选点（两个点确定区域）');
    console.log('   Alt + S   = 开始录制5秒并合成GIF');

    document.addEventListener('click', (e) => {
        if (!e.altKey) return;
        e.preventDefault();

        const rect = { x: e.clientX, y: e.clientY };

        if (!p1) {
            p1 = rect;
            console.log(`📍 点1: (${p1.x}, ${p1.y})`);
        } else {
            p2 = rect;
            console.log(`📍 点2: (${p2.x}, ${p2.y})`);
            console.log(`📐 区域: ${Math.abs(p1.x-p2.x)}x${Math.abs(p1.y-p2.y)}`);
        }
    });

    async function getStream() {
        if (stream) return stream;
        console.log('🎬 请求屏幕共享...');
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        stream.getVideoTracks()[0].onended = () => {
            stream = null;
            console.log('🔴 屏幕共享已结束');
        };
        console.log('✅ 屏幕共享已获取');
        return stream;
    }

    async function captureFrame(imageCapture, x, y, w, h) {
        const bitmap = await imageCapture.grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        return canvas;
    }

    async function generateGIF(frames, width, height, fps = 10) {
        return new Promise((resolve, reject) => {
            const gif = new GIF({
                workers: 2,
                quality: 10,
                width: width,
                height: height,
                workerScript: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js'
            });

            frames.forEach(canvas => {
                gif.addFrame(canvas, { delay: 1000 / fps, copy: true });
            });

            gif.on('finished', blob => {
                resolve(blob);
            });

            gif.on('error', reject);
            gif.render();
        });
    }

    document.addEventListener('keydown', async (e) => {
        if (!(e.altKey && e.key.toLowerCase() === 's')) return;
        e.preventDefault();

        if (!p1 || !p2) {
            console.log('❌ 请先用 Alt+点击 选择两个点');
            return;
        }

        if (isRecording) {
            console.log('⏳ 录制中，请稍后...');
            return;
        }

        await loadDeps();

        const stream = await getStream();
        const track = stream.getVideoTracks()[0];
        const imageCapture = new ImageCapture(track);

        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const w = Math.abs(p1.x - p2.x);
        const h = Math.abs(p1.y - p2.y);

        if (w === 0 || h === 0) {
            console.log('❌ 区域无效，请重新选点');
            p1 = p2 = null;
            return;
        }

        console.log(`🎬 开始录制 5 秒...`);
        console.log(`📐 录制区域: ${w}x${h}`);

        isRecording = true;
        frames = [];

        // 创建预览容器
        const previewDiv = document.createElement('div');
        previewDiv.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#000;padding:10px;border-radius:8px;max-width:300px;';
        previewDiv.innerHTML = '<div style="color:#fff;font-size:12px;margin-bottom:5px;">录制中...</div>';
        document.body.appendChild(previewDiv);

        // 录制5秒，每秒10帧
        const duration = 5000;
        const interval = 100; // 100ms = 10fps
        const frameCount = duration / interval;
        let captured = 0;

        const timer = setInterval(async () => {
            try {
                const canvas = await captureFrame(imageCapture, x, y, w, h);
                frames.push(canvas);
                captured++;

                // 预览缩略图
                const img = document.createElement('img');
                img.src = canvas.toDataURL('image/png');
                img.style.width = '100px';
                img.style.margin = '2px';
                img.style.border = '1px solid #fff';
                previewDiv.appendChild(img);

                console.log(`📸 已捕获 ${captured}/${frameCount} 帧`);

                if (captured >= frameCount) {
                    clearInterval(timer);
                    console.log('🎬 录制完成，正在合成GIF...');
                    previewDiv.innerHTML = '<div style="color:#fff;font-size:12px;">合成中...</div>';

                    const blob = await generateGIF(frames, w, h, 10);
                    const url = URL.createObjectURL(blob);

                    // 下载
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `screen-capture-${Date.now()}.gif`;
                    a.click();

                    URL.revokeObjectURL(url);

                    console.log(`✅ GIF生成成功！大小: ${(blob.size / 1024).toFixed(2)} KB`);
                    previewDiv.innerHTML = '<div style="color:#0f0;font-size:12px;">✅ 完成！</div>';
                    setTimeout(() => previewDiv.remove(), 3000);

                    frames = [];
                    isRecording = false;
                }
            } catch (err) {
                console.error('❌ 捕获帧失败:', err);
                clearInterval(timer);
                isRecording = false;
                previewDiv.remove();
            }
        }, interval);
    });
})();