import React from 'react';
import ToggleSwitch from '../components/ToggleSwitch';
import { helpTexts } from '../constants/helpTexts';
import { HOTKEY_ARM_MSG_NOT_CONNECTED, toggleHotkeyArm, useHotkeyArm } from './hotkeyArmStore';

/**
 * 折叠标题右侧的热键开关（2026-10-23 从分区内容的状态条搬迁而来）。
 *
 * 与套索平滑那颗开关同一款做法：
 *  · 状态来自**组件外**的 store（hotkeyArmStore），所以分区折叠（内容条件渲染、不进 DOM）
 *    时它照样可用、照样显示真实状态；
 *  · ⛔ checked 只吃「用户意图」(armed)，**不吃 connected** —— WS 抖动时开关不许自己跳。
 *  · ⛔ 未连接时**不禁用**：置灰等于把用户唯一的入口封掉；点击后由 store 记一条
 *    不消失的提示（见 HotkeyArmAlert），比一个点不动的灰开关有用。
 */
export default function HotkeyArmSwitch() {
  const { connected, armed, busy } = useHotkeyArm();
  return (
    <ToggleSwitch
      checked={armed}
      disabled={busy}
      /* ⛔ 占位盒压到 16px（= 胶囊本身高度）：默认 24px 是为与滑块/数字输入同基线，
         而**折叠标题行**里没有那些控件，24px 会把标题行顶高 4~8px（用户实测
         「笔刷热键标题比其它折叠分区高一截」）。走内联样式而不是只靠 CSS：
         主题样式/内联覆盖都可能抢在后代选择器前面，内联是唯一确定生效的一层
         （common.css 的 .collapse-header-control 同时锁了包裹盒高度，双保险）。 */
      style={{ height: 16 }}
      onChange={() => { void toggleHotkeyArm(); }}
      title={(connected
        ? (armed ? helpTexts.hotkey.daemonStop : helpTexts.hotkey.daemonStart)
        : HOTKEY_ARM_MSG_NOT_CONNECTED) + '\n当前状态：' + (busy ? '处理中…' : connected ? (armed ? '功能开启' : '功能关闭') : '未连接')}
    />
  );
}

/**
 * 「热键无法运转」的常驻提示条（warn 档）。
 *
 * 用户要求：**无法运转时这条 notify bar 不会自然消失** —— 它由 store 的 error/connected 驱动，
 * 没有计时器，只有「连接恢复」或「用户成功布防/撤防」才清空。
 *
 * ⚠️ 2026-10-23 二次修正：**折叠态与展开态都渲染**（用户报「展开后这条就没了」）。
 *   · 折叠态：由 AdjustmentPanel 渲染在折叠标题下方（内容外，折叠时不进 DOM 也看得见）；
 *   · 展开态：由 BrushHotkeySection 渲染在「已选中 N 条」那行的下一行。
 *   两处共用本组件 ⇒ 判据唯一（未连接 / 有 error 才显示）。因工具箱折叠是**条件渲染**，
 *   同一时刻只有一处真的在 DOM 里，不会重复。
 */
export function HotkeyArmAlert() {
  const { connected, error } = useHotkeyArm();
  if (connected && !error) return null;
  const text = error || HOTKEY_ARM_MSG_NOT_CONNECTED;
  return (
    <div className="notify-bar notify-bar-warn">
      <span className="indicator indicator-md indicator-warn" />
      <span className="notify-text" title={text}>{text}</span>
    </div>
  );
}
