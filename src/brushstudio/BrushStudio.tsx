import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { app } from 'photoshop';
import { clipboard } from 'uxp';
import { loadLibrary, previewSrc } from './library';
import { applyBrush, readCurrentBrush, rebuildState, TIP_PREFIX } from './psBrush';
import { connectSmoothDaemon } from '../lasso/SmoothBridge';
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

/** 状态条语气：idle=中性灰、ok=主色蓝、warn=橙、fail=红（与项目通知条语义一致） */
type Tone = 'idle' | 'ok' | 'warn' | 'fail';

/** 去重 Error 前缀，面板里只显示人话部分 */
function cleanErr(e: any): string {
    return String(e?.message ?? e).replace(/^Error:\s*/, '');
}

/**
 * 卡片上那个尺寸怎么显示。
 *
 * ⛔ 2026-10-22 用户定案：`params.diameter.base`（820）对混合器笔**作废** ——
 *    真实直径每次装储层都会被改成图案长边（178×400 ⇒ 400）。
 *    面板显示一个自己都不用的数字，只会让人怀疑笔刷没装对。
 *    混合器笔只认 `mixerSize`（`library.ts` 装载时读 PNG 头部算出来的长边）。
 */
function sizeLabel(b: BrushDef): string {
    if (b.mixer?.pattern) {
        const side = b.mixerSize ?? b.mixer.side ?? 0;
        return side ? `${side}px` : '—';
    }
    return `${Math.round(b.params.diameter.base)}px`;
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

    /**
     * 本面板也要一条 WS 18924 连接。
     *
     * ⛔ 为什么非加不可：合成点击（`canvasClick`）走的是这条 WS，而它原本只由
     *    `#app` 面板发起（`connectSmoothDaemon()`）。用户只开着「特制笔刷」面板时
     *    连接根本不存在 ⇒ 装储层会以「原生宿主没连上」失败，而且看起来像坏掉了。
     *    该函数是**幂等 + 引用计数**的（同一 JS 世界共用一条 socket），多调无害。
     */
    useEffect(() => connectSmoothDaemon(), []);

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
        // ⛔ 这里必须写 setLog：上一版批量替换时写成了 say，成了**无条件自递归**
        //    （每写一次状态条就再调自己一次）。tsc 不报错、构建也通过，
        //    但一点击就是栈溢出。凡"包一层的入口函数"，改完必须肉眼核一遍函数体。
        setLog(s.length > 120 ? `${s.slice(0, 120)}…（全文见 brushstate/_last-run.json）` : s);
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
                /* 降级那条 warn 步骤不列进 pending：它的原因已经在 `r.degraded` 里说清楚了，
                   否则状态条会变成「（装储层（降级）待校准）」这种看不懂的复读。 */
                const pending = r.steps.filter((x) => x.warn && !/降级/.test(x.name)).map((x) => x.name);
                if (r.ok) {
                    setTone(pending.length || r.degraded ? 'warn' : 'ok');
                    // 三种路径分开说，别让用户对着一句话猜我们到底干了什么。
                    // ⚠️ 不再写死"用完已删掉"：删没删取决于缓存/笔尖两道守门，
                    //    真删了会有「清理预设」步骤，没删会以黄点列在 pending 里。
                    const how =
                        r.source === 'mixer'
                            ? '混合器储层已按当前前景色重装（每次点击都会重装一次）'
                            : r.source === 'cache'
                              ? '直接复用缓存，未创建任何预设'
                              : r.source === 'preset'
                                ? '复用了面板里已有的预设'
                                : '安装了一次（之后会走缓存）';
                    say(
                        `「${b.name}」已就位 —— ${how}` +
                            (r.degraded ? `。⚠️ ${r.degraded}` : '') +
                            `${pending.length ? `（${pending.join('、')}待校准）` : ''}${junkNote}`
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
     * 「修复当前笔尖」/「重装储层」= **丢掉这支笔的状态缓存**，然后完整重装一遍。
     *
     * 两种路线下它干的不是同一件事，所以按钮名按当前笔的路线走（见 render 里的
     * `repairLabel`）：
     *   · 普通笔：清缓存 → 下次点击走完整安装（会弹一次「新建画笔」框）。
     *     只有在「换过笔尖图 / 笔尖尺寸改过 / 上次装到一半失败」时才需要它。
     *   · 混合器笔：**没有缓存可清**（它根本不走 cto 缓存，一次都不写），
     *     这一下就是「重新装一次储层」—— 等于再点一次卡片，只是明确告诉你"重来"。
     */
    const onRepair = useCallback(async () => {
        if (busy) return;
        const target = brushes.find((b) => b.id === activeId) ?? brushes[0];
        if (!target) {
            setTone('warn');
            say('笔刷库为空');
            return;
        }
        // 混合器路线不写 cto 缓存 ⇒ 清缓存是空动作，直接跳过（少一次无意义的 IO）
        if (!target.mixer?.pattern) {
            try {
                await rebuildState(target.id);
            } catch {
                /* 没有缓存也不用管 */
            }
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
    /** 左下按钮按**当前这支笔的路线**决定叫法和宽度（混合器笔没有"笔尖"可修） */
    const repairIsMixer = !!((brushes.find((b) => b.id === activeId) ?? brushes[0])?.mixer?.pattern);

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
                        title={
                            b.mixer?.pattern
                                ? `${b.name} · 方形笔尖，边长 = 图案长边 ${sizeLabel(b)}`
                                : `${b.name} · ${sizeLabel(b)}`
                        }
                    >
                        <div className="bs-item-head">
                            <span className="bs-name">{b.name}</span>
                            <span className="bs-meta">{sizeLabel(b)}</span>
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

                {/* 按钮行照前端规范用通用 .row-between。
                    ⚠️ 按钮宽度由**字数**决定，而且随笔的路线变：
                       混合器笔 ⇒ 重装储层=4 字 ⇒ action-button-4(72px)；
                       普通笔   ⇒ 修复当前笔尖=6 字 ⇒ action-button-6(98px)；
                       读当前画笔=5 字 ⇒ action-button-5(85px)。写成小一号会把文字挤掉。 */}
                <div className="row-between">
                    <div
                        role="button"
                        tabIndex={0}
                        className={btnCls(repairIsMixer ? 'action-button-4' : 'action-button-6')}
                        onClick={busy ? undefined : onRepair}
                    >
                        {repairIsMixer ? '重装储层' : '修复当前笔尖'}
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

                {/* 署名行顺带挂一个探针入口：字号 10px、与署名同色，几乎不占视觉重量。
                    ⚠️ 它**不是常规功能**，是"混合器储层能否脚本化"这个技术问题的探测器
                   （见 psMixer.ts）。技术问题定案后整块删掉。 */}
                {/* 署名行。⛔ 2026-10-22：这里的「装储层」「混合器探针」两个临时入口已删 ——
                    装储层并进了点击主链（见 psBrush.ts 的 mixer 分支），探针的技术问题也定案了。 */}
                <div className="bs-sign">
                    <span>
                        {TIP_PREFIX}* · 笔尖素材见 brushes/ATTRIBUTION.md
                    </span>
                </div>
            </div>
        </div>
    );
}
