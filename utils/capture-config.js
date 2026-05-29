/** captureVisibleTab 约 2 次/秒；低于此间隔走 tabCapture */
export const SLOW_CAPTURE_MIN_INTERVAL_SEC = 0.52;
/** 快速模式最小间隔 */
export const FAST_CAPTURE_MIN_INTERVAL_SEC = 0.05;
/** 快速模式输出最长边（像素），减小编码与传输开销 */
export const FAST_CAPTURE_MAX_OUTPUT_PX = 640;
/**
 * GIF 帧延迟下限（秒）。GIF 精度为 1 厘秒(10ms)，且浏览器/看图器会把
 * ≤10ms 的延迟强制按 100ms 播放，故有效最小值取 0.02s(≈50fps)。
 */
export const GIF_MIN_FRAME_DELAY_SEC = 0.02;

export function useFastCapture(intervalSec) {
    return intervalSec < SLOW_CAPTURE_MIN_INTERVAL_SEC;
}
