import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { app } from 'photoshop';
import { clipboard } from 'uxp';
import { loadLibrary, previewSrc } from './library';
import { applyBrush, readCurrentBrush, rebuildState, TIP_PREFIX } from './psBrush';
import type { ApplyStep, BrushDef } from './types';
import '../styles/brush.css';

/**
 * 第三入口「特制笔刷」面板。
 *
 * 第一版只做「看 → 选 → 用」这条主链：
 *   列表（分类 + 预览） → 点击 → 装笔尖 → 选中 → 下发参数 → 删预设 → 底部状态条逐步结果。
 *
 * 视觉一律复用 common.css 的通用件（2026-10-20 收口）：
 *   标题 .main-title / 子标题 .group-title / 按钮 .action-button-N /
 *   状态条 .notify-bar + .indicator + .notify-text / 陈列 .bs-item 系列。
 * 本面板的 brush.css 只留骨架（根容器 / 底部区 / 校准区）。
 *
 * ⛔ 2026-10-22 撤掉「浮雕」开关与图层方案：用户否了 —— 给用户一个浮雕图层，
 *    他们在图层蒙版上就画不出同样效果。浮雕要回到「笔刷本身」，另行处理。
 */

/** 状态条语气：idle=中性灰、ok=绿、warn=橙、fail=红（与项目通知条语义一致） */
type Tone = 'idle' | 'ok' | 'warn' | 'fail';

/** 去掉 Error 前缀，面板里只显示人话部分 */
function cleanErr(e: any): string {
    return String(e?.message ?? e).replace(/^Error:\s*/, '');
}

export default function BrushStudio() {
    const [brushes, setBrushes] = useState<BrushDef[]>([]);
    const [categories, setCategories] = useState<string[]>([]);
    const [activeCat, setActiveCat] = useState<string>('');
    const [activeId, setActiveId] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState('就绪');
    const [tone, setTone] = useState<Tone>('idle');
    const [steps, setSteps] = useState<ApplyStep[]>([]);
    const [showCalib, setShowCalib] = useState(false);
    const [calib, setCalib] = useState('');
    const [loadErr, setLoadErr] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const { lib, brushes: list } = await loadLibrary();
                if (!alive) return;
                setBrushes(list);
                setCategories(lib.categories.length ? lib.categories : ['全部']);
                setActiveCat(lib.categories[0] || '全部');
                setLog(`已加载 ${list.length} 支笔`);
                setTone('ok');
            } catch (e: any) {
                if (!alive) return;
                setLoadErr(cleanErr(e));
                setLog('笔刷库加载失败');
                setTone('fail');
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    /**
     * 写状态条的**唯一入口**。
     *
     * ⛔⛔ 2026-10-22 12:08 用户录屏：状态条里出现铺满整屏的中文报错，看着像插件炸了。
     *    状态条是一行提示，不是日志窗口 —— 超长的原文一律截断，全文在
     *    `brushstate/_last-run.json` 的 `applyErr` 里。判据：任何一条提示 ≤ 120 字。
     */
    const say = useCallback((m: string) => {
        const s = String(m ?? '');
        say(s.length > 120 ? `${s.slice(0, 120)}…（全文见 brushstate/_last-run.json）` : s);
    }, []);

    const shown = useMemo(
        () => brushes.filter((b) => !activeCat || b.category === activeCat),
        [brushes, activeCat]
    );

    const pushStep = useCallback((s: ApplyStep) => {
        setSteps((prev) => [...prev, s]);
    }, []);

    const onPick = useCallback(
        async (b: BrushDef) => {
            if (busy) return;
            if (!app.documents.length) {
                setTone('warn');
                say('请先打开一个文档');
                return;
            }
            setBusy(true);
            setSteps([]);
            setActiveId(b.id);
            setTone('warn');
            say(`应用「${b.name}」…`);
            try {
                const r = await applyBrush(b, brushes, pushStep, (m) => say(m));
                const junkNote = r.junk ? `（另有 ${r.junk} 个误建的 tip.png 请在画笔面板删除）` : '';
                const pending = r.steps.filter((x) => x.warn).map((x) => x.name);
                if (r.ok) {
                    setTone(pending.length ? 'warn' : 'ok');
                    // 三种路径分开说，别让用户对着一句话猜我们到底干了什么。
                    // ⚠️ 不再写死"用完已删掉"：删没删取决于缓存/笔尖两道守门，
                    //    真删了会有「清理预设」步骤，没删会以黄点列在 pending 里。
                    const how =
                        r.source === 'cache'
                            ? '直接复用缓存，未创建任何预设'
                            : r.source === 'preset'
                              ? '复用了面板里已有的预设'
                              : '安装了一次（之后会走缓存）';
                    say(
                        `「${b.name}」已就位 —— ${how}${pending.length ? `（${pending.join('、')}待校准）` : ''}${junkNote}`
                    );
                } else {
                    setTone('fail');
                    const first = r.steps.find((s) => !s.ok && !s.warn);
                    say(`「${b.name}」未完全生效：${first?.msg || '见下方步骤'}${junkNote}`);
                }
            } catch (e: any) {
                setTone('fail');
                say(`失败：${cleanErr(e)}`);
            } finally {
                setBusy(false);
            }
        },
        [busy, brushes, pushStep]
    );

    /**
     * 「修复当前笔尖」= **丢掉这支笔的状态缓存**，然后完整重装一遍。
     *
     * 正常点击现在走的是「复用缓存」快路径（零弹框、零预设）。只有这几种情况需要这个按钮：
     *   · 笔尖图换过了 / 笔尖尺寸改了（缓存里的笔尖已经过时）；
     *   · 上次装到一半失败；
     *   · 画笔参数被手动改乱。
     * 代价：会弹一次「新建画笔」框（PS 定义笔尖的固有行为，绕不过）。
     */
    const onRepair = useCallback(async () => {
        if (busy) return;
        const target = brushes.find((b) => b.id === activeId) ?? brushes[0];
        if (!target) {
            setTone('warn');
            say('笔刷库为空');
            return;
        }
        try {
            await rebuildState(target.id);
        } catch {
            /* 没有缓存也不用管 */
        }
        await onPick(target);
    }, [busy, brushes, activeId, onPick]);

    const onCalib = useCallback(async () => {
        try {
            const json = await readCurrentBrush();
            setCalib(json);
            setShowCalib(true);
            setTone('ok');
            say('已读取当前画笔描述符');
        } catch (e: any) {
            setTone('fail');
            say(`读取失败：${cleanErr(e)}`);
        }
    }, []);

    const onCopy = useCallback(async () => {
        // ⛔ UXP 不是浏览器：`navigator.clipboard` 不存在，用 UXP 自己的 clipboard 模块。
        //    这条曾导致「复制失败，请手动选中」——用户只能手拖选中一大段 JSON。
        try {
            await (clipboard as any).copy(calib);
            setTone('ok');
            say('已复制到剪贴板');
        } catch {
            setTone('warn');
            say('复制失败，请手动选中');
        }
    }, [calib]);

    // 状态条语气：忙 = 橙（进行中），空闲 = 上一次结果
    const toneCls = busy ? 'warn' : tone === 'idle' ? 'disabled' : tone;
    const btnCls = (base: string) => (busy ? `${base} action-button-disabled` : base);

    return (
        <div className="bs-root">
            <div className="bs-head">
                <div className="main-title">特制笔刷</div>
                <span className="bs-count">{brushes.length} 支</span>
            </div>

            <div className="bs-tabs">
                {/* ⚠️ 用 div 而不是 <button>：UXP 的原生 button 自带 padding/border，
                    会把胶囊高度顶过 22px（与 .bs-tab 的定高打架）。 */}
                {categories.map((c) => (
                    <div
                        key={c}
                        role="button"
                        tabIndex={0}
                        className={`bs-tab${c === activeCat ? ' bs-tab-on' : ''}`}
                        onClick={() => setActiveCat(c)}
                    >
                        {c}
                    </div>
                ))}
            </div>

            <div className="bs-list">
                {loadErr ? <div className="bs-empty">笔刷库加载失败：{loadErr}</div> : null}
                {!loadErr && shown.length === 0 ? <div className="bs-empty">这个分类下还没有笔</div> : null}
                {shown.map((b) => (
                    <div
                        key={b.id}
                        className={`bs-item${b.id === activeId ? ' bs-item-on' : ''}${busy ? ' bs-item-busy' : ''}`}
                        onClick={() => onPick(b)}
                        title={`${b.name} · ${Math.round(b.params.diameter.base)}px`}
                    >
                        <div className="bs-item-head">
                            <span className="bs-name">{b.name}</span>
                            <span className="bs-meta">{Math.round(b.params.diameter.base)}px</span>
                        </div>
                        <img className="bs-prev" src={previewSrc(b.id)} alt={b.name} />
                    </div>
                ))}
            </div>

            <div className="bs-foot">
                <div className={`notify-bar notify-bar-${toneCls}`}>
                    <span className={`indicator indicator-md indicator-${toneCls}`} />
                    <span className="notify-text">{log}</span>
                </div>

                {steps.length > 0 ? (
                    <div className="bs-steps">
                        {steps.map((s, i) => (
                            <div key={i} className="bs-step">
                                <span className={`indicator indicator-md indicator-${s.ok ? 'ok' : s.warn ? 'warn' : 'fail'}`} />
                                <span className="bs-step-text" title={s.msg || ''}>
                                    {s.name}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : null}

                {/* 按钮行照前端规范用通用 .row-between（左「修复当前笔尖」右「读当前画笔」）。
                    ⚠️ 按钮宽度由字数决定：修复当前笔尖=6 字 ⇒ action-button-6(98px)；
                       读当前画笔=5 字 ⇒ action-button-5(85px)。写成小一号会把文字挤掉。 */}
                <div className="row-between">
                    <div
                        role="button"
                        tabIndex={0}
                        className={btnCls('action-button-6')}
                        onClick={busy ? undefined : onRepair}
                    >
                        修复当前笔尖
                    </div>
                    <div
                        role="button"
                        tabIndex={0}
                        className={btnCls('action-button-5')}
                        onClick={busy ? undefined : onCalib}
                    >
                        读当前画笔
                    </div>
                </div>

                {showCalib ? (
                    <div className="bs-calib">
                        <div className="bs-calib-head">
                            <span className="group-title">当前画笔描述符</span>
                            <div
                                role="button"
                                tabIndex={0}
                                className="action-button-2 bs-calib-copy"
                                onClick={onCopy}
                            >
                                复制
                            </div>
                        </div>
                        <textarea className="bs-calib-box" readOnly value={calib} />
                        <div className="bs-calib-tip">
                            把这段贴给作者，用来把参数键名补成确定值（第一版故意不猜动力学键名）。
                        </div>
                    </div>
                ) : null}

                <div className="bs-sign">{TIP_PREFIX}* · 笔尖素材见 brushes/ATTRIBUTION.md</div>
            </div>
        </div>
    );
}
