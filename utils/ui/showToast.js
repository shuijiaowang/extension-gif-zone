// ========== 5. 自动消失提示框 ==========
export const showToast = (message, duration = 2000) => {
    // 单例模式：先移除已存在的toast，避免重复创建
    const existingToast = document.getElementById('fishy-toast');
    if (existingToast) {
        document.body.removeChild(existingToast);
    }

    // 创建toast元素
    const toast = document.createElement('div');
    toast.id = 'fishy-toast';

    // 内联样式（和现有按钮/面板样式风格统一）
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.zIndex = 999; // 比其他元素层级更高
    toast.style.padding = '8px 16px';
    toast.style.backgroundColor = 'rgba(81, 178, 254, 0.7)'; // 半透明绿色（和保存按钮同色系）
    toast.style.color = 'white';
    toast.style.fontSize = '14px';
    toast.style.borderRadius = '4px';
    toast.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)'; // 和上传按钮阴影一致
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease'; // 淡入淡出动画
    toast.style.pointerEvents = 'none'; // 不阻挡底层元素点击
    toast.textContent = message;

    // 添加到页面
    document.body.appendChild(toast);

    // 触发淡入动画
    setTimeout(() => {
        toast.style.opacity = '1';
    }, 10);

    // 自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        // 动画结束后移除元素
        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, duration);

    return toast;
};