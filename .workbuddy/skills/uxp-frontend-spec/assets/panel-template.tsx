import React, { useState } from 'react';
import RangeSlider from '../components/RangeSlider';
import Select from '../components/Select';
import { ExpandIcon } from '../styles/Icons';
import { helpTexts } from '../constants/helpTexts';

/**
 * 新面板骨架（按 UXP 前端规范拼装，见 uxp-frontend-spec skill）
 *
 * 高度链：#panelId(100%) → Provider(height="100%") → .my-root(100%) → .panel(滚动) → .panel-section
 * 规则：不发明新类；间距用 margin（UXP 无 gap）；颜色只走 theme.ts 变量；状态类去 common.css 底部。
 */
const MyPanel: React.FC = () => {
    const [strength, setStrength] = useState(50);
    const [mode, setMode] = useState('a');
    const [enabled, setEnabled] = useState(true);
    const [open, setOpen] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [items] = useState(['1', '2', '3', '4', '5']);

    return (
        // .panel = 面板外壳 + 唯一滚动容器；不要在它外面再套 height:auto 的层
        <div className="panel">
            {/* 顶部状态横幅（min-height:30px，换行自动增高） */}
            <div className="status-banner status-banner-ok" style={{ display: 'flex' }}>
                <span className="indicator indicator-md indicator-ok" />
                <span className="notify-text">就绪</span>
            </div>

            {/* 分区：默认 flex 列，下边距 15px */}
            <div className="panel-section">
                <div className="main-title">我的功能</div>

                {/* 带描边分区 */}
                <div className="border-panel-section">
                    {/* 标准滑块行：标签 + 滑块 + 数字 + 单位 */}
                    <div className="row-between" title={helpTexts.myPanel.strengthRow}>
                        <label className="label-4">强度</label>
                        <RangeSlider
                            className="slider-track"
                            min={0}
                            max={100}
                            step={1}
                            value={strength}
                            onChange={setStrength}
                            title={helpTexts.myPanel.strengthSlider}
                        />
                        <div className="row-start">
                            <div className="num-input-row">
                                <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={strength}
                                    onChange={(e) => setStrength(Number(e.target.value))}
                                    title={helpTexts.myPanel.strengthInput}
                                />
                            </div>
                            <span className="num-unit">%</span>
                        </div>
                    </div>

                    {/* 开关行：sp-switch 在 .row-between 内自动 4px 左间距 */}
                    <div className="row-between">
                        <label className="label-4">启用</label>
                        <sp-switch
                            checked={enabled}
                            onchange={(e: any) => setEnabled(e.target.checked)}
                        />
                    </div>

                    {/* 下拉：只能用 Select，禁用 sp-picker */}
                    <div className="row-between">
                        <label className="label-4">模式</label>
                        <div className="select-wrap">
                            <Select
                                value={mode}
                                options={[
                                    { value: 'a', label: '模式 A' },
                                    { value: 'b', label: '模式 B' },
                                ]}
                                onChange={setMode}
                                disabled={!enabled}
                            />
                        </div>
                    </div>

                    {/* 禁用行：整行置灰（.disabled 内部自动处理 label / 滑块 / input） */}
                    <div className={`row-between${enabled ? '' : ' disabled'}`}>
                        <label className="label-4">阈值</label>
                        <RangeSlider className="slider-track" min={0} max={10} step={1} value={3} onChange={() => {}} disabled={!enabled} />
                    </div>
                </div>

                {/* 实线 / 虚线分割线（虚线用 DOM span 序列，UXP 不支持渐变背景） */}
                <div className="divider" />
                <div className="divider-dashed">
                    {Array.from({ length: 20 }).map((_, i) => (
                        <span key={i} className="divider-dashed-dash" />
                    ))}
                </div>

                {/* 两列 radio：左贴左缘、右贴右缘（230 = 面板可用宽） */}
                <sp-radio-group className="radio-pair-230" value={mode} onchange={(e: any) => setMode(e.target.value)}>
                    <sp-radio value="a">平滑</sp-radio>
                    <sp-radio value="b">锐化</sp-radio>
                </sp-radio-group>
            </div>

            {/* 缩略图预设区：4 列，B=52 / M=4（间距规则写在面板 CSS 里） */}
            <div className="panel-section">
                <div className="preset-area">
                    <div className="pattern-preset">
                        {items.map((it, i) => (
                            <div
                                key={it}
                                className={`thumb-box${i === 0 ? ' thumb-selected' : ''}`}
                                draggable
                                onDragStart={() => {}}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => {}}
                            >
                                <img src="" alt="" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* 折叠分区：内容必须条件渲染（原生 input 裁不住，见 pitfalls ①②） */}
            <div className="collapse-section" data-section-id="advanced">
                <div className="collapse-header" onClick={() => setOpen(!open)}>
                    <span className={open ? 'collapse-icon-expanded' : 'collapse-icon'}>
                        <ExpandIcon />
                    </span>
                    <span>高级设置</span>
                </div>
                {open && (
                    <div className="collapse-content-expanded">
                        <div className="row-between">
                            <label className="label-4">半径</label>
                            <div className="row-start">
                                <div className="num-input-row">
                                    <input type="number" min={0} max={50} value={5} onChange={() => {}} />
                                </div>
                                <span className="num-unit">px</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* 操作按钮：宽度 = 13×字数 + 20（4 字 → 72） */}
            <div className="row-center">
                <button
                    className={`action-button-4${enabled ? '' : ' action-button-disabled'}`}
                    disabled={!enabled}
                    onClick={() => {}}
                >
                    应用
                </button>
            </div>

            {/* 底部状态条 */}
            <div className="notify-bar notify-bar-warn">
                <span className="indicator indicator-md indicator-warn" />
                <span className="notify-text">提示文案统一放 helpTexts.ts</span>
            </div>

            <div className="copyright">© JWautofill</div>

            {/* 遮罩 + 浮动窗口：遮罩背景由 theme.ts 注入，此处绝不写 background-color。
                打开时记得给 body 加状态类隐藏本面板内所有 input/textarea（原生控件穿透）。 */}
            {showModal && (
                <div className="float-overlay" onClick={() => setShowModal(false)}>
                    <div className="float-window" onClick={(e) => e.stopPropagation()}>
                        <div className="subpanel-title-1">
                            <span>标题</span>
                            <button className="close-button" onClick={() => setShowModal(false)}>
                                ×
                            </button>
                        </div>
                        <div className="notify-text">窗口内容</div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MyPanel;
