/**
 * 拖拽期间把全局光标钉死为 ew-resize。
 *
 * 为什么需要它：标签/行容器的 `cursor: ew-resize` 只在鼠标悬停于该元素上时有效。
 * 一旦按住开始拖拽，鼠标很快会移出标签范围（拖到面板空白处、滑块条上、甚至面板外），
 * 此时光标由鼠标下方的元素决定，就变成了普通箭头——观感上像是「拖到一半丢了」。
 *
 * 解决：拖拽开始时给 document.body 挂一个 class，由全局 CSS 用 !important 把光标
 * 统一压成 ew-resize，拖拽结束（mouseup）时摘掉。
 *
 * 用引用计数而不是布尔量：两个面板同文档同 bundle，理论上可能出现一处拖拽尚未
 * 结束、另一处已经开始的情况，计数能保证后结束的那次才真正摘掉 class。
 */

const DRAG_CURSOR_CLASS = 'label-drag-cursor';

let lockCount = 0;

/** 拖拽开始传 true，结束（mouseup / 组件卸载）传 false。 */
export function setDragCursorActive(active: boolean): void {
    try {
        const body = document.body;
        if (!body) return;

        if (active) {
            lockCount += 1;
            body.classList.add(DRAG_CURSOR_CLASS);
        } else {
            lockCount = Math.max(0, lockCount - 1);
            if (lockCount === 0) {
                body.classList.remove(DRAG_CURSOR_CLASS);
            }
        }
    } catch (e) {
        /* UXP 下 document.body 可能暂不可用，静默忽略：光标退回各元素自身的 cursor */
    }
}

/** 强制复位（例如面板关闭/异常中断时兜底，避免 class 残留导致光标永久锁死）。 */
export function resetDragCursor(): void {
    try {
        const body = document.body;
        if (!body) return;
        lockCount = 0;
        body.classList.remove(DRAG_CURSOR_CLASS);
    } catch (e) {
        /* 忽略 */
    }
}
