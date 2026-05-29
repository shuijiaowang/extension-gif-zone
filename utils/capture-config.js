/** captureVisibleTab 约 2 次/秒；低于此间隔走 tabCapture */
export const SLOW_CAPTURE_MIN_INTERVAL_SEC = 0.52;
/** 快速模式最小间隔 */
export const FAST_CAPTURE_MIN_INTERVAL_SEC = 0.05;
/** 快速模式输出最长边（像素），减小编码与传输开销 */
export const FAST_CAPTURE_MAX_OUTPUT_PX = 640;

export function useFastCapture(intervalSec) {
    return intervalSec < SLOW_CAPTURE_MIN_INTERVAL_SEC;
}
