import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { app } from 'photoshop';
import { clipboard } from 'uxp';
import { loadLibrary, previewSrc } from './library';
import { applyBrush, ensureTip, readCurrentBrush, resetTipsFlag, TIP_PREFIX } from './psBrush';
import type { ApplyStep, BrushDef } from './types';
import '../styles/brush.css';

/**
 * 第三入口「特制笔刷」面板。
 *
 * 第一版只做「看 → 选 → 用」这条主链：
 *   列表（分类 + 预览） → 点击 → 选中笔尖 + 下发参数 → 底部状态条逐步结果。
 * 参数滑杆、收藏、用户自存笔刷属于 P2，这里刻意不做，先把链路跑通。
 *
 * 视觉一律复用 common.css 的通用件（2026-10-20 收口）：
 *   标题 .main-title / 子标题 .group-title / 按钮 .action-button-N /
 *   状态条 .notify-bar + .indicator + .notify-text / 陈列 .bs-item 系列。
 * 本面板的 brush.css 只留骨架（根容器 / 底部区 / 校准区）。
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
                setLog('请先打开一个文档');
                return;
            }
            setBusy(true);
            setSteps([]);
            setActiveId(b.id);
            setTone('warn');
            setLog(`应用「${b.name}」…`);
            try {
                const r = await applyBrush(b, brushes, pushStep, (m) => setLog(m));
                const junkNote = r.junk ? `（另有 ${r.junk} 个误建的 tip.png 请在画笔面板删除）` : '';
                const toolPending = r.steps.some((x) => x.warn);
                if (r.ok) {
                    setTone(toolPending ? 'warn' : 'ok');
                    setLog(`「${b.name}」已就绪${toolPending ? '（工具不透明度待校准，画笔本体已生效）' : ''}${junkNote}`);
                } else {
                    setTone('fail');
                    const first = r.steps.find((s) => !s.ok && s.name !== '下发工具不透明度');
                    setLog(`「${b.name}」未完全生效：${first?.msg || '见下方步骤'}${junkNote}`);
                }
            } catch (e: any) {
                setTone('fail');
                setLog(`失败：${cleanErr(e)}`);
            } finally {
                setBusy(false);
            }
        },
        [busy, brushes, pushStep]
    );

    const onRepair = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setSteps([]);
        setTone('warn');
        setLog('检查笔尖…');
        try {
            // 按需单支之后，这里只修「当前选中/第一支」——不再一次灌 6 支
            const target = brushes.find((b) => b.id === activeId) ?? brushes[0];
            if (!target) {
                setTone('warn');
                setLog('笔刷库为空');
                return;
            }
            resetTipsFlag();
            const r = await ensureTip(target, (m) => setLog(m));
            if (r.failed.length) {
                setTone('fail');
                setLog(`笔尖补齐失败 ${r.failed.length} 支：${r.failed[0].msg}`);
                r.failed.forEach((f) => pushStep({ name: `安装笔尖 ${f.name}`, ok: false, msg: f.msg }));
            } else {
                setTone('ok');
                const junkNote = r.junk ? `；另有 ${r.junk} 个误建的 tip.png 请在画笔面板删除` : '';
                setLog((r.installed.length ? `已安装 ${r.installed.length} 支笔尖` : '笔尖齐备，无需重装') + junkNote);
            }
        } catch (e: any) {
            setTone('fail');
            setLog(`安装失败：${cleanErr(e)}`);
        } finally {
            setBusy(false);
        }
    }, [busy, brushes, activeId, pushStep]);

    const onCalib = useCallback(async () => {
        try {
            const json = await readCurrentBrush();
            setCalib(json);
            setShowCalib(true);
            setTone('ok');
            setLog('已读取当前画笔描述符');
        } catch (e: any) {
            setTone('fail');
            setLog(`读取失败：${cleanErr(e)}`);
        }
    }, []);

    const onCopy = useCallback(async () => {
        // ⛔ UXP 不是浏览器：`navigator.clipboard` 不存在，用 UXP 自己的 clipboard 模块。
        //    这条曾导致「复制失败，请手动选中」——用户只能手拖选中一大段 JSON。
        try {
            await (clipboard as any).copy(calib);
            setTone('ok');
            setLog('已复制到剪贴板');
        } catch {
            setTone('warn');
            setLog('复制失败，请手动选中');
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

                <div className="bs-actions">
                    <div
                        role="button"
                        tabIndex={0}
                        className={btnCls('action-button-4')}
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
