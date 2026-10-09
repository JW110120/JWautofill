import React, { useState, useEffect, useRef, useCallback } from 'react';
import { storage, shell } from 'uxp';
import {
  HotkeyEntry, connectHotkeyDaemon, onConfig, enumerateBrushes,
  onDaemonStatus, pushConfig, requestHotkeyRecording, cancelHotkeyRecording,
  onHotkeyTriggered, onRecordProgress, disconnectDaemon, sendDaemonCommand, registerUninstallHandler,
  registerRepairKeyboardHandler,
  getMainToggleCombo,
  armBackspaceDelete, disarmBackspaceDelete, onBackspaceDelete,
  detectAllBrushTypes
} from './HotkeyBridge';
import { DeleteIcon, RefreshIcon, DataRefreshIcon, RecordCircleIcon, StopSquareIcon, BrushToolIcon, SmudgeToolIcon, MixerToolIcon, CloneStampIcon } from '../styles/Icons';
import BrushSelect, { BrushSelectOption } from './BrushSelect';
import { helpTexts } from '../constants/helpTexts';
import { getFuncHotkeyLabel } from './funcHotkeyDefs';
import { runWhenIdle } from '../utils/psProbe';
import ToggleSwitch from '../components/ToggleSwitch';

// 笔刷热键分区：在调整面板内录制「笔刷 + 快捷键」，持久化到共享配置，
// 由本地守护进程在全局捕获按键后直接切换笔刷，不录制动作。
// 注意：组合键的「录制」由 native 守护进程用 Windows 全局键盘钩子完成，
// UXP 面板只负责选笔刷 + 发指令 + 等结果；面板本身无法稳定捕获键盘事件。
// 注：笔刷选择行用 common.css 的 .row-between（不再用内联 rowStyle / 面板私有类）。
// 「选区填充开关」等非笔刷功能的快捷键已迁出本分区，统一在右上角菜单
// 「功能快捷键」浮窗里管理（见 FuncHotkeyPanel.tsx）；本分区只显示笔刷记录。

// 通知自动消失时间：提示是「瞬时反馈」而非常驻说明，5 秒足够读完，
// 也避免下一次操作后还挂着上一条早已过期的提示（例如刷新完笔刷还显示"请选择"）。
const MESSAGE_TTL_MS = 5000;

// 启动首刷的节奏控制（2026-10-06）：
// BRUSH_LOAD_IDLE_MS  —— 推迟多久再发起首个 get。插件挂载瞬间 PS 仍在处理面板创建
//   与文档初始化，等这个时长避开最密的忙碌窗口。
// INITIAL_LOAD_ATTEMPTS / INITIAL_LOAD_RETRY_MS —— 空结果的重试次数与递增间隔。
//   enumerateBrushes 撞忙碌窗口与「PS 真的没笔刷」都返回 []，无法区分，故做有限重试。
//   次数刻意压得很低：每次重试都是一次宿主命令调用，过多会与用户操作抢通道。
const BRUSH_LOAD_IDLE_MS = 600;
const INITIAL_LOAD_ATTEMPTS = 3;
const INITIAL_LOAD_RETRY_MS = 500;
// 因忙碌而顺延的上限：600ms × 5 ≈ 3s 后宁可冒险执行，也不让首刷永久挂起。
const BRUSH_LOAD_MAX_DEFERRALS = 5;

export default function BrushHotkeySection() {
  const [brushes, setBrushes] = useState<string[]>([]);
  const [brushTypes, setBrushTypes] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [selectedBrush, setSelectedBrush] = useState('');
  // 下拉选中高亮键：value 即笔刷名（去重后唯一），与 selectedBrush 同步。
  const [selectedKey, setSelectedKey] = useState('');
  const [usePicker, setUsePicker] = useState(true);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);
  // 已录快捷键的选中集合：单击单选，Ctrl/Shift + 单击加选或减选，用于单个/批量删除
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 多选锚点（shift 延伸的基准）：普通单击或 Ctrl 单击后更新为该条索引
  const anchorIndexRef = useRef<number>(-1);

  // 长按拖拽排序：拖起的行 id、落点行 id（均用 ref + state 双存，ref 供 document 监听闭包读取最新值）
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropIdRef = useRef<string | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);                 // 本次按下是否触发了拖拽，用于抑制拖完后的单击选中
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const entriesRef = useRef<HotkeyEntry[]>(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  // 退格解绑通路的闭包镜像：handler 在挂载时注册一次，执行时读 ref 拿最新值
  const recordingRef = useRef(recording);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  // 快捷键列表容器：面板内直捕退格用——只有按键目标落在本列表内（行被点击聚焦后）
  // 才劫持退格，避免污染面板里其它输入控件（数字框、拾色器等）。
  const listRef = useRef<HTMLDivElement | null>(null);
  const setDrag = (id: string | null) => { dragIdRef.current = id; setDragId(id); };
  const setDrop = (id: string | null) => { dropIdRef.current = id; setDropId(id); };

  // refs：供轮询读取最新值，避免闭包拿到旧值
  const daemonConnectedRef = useRef(daemonConnected);
  useEffect(() => { daemonConnectedRef.current = daemonConnected; }, [daemonConnected]);
  // 笔刷列表镜像：启动首刷的重试循环要判断「这次枚举是否拿到了笔刷」，
  // 而 setBrushes 是异步的、闭包里的 brushes 仍是旧值，故用 ref 读最新结果。
  const brushesRef = useRef<string[]>(brushes);
  useEffect(() => { brushesRef.current = brushes; }, [brushes]);

  // 通知：统一走这里，5 秒后自动清空。有新通知时重置计时，
  // 保证用户看到的永远是「最近一条操作」的结果。
  const msgTimerRef = useRef<any>(null);
  const showMessage = useCallback((text: string) => {
    if (msgTimerRef.current) { clearTimeout(msgTimerRef.current); msgTimerRef.current = null; }
    setMessage(text);
    if (text) msgTimerRef.current = setTimeout(() => { setMessage(''); msgTimerRef.current = null; }, MESSAGE_TTL_MS);
  }, []);
  useEffect(() => () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); }, []);

  useEffect(() => {
    const unsub = connectHotkeyDaemon();
    const unsubConfig = onConfig((list)  => setEntries(list));
    const unsubStatus = onDaemonStatus(setDaemonConnected);
    // 热键触发即时反馈：用户按快捷键后面板直接显示是否命中、切换是否成功
    // （这是诊断「按了快捷键没反应」的关键观测点：无任何显示 = 事件根本没到达面板）
    const unsubHotkey = onHotkeyTriggered((info) => {
      if (info.action === 'applyBrush') {
        showMessage(info.ok
          ? ('热键触发：' + (info.combo ? info.combo + ' → ' : '') + '已切换笔刷「' + info.brush + '」')
          : ('热键触发失败：' + (info.combo ? info.combo + ' → ' : '') + '切换笔刷「' + info.brush + '」失败，请检查笔刷名是否与 Brushes 面板完全一致'));
      } else if (info.action === 'toggleMain') {
        // 提示必须反映共享总线的真实结果：以前无条件显示「已切换」，
        // 实际上回调在另一个面板上下文里是 null，什么都没切换，误导性极强。
        // （选区填充开关的录制已迁往「功能快捷键」浮窗，但触发反馈仍保留在这里，
        //   因为笔刷热键分区是调整面板里唯一常驻挂载的热键 UI。）
        showMessage('热键触发：' + (info.combo ? info.combo + ' → ' : '') + (info.enabled === undefined
          ? '选区填充开关切换失败'
          : ('选区填充开关已' + (info.enabled ? '开启' : '关闭'))));
      } else if (info.action === 'runFunc') {
        // 功能快捷键（分块平均等）触发反馈：实现在 AdjustmentPanel 注册的执行器里
        showMessage('热键触发：' + (info.combo ? info.combo + ' → ' : '') + '执行「' + getFuncHotkeyLabel(info.brush || '') + '」' + (info.ok ? '' : '失败'));
      }
    });
    // 两段式录制的实时进度：捕获到组合键、等待回车确认期间给出行内提示
    const unsubProgress = onRecordProgress((combo) => {
      showMessage('已捕获 ' + combo + '：回车确认，Esc 取消');
    });
    // ⚠️ 启动首刷必须**推迟到PS 空闲之后**（2026-10-06）。
    //   enumerateBrushes() 内部是`batchPlay get presetManager`，与今天修复的
    //   「易修: 命令"获取"当前不可用」是同一条高危路径：PS 的通知/初始化命令在
    //   执行中途派发，此刻 get 会被宿主拒绝并弹**原生框**（绕过 JS try/catch 与
    //   dialogOptions，唯一有效防护是不发get）。
    //   useEffect 这一刻插件刚挂载、PS 正在处理面板创建与文档初始化，正是忙碌窗口
    //   最容易命中的时刻 —— 表现就是「启动时笔刷列表空，点一下刷新就好了」。
    //   runWhenIdle：忙碌则顺延、绝不硬闯；且同一时刻只跑一个实例（重入直接丢弃）。
    //
    //   detect 仍传 false（保持现状）：类型检测会逐支切换用户当前笔刷，
    //   属改动文档状态的操作，只在用户手动刷新时才做。
    void initialLoadRef.current?.();
    return () => {
      unsub(); unsubConfig(); unsubStatus(); unsubHotkey(); unsubProgress();
      // 卸载时取消待执行的首刷：避免面板已卸载仍发 get（会撞上 PS 忙碌窗口）
      initialLoadRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新枚举笔刷列表 + 自动检测每支预设的类型（混合器/涂抹/画笔…）。
  // detectAllBrushTypes 会短暂切换当前笔刷并自动还原；纯画笔笔尖预设不暴露类型会标「画笔」。
  // notify=false 用于初始化静默加载（不弹通知）。
  // detect=false 时只枚举笔刷名（不切笔刷），用于插件加载等「不能改动用户当前笔刷」的场景；
  // detect=true 才扫描每支预设的类型（会短暂切换笔刷并自动还原），仅手动刷新时触发。
  const loadBrushes = async (notify: boolean, detect: boolean = notify) => {
    if (notify) showMessage('正在刷新笔刷列表…');
    try {
      const names = await enumerateBrushes();
      setBrushes(names);
      setUsePicker(names.length > 0);
      if (names.length) {
        if (detect) {
          const types = await detectAllBrushTypes();
          setBrushTypes(types);
        } else {
          setBrushTypes({});
        }
      } else {
        setBrushTypes({});
      }
      // 只陈述结果，不再附加「请选择」这类会被下一次操作立刻推翻的引导语
      if (notify) {
        showMessage(names.length
          ? ('已刷新笔刷列表，共 ' + names.length + ' 支（已自动检测类型）')
          : '仍未枚举到笔刷，已切换为手动输入');
      }
    } catch {
      setBrushes([]); setUsePicker(false);
      if (notify) showMessage('枚举笔刷失败，可手动输入笔刷名（需与 PS 完全一致）');
    }
  };

  /**
   * 启动时的笔刷列表首刷：**空闲后执行 + 空结果静默重试**。
   *
   * 为何需要重试：`enumerateBrushes()` 走 batchPlay get，撞上 PS 忙碌窗口时会被拒绝
   * 并返回 `[]`，与「PS 确实没有笔刷预设」无法区分。启动期最容易命中（面板刚创建、
   * 文档正在初始化），于是列表空、用户点一下刷新才正常。
   *
   * 约束（务必保持）：
   *  1. **全程 notify=false** —— 静默失败/重试不弹提示，只有用户手动刷新才给反馈；
   *  2. **不无限重试**：最多 INITIAL_LOAD_ATTEMPTS 次、间隔递增，避免持续占用宿主命令通道；
   *  3. **不自动检测类型**（detect 恒 false）：类型检测会逐支切换用户当前笔刷，
   *     属改动文档状态的操作，保留为「手动刷新」专属（经用户确认保持现状）。
   *
   * 用 ref 持有调度器而非 const：`runWhenIdle` 在每次渲染都会返回新函数，
   * 直接用 const 既是 TDZ 隐患（useEffect 回调在声明前定义）也会在重渲染时丢调度。
   */
  const initialLoadRef = useRef<(() => void) & { cancel: () => void } | null>(null);
  if (!initialLoadRef.current) {
    initialLoadRef.current = runWhenIdle(async () => {
      for (let attempt = 1; attempt <= INITIAL_LOAD_ATTEMPTS; attempt++) {
        await loadBrushes(false, false);
        // 拿到笔刷即成功，结束重试（brushesRef 读最新值，setBrushes 是异步的）
        if (brushesRef.current.length) {
          console.log(`[笔刷列表] 启动首刷成功（第 ${attempt} 次尝试，共 ${brushesRef.current.length} 支）`);
          return;
        }
        if (attempt < INITIAL_LOAD_ATTEMPTS) {
          const wait = attempt * INITIAL_LOAD_RETRY_MS;
          console.log(`[笔刷列表] 启动首刷为空（第 ${attempt} 次），${wait}ms 后重试——疑似撞上 PS 忙碌窗口`);
          await new Promise<void>(r => setTimeout(r, wait));
        }
      }
      console.warn('[笔刷列表] 启动首刷重试后仍为空：可能 PS 确实未安装笔刷预设，或持续处于忙碌状态；点「刷新笔刷列表」可重试');
      // BRUSH_LOAD_MAX_DEFERRALS：顺延上限。必须有限——否则 PS 持续忙碌时首刷会被
      //   无限推迟，「启动后笔刷列表一直为空」；超限后宁可冒险执行一次也不能不加载。
    }, BRUSH_LOAD_IDLE_MS, BRUSH_LOAD_MAX_DEFERRALS);
  }

  // 将插件内相对路径解析为真实 OS 路径：用 getPluginFolder().nativePath，
  // 绕开沙箱下 getEntry('native') 找不到目录的问题。
  const getBundledNativePath = async (relPath: string): Promise<string | null> => {
    const folder: any = await storage.localFileSystem.getPluginFolder();
    const root: string = folder?.nativePath;
    if (!root) return null;
    const sep = root.includes('\\') ? '\\' : '/';
    const parts = relPath.split('/').filter(Boolean);
    return [root, ...parts].join(sep);
  };

  // 用 shell.openPath 唤起插件目录内的某个文件（exe/bat）。成功返回空串，失败返回错误串。
  const openBundled = async (relPath: string): Promise<boolean> => {
    const full = await getBundledNativePath(relPath);
    if (!full) {
      showMessage('无法定位插件目录，请手动在插件目录 ' + relPath + ' 处双击运行');
      return false;
    }
    const r: any = await shell.openPath(full);
    if (typeof r === 'string' && r.length > 0) {
      showMessage('唤起失败：' + r + '（可手动双击插件目录下的 ' + relPath.split('/').pop() + '）');
      return false;
    }
    return true;
  };

  // 「加载守护进程」：直接静默拉起守护进程 exe（已编译为 Windows GUI 子系统，无控制台窗口）。
  // 守护进程自身完成「拷贝到安装目录 + 注册开机自启」，全程无窗口；
  // 加载进度与结果一律走面板文字通知（下方 showMessage），不再弹任何 cmd/PowerShell 窗口。
  const loadDaemon = async () => {
    if (busy) return;
    if (daemonConnectedRef.current) { showMessage('快捷键服务已在运行'); return; }
    setBusy(true);
    try {
      const ok = await openBundled('native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
      if (!ok) {
        showMessage('启动失败：未找到快捷键服务，请手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
        return;
      }
      showMessage('正在启动快捷键服务…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (daemonConnectedRef.current) { showMessage('快捷键服务已就绪'); return; }
      }
      showMessage('未检测到快捷键服务：请稍后重试，或手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe');
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : (typeof e === 'string' ? e : JSON.stringify(e));
      showMessage('启动快捷键服务失败：' + msg + '（可手动双击插件目录 native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe）');
    } finally {
      setBusy(false);
    }
  };

  // 「断开守护进程」：让守护进程自己优雅退出。
  // 这是卸载前必须的准备动作——卸载脚本要删安装目录，而运行中的 exe 会锁住目录里的日志文件。
  const stopDaemon = async () => {
    if (busy) return;
    if (!disconnectDaemon()) { showMessage('当前未连接到快捷键服务，无需停止'); return; }
    setBusy(true);
    showMessage('正在停止快捷键服务…');
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!daemonConnectedRef.current) { showMessage('快捷键服务已停止（快捷键已停止生效，此时可安全卸载）'); return; }
      }
      showMessage('快捷键服务无响应，请稍后重试；若仍无法停止，请重启电脑后再卸载。');
    } finally {
      setBusy(false);
    }
  };

  // 卸载：低频操作，入口在面板右上角菜单里（见 MenuManager / AdjustmentMenu）。
  // 优先走静默通道：直接让守护进程自删（移除开机自启 + 删除安装目录 + 退出），无窗口；
  // 仅在未连接守护进程（无法发指令）时，才退回到会弹窗的脚本方式。
  const uninstallDaemon = async (): Promise<string> => {
    if (daemonConnectedRef.current) {
      showMessage('正在卸载快捷键服务…');
      const sent = sendDaemonCommand('uninstall');
      if (sent) {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (!daemonConnectedRef.current) {
            const ret = '已卸载快捷键服务：开机自启已移除，安装目录已删除。';
            showMessage(ret);
            return ret;
          }
        }
        const ret = '卸载指令已发送但快捷键服务未退出，请稍后重试，或手动删除安装目录。';
        showMessage(ret);
        return ret;
      }
      // 已连接却发指令失败：落到脚本兜底
    }
    showMessage('未连接到快捷键服务，改用脚本卸载…');
    let ok = false;
    try { ok = await openBundled('native/HotkeyDaemon/uninstall.bat'); } catch (err: any) {
      console.error('唤起内置卸载程序失败:', err);
    }
    if (!ok) {
      const ret = '插件目录内未找到卸载脚本，请手动双击 native/HotkeyDaemon/uninstall.bat';
      showMessage(ret);
      return ret;
    }
    showMessage('卸载程序已打开，请在弹出的窗口中查看结果。');
    return '卸载程序已打开，请在弹出的窗口中查看结果。';
  };

  // 「键盘卡死一键修复」：当系统键盘被某个全局钩子拖住（打不出字）时的自救入口。
  // 设计要点：
  //   1) 修复脚本全程无交互——键盘卡死时用户根本无法输入，所以绝不等待按键；
  //   2) 除了「停止服务 + 复位系统键盘钩子超时设置 + 释放卡住的修饰键」，还会对键盘设备
  //      做软重置（程序化重新插拔，覆盖 HID/USB 设备层冻结）并关闭 USB 省电策略；
  //      设备重置需要管理员权限，脚本会自动弹 UAC（UAC 用鼠标点击即可，不依赖键盘）；
  //      不删除热键配置与程序文件，修复后可随时重新启动快捷键服务；
  //   3) 这里也不弹确认框，因为键盘失效时确认框同样难以操作。
  const repairKeyboard = async (): Promise<string> => {
    // 先让守护进程优雅退出（若还连着），确保它的全局键盘钩子被正常卸载
    if (daemonConnectedRef.current) {
      try { disconnectDaemon(); } catch { /* 优雅退出失败也无妨，脚本会强制结束进程 */ }
      await new Promise(r => setTimeout(r, 600));
    }
    showMessage('正在修复键盘…若弹出管理员授权窗口，请点击「是」');
    let ok = false;
    // ⚠️ 唤起 .exe 而非 .bat：UXP 的 shell.openPath 对 .bat/.ps1 只会「用编辑器打开而非执行」，
    // 对 .exe 才会真正运行并弹出可见控制台窗口。FixKeyboard.exe 内部再调用 fix-keyboard.ps1。
    try { ok = await openBundled('native/HotkeyDaemon/FixKeyboard.exe'); } catch (err: any) {
      console.error('唤起键盘修复工具失败:', err);
    }
    if (!ok) {
      // 兜底：唤起失败时打开工具所在目录，鼠标双击 FixKeyboard.exe 即可（键盘卡死时只有鼠标可用）
      try {
        const dir = await getBundledNativePath('native/HotkeyDaemon');
        if (dir) await shell.openPath(dir);
      } catch { /* 目录打不开就只能提示手动操作 */ }
      const ret = '未找到/无法唤起键盘修复工具，已为你打开工具所在目录；若未弹出请手动双击 native/HotkeyDaemon/FixKeyboard.exe';
      showMessage(ret);
      return ret;
    }
    const ret = '键盘修复已执行：快捷键服务已停止，键盘设备已软重置（程序化重新插拔），USB 省电策略已关闭。请立即测试键盘；热键配置已保留。';
    showMessage(ret);
    return ret;
  };

  // 供右上角菜单调用（菜单回调注册在 AdjustmentPanel 里，具体实现留在本组件）
  useEffect(() => {
    registerUninstallHandler(uninstallDaemon);
    registerRepairKeyboardHandler(repairKeyboard);
  }, []);

  // 录制由 native 守护进程完成（Windows 全局键盘钩子），UXP 只发指令并等待结果。
  // 两段式：按下组合键 → 回车确认（Esc 取消，见 HotkeyBridge.requestHotkeyRecording）。
  // 冲突策略（与「功能快捷键」浮窗一致）：新组合键被任何已有条目（其它笔刷 / 主开关 /
  // 功能快捷键）占用时只提示、不覆盖——两边唯一关联就是占用提示，配置互不侵扰。
  const startRecord = async () => {
    if (!selectedBrush) { showMessage('请先在左侧选择一支笔刷'); return; }
    if (!daemonConnected) { showMessage('快捷键服务未连接，无法录制（请先启动快捷键服务）'); return; }
    const mainCombo = getMainToggleCombo();
    setRecording(true);
    showMessage('正在录制「' + selectedBrush + '」：请按下要绑定的组合键，回车确认，Esc 取消');
    const res = await requestHotkeyRecording(selectedBrush);
    setRecording(false);
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    if (mainCombo && combo === mainCombo) {
      showMessage('该组合键已被选区填充开关占用，请换一个');
      return;
    }
    const dup = entries.find(e => e.combo === combo);
    if (dup) {
      if (dup.action === 'applyBrush' && dup.brush === selectedBrush) {
        showMessage('该组合键已绑定到「' + selectedBrush + '」，无需重复录制');
        return;
      }
      showMessage('该组合键已被「' + entryDisplayName(dup) + '」占用，请换一个');
      return;
    }
    // 注意：不支持同名笔刷——只按名称绑定，PS 会选中 Brushes 列表最上方那支同名项。
    const entry: HotkeyEntry = { id: 'bk_' + Date.now(), combo, action: 'applyBrush', brush: selectedBrush };
    const next = [...entries, entry];
    setEntries(next);
    if (pushConfig(next)) showMessage('已保存：' + combo + ' → ' + selectedBrush);
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };

  // 用户主动取消当前录制
  const cancelRecord = () => {
    cancelHotkeyRecording();
    setRecording(false);
    showMessage('已取消录制');
  };

  // 多选逻辑对齐 PS 原生图层：
  // - 普通单击：仅选中该条，并把锚点设为它；
  // - Ctrl/Meta + 单击：在已选集合里对该单条加选/减选（toggle），并把锚点设为它；
  // - Shift + 单击：选中「锚点 ~ 当前」之间的所有记录（含两端），锚点保持不变以便继续延伸。
  const handleEntryClick = (id: string, ev: React.MouseEvent) => {
    // 行可聚焦：点击即聚焦，让随后的退格落在本列表容器内（面板内直捕退格的焦点依据）
    (ev.currentTarget as HTMLElement).focus();
    // 本次按下触发了长按拖拽：松开后的单击只应结束拖拽，不应再选中该行
    if (didDragRef.current) { didDragRef.current = false; return; }
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return;
    if (ev.shiftKey && anchorIndexRef.current >= 0) {
      const a = anchorIndexRef.current;
      const [lo, hi] = a <= idx ? [a, idx] : [idx, a];
      setSelectedIds(entries.slice(lo, hi + 1).map(e => e.id));
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
      anchorIndexRef.current = idx;
      return;
    }
    setSelectedIds([id]);
    anchorIndexRef.current = idx;
  };

  // 条目在冲突提示里的显示名：主开关 / 功能快捷键 / 笔刷统一在这里翻译
  const entryDisplayName = (e: HotkeyEntry): string => {
    if (e.action === 'toggleMain') return '选区填充开关';
    if (e.action === 'runFunc') return getFuncHotkeyLabel(e.brush || '');
    return e.brush || '';
  };

  // 重录指定条目（双击行或选中单条后点重录按钮共用）：直接对该条目的笔刷发起一次新的录制，
  // 无需回到上方下拉菜单重新选择。待确认阶段按退格不再有特殊语义（守护进程已禁绑退格）；
  // 解绑走「单击选中 + 退格」的布防通路（见下方 onBackspaceDelete）。
  const reRecordEntryById = async (target: HotkeyEntry) => {
    if (recording) return;
    if (!daemonConnected) { showMessage('快捷键服务未连接，无法录制（请先启动快捷键服务）'); return; }
    const mainCombo = getMainToggleCombo();
    setRecording(true);
    showMessage('正在重录「' + target.brush + '」：请按下新的组合键，回车确认，Esc 取消');
    const res = await requestHotkeyRecording(target.brush);
    setRecording(false);
    if (!res) { showMessage('已取消录制'); return; }
    const combo = res.combo;
    // 冲突检查：新组合键是否被其它条目（主开关/功能快捷键/其它笔刷）占用？占用则提示并放弃本次重录
    if (mainCombo && combo === mainCombo && target.combo !== mainCombo) {
      showMessage('该组合键已被选区填充开关占用，请换一个');
      return;
    }
    const dup = entries.find(e => e.id !== target.id && e.combo === combo);
    if (dup) {
      showMessage('该组合键已被「' + entryDisplayName(dup) + '」占用，请换一个');
      return;
    }
    const next = entries.map(e => (e.id === target.id ? { ...e, combo } : e));
    setEntries(next);
    if (pushConfig(next)) showMessage('已重录：' + combo + ' → ' + target.brush);
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };

  // 重录选中单条（重录图标按钮入口）。仅当恰好选中一条时可用。
  const reRecordEntry = async () => {
    if (selectedIds.length !== 1) return;
    const target = entries.find(e => e.id === selectedIds[0]);
    if (!target) return;
    await reRecordEntryById(target);
  };

  // 条目被删除/解绑/守护进程回灌配置后，剔除已不存在的选中项，避免选中数虚高
  useEffect(() => {
    setSelectedIds(prev => {
      const next = prev.filter(id => entries.some(e => e.id === id));
      return next.length === prev.length ? prev : next; // 无变化则返回原引用，避免无谓重渲染
    });
  }, [entries]);

  // 下拉选中键与真实笔刷名对齐（value 即笔刷名）：手动输入笔刷名等场景下回灌选中高亮。
  useEffect(() => {
    if (selectedBrush && !selectedKey) {
      setSelectedKey(selectedBrush);
    }
  }, [selectedBrush, selectedKey]);

  // 选中项里真正"可处理"的条数：本分区只显示笔刷条目，全部可删除
  const deletableCount = selectedIds.length;

  // ===== 退格解绑（「单击选中 + 非录制态按退格」通路，与功能快捷键浮窗同款交互）=====
  // 语义与删除按钮刻意区分：退格 = 组合键置空、条目保留在列表（显示「未绑定」）；
  // 删除按钮 = 整条移除。仅在恰好选中一条且不在录制中时布防生效。
  useEffect(() => {
    if (selectedIds.length === 1 && !recording) armBackspaceDelete('brush');
    else disarmBackspaceDelete('brush');
  }, [selectedIds, recording]);
  useEffect(() => () => disarmBackspaceDelete('brush'), []);
  const unbindByBackspace = () => {
    if (recordingRef.current) return;
    const ids = selectedIdsRef.current;
    if (ids.length !== 1) return;
    const target = entriesRef.current.find(e => e.id === ids[0]);
    if (!target || target.action !== 'applyBrush') return;
    if (!target.combo) { showMessage('该条目尚未绑定快捷键'); return; }
    const next = entriesRef.current.map(e => (e.id === target.id ? { ...e, combo: '' } : e));
    setEntries(next);
    if (pushConfig(next)) showMessage('已解绑「' + target.brush + '」的快捷键（条目已保留）');
    else showMessage('推送配置失败（快捷键服务未运行？）');
  };
  useEffect(() => onBackspaceDelete((owner) => {
    if (owner !== 'brush') return; // 只认领自己的布防
    unbindByBackspace();
  }), []);

  // 面板内直捕退格（不依赖守护进程布防，reload 即生效）：行被点击聚焦后，
  // 按键目标在本列表容器内 → 退格解绑选中条。与布防通路互斥不重复：
  // 新版守护进程会在低层钩子里吞掉退格并回传 backspaceDelete（此时 UXP 收不到按键事件）；
  // 旧版守护进程放行按键，由本监听兜底。
  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace') return;
      const list = listRef.current;
      if (!list || !list.contains(e.target as Node)) return; // 焦点不在本列表内不劫持
      if (selectedIdsRef.current.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      unbindByBackspace();
    };
    document.addEventListener('keydown', onDocKeyDown, { capture: true } as any);
    return () => document.removeEventListener('keydown', onDocKeyDown, { capture: true } as any);
  }, []);

  // 批量删除选中项：删除笔刷条目并落盘（pushConfig 同步 bridge 缓存）
  const removeSelectedEntries = () => {
    if (selectedIds.length === 0) return;
    const brushIds = entries.filter(e => selectedIds.includes(e.id)).map(e => e.id);
    if (brushIds.length === 0) { showMessage('选中的条目无需处理'); return; }
    setSelectedIds([]);
    const next = entries.filter(e => !brushIds.includes(e.id));
    setEntries(next);
    pushConfig(next);
    showMessage('已删除 ' + brushIds.length + ' 条快捷键');
  };

  // 把检测到的中文类型渲染成对应图标；其它类型（橡皮擦等）无专用图标则回退显示文字，
  // 空串则不显示任何 tag。
  // ---- 长按拖拽排序（本分区只有笔刷记录，全部可拖） ----
  const startPress = (e: React.MouseEvent, entry: HotkeyEntry) => {
    didDragRef.current = false;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    if (pressTimerRef.current != null) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
    pressTimerRef.current = window.setTimeout(() => {
      setDrag(entry.id);
      setDrop(entry.id);
      didDragRef.current = true; // 进入拖拽：松开后不应再触发单击选中
    }, 300);
  };

  const onRowMove = (e: React.MouseEvent) => {
    // 长按计时未触发前若发生明显移动（如滑动），取消长按，避免误触拖拽
    if (pressTimerRef.current != null && pressStartRef.current) {
      const dx = Math.abs(e.clientX - pressStartRef.current.x);
      const dy = Math.abs(e.clientY - pressStartRef.current.y);
      if (dx > 4 || dy > 4) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    }
  };

  const endPress = () => {
    if (pressTimerRef.current != null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  // 拖拽进行中：document 级监听实时计算落点并落盘重排（参考渐变色标拖拽的 document 监听写法）
  useEffect(() => {
    if (dragId == null) return;
    const onMove = (ev: MouseEvent) => {
      let targetId: string | null = null;
      for (const id of Object.keys(rowRefs.current)) {
        const el = rowRefs.current[id];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) { targetId = id; break; }
      }
      // 落点行：悬停其上时更新落点（虚线提示）
      if (targetId && targetId !== dropIdRef.current) setDrop(targetId);
    };
    const onUp = () => {
      const fromId = dragIdRef.current;
      const toId = dropIdRef.current;
      setDrag(null);
      setDrop(null);
      if (!fromId || !toId || fromId === toId) { didDragRef.current = true; return; }
      const list = entriesRef.current;
      const fromIdx = list.findIndex(e => e.id === fromId);
      const toIdx = list.findIndex(e => e.id === toId);
      if (fromIdx < 0 || toIdx < 0) { didDragRef.current = true; return; }
      const next = [...list];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      setEntries(next);
      pushConfig(next);
      didDragRef.current = true; // 抑制随后的单击选中
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragId]);

  const brushTypeTag = (type: string): React.ReactNode => {
    switch (type) {
      case '画笔': return <BrushToolIcon />;
      case '混合器画笔': return <MixerToolIcon />;
      case '涂抹': return <SmudgeToolIcon />;
      case '图案图章': return <CloneStampIcon />;
      case '': return '';
      default: return type;
    }
  };

  // 不支持同名笔刷（PS 按 _name 选中只会命中列表最上方那支，无法区分重名预设，
  // 详见用户手册）。下拉里每个笔刷名只显示一次：value 直接用笔刷名（去重后唯一）。
  const brushOptions: BrushSelectOption[] = Array.from(new Set(brushes)).map(b => ({
    value: b,
    main: b,
    // 笔刷类型（混合器/涂抹/画笔/图案图章…）渲染为图标；取不到类型则该项无 tag
    tag: brushTypeTag(brushTypes[b] || '')
  }));

  // 渲染顺序：本分区只显示笔刷记录（applyBrush），按存储顺序展示。
  // ⚠️ 必须是白名单过滤而不是「排除 toggleMain」：配置是共享的，功能快捷键（runFunc）
  // 条目也在同一份配置里，漏过滤会把「分块平均」之类的功能记录串进笔刷列表。
  // 「选区填充开关」与功能按钮的快捷键在右上角菜单「功能快捷键」浮窗里管理。
  const displayEntries = entries.filter(e => e.action === 'applyBrush');

  return (
    <>
      {/* 守护进程状态条：与「蒙版同步」的引擎状态条同一套视觉，左侧状态点+文字，右侧操作按钮。
          外描边随状态变化：ok=绿 / warn=橙（common.css 的 .notify-bar-ok/warn） */}
      <div className={daemonConnected ? 'notify-bar notify-bar-ok' : 'notify-bar notify-bar-warn'}>
        <span className={daemonConnected ? 'indicator indicator-md indicator-ok' : 'indicator indicator-md indicator-warn'} />
        <span className="notify-text">
          {daemonConnected ? '服务已就绪' : (busy ? '服务处理中…' : '服务未启动')}
        </span>
        <span className="mask-sync-status-spacer" />
        {/* 与 APP 面板「紧凑 + 专注」状态条统一：右侧改用 sp-switch 代替「启动/停止服务」文字按钮。
            开关状态即服务连接状态；服务处理中（busy）时禁用，避免重复触发。 */}
        <ToggleSwitch checked={daemonConnected} disabled={busy} onChange={() => { if (!busy) { if (daemonConnected) void stopDaemon(); else void loadDaemon(); } }} title={daemonConnected ? helpTexts.hotkey.daemonStop : helpTexts.hotkey.daemonStart}  />
      </div>

      <div className="row-between">
        {usePicker ? (
          <BrushSelect
            value={selectedKey}
            options={brushOptions}
            onChange={(v) => {
              // value 即笔刷名（去重后唯一），直接作为录制用的真实笔刷名
              setSelectedBrush(v);
              setSelectedKey(v);
            }}
            placeholder="选择笔刷"
            title={helpTexts.hotkey.brushSelect}
          />
        ) : (
          <sp-textfield size="s" className="field-grow" placeholder="输入笔刷预设名（需与 PS 完全一致）"
            value={selectedBrush} onInput={(e: any) => setSelectedBrush(e.target.value)} />
        )}
        {/* 三个图标共用一个固定宽度大容器：下拉自由伸缩，图标组恒为 3×28px，
            录制键恒在最右格；停止键出现/消失在预留的中间格子内，
            因此刷新与录制都不会位移，三者间距也始终一致 */}
        <div className="row-end">
          <div className="hotkey-icon-cell">
            {usePicker && (
              <div
                className="icon-button"
                onClick={() => void loadBrushes(true)}
                title={helpTexts.hotkey.refreshBrushes}
              >
                <RefreshIcon className="icon-14" />
              </div>
            )}
          </div>
          <div className="hotkey-icon-cell">
            <div
              role="button"
              tabIndex={0}
              className={recording ? 'record-button' : 'record-button-disabled'}
              title={recording ? helpTexts.hotkey.recordCancelActive : helpTexts.hotkey.recordCancelIdle}
              onClick={(e) => { e.stopPropagation(); if (recording) cancelRecord(); }}
            >
              <StopSquareIcon className="icon-14" />
            </div>
          </div>
          <div className="hotkey-icon-cell">
            <div
              role="button"
              tabIndex={0}
              className={!selectedBrush ? 'record-button-disabled' : recording ? 'record-button-recording' : 'record-button'}
              title={helpTexts.hotkey.recordHint}
              onClick={(e) => {
                e.stopPropagation();
                if (!recording && selectedBrush) void startRecord();
              }}
            >
              <RecordCircleIcon className="icon-14" />
            </div>
          </div>
        </div>
      </div>
      {!usePicker && (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
          未能自动枚举笔刷，已切换为手动输入；点「录制快捷键」前请先填好笔刷名（需与 PS 完全一致）。
        </div>
      )}

      {/* 所有录好的快捷键都装在一个边框可见的大容器里（common.css 的 .border-panel-section）；
          删除键移到容器外的右下角，见下方 .row-between */}
      <div className="border-panel-section" ref={listRef}>
          {displayEntries.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>尚未绑定任何笔刷快捷键</div>}
          {displayEntries.map(e => {
            const rowClass = [
              'hotkey-entry-row',
              selectedIds.includes(e.id) ? 'selected' : '',
              dragId === e.id ? 'dragging' : '',
              (dropId === e.id && dragId !== null && dragId !== e.id) ? 'drop-target' : '',
            ].join(' ');
            return (
            <div
              key={e.id}
              ref={(el) => { rowRefs.current[e.id] = el; }}
              className={rowClass}
              title={helpTexts.hotkey.entryNormal}
              tabIndex={0}
              onClick={(ev) => handleEntryClick(e.id, ev)}
              onDoubleClick={(ev) => { ev.stopPropagation(); void reRecordEntryById(e); }}
              onMouseDown={(ev) => startPress(ev, e)}
              onMouseUp={endPress}
              onMouseMove={onRowMove}
            >
              {/* 名称在左、快捷键在右（与「功能快捷键」浮窗一致）：分隔线居中，两列各占一半 */}
              <span className="hotkey-entry-name">{e.brush}</span>
              <span className="divider-vertical">丨</span>
              <span className="hotkey-entry-combo">{e.combo || '未绑定'}</span>
            </div>
            );
          })}
      </div>

      {/* 选中条数提示 + 重录 + 删除：列表大容器外右下角，说明文字上方。
          左侧「已选中 N 条」左对齐；右侧重录（仅选中单条时）与删除图标按钮相邻 */}
      <div className="row-between">
        <span className="hotkey-selected-count">已选中 {selectedIds.length} 条</span>
        <div className="row-end">
          <div
            role="button"
            tabIndex={0}
            className={(selectedIds.length !== 1 || recording || !daemonConnected) ? 'icon-button-disabled' : 'icon-button'}
            style={{ marginRight: 4 }}
            title={selectedIds.length === 1 ? helpTexts.hotkey.reRecordOne : helpTexts.hotkey.reRecord}
            onClick={() => { if (selectedIds.length === 1 && !recording && daemonConnected) void reRecordEntry(); }}
          >
            <DataRefreshIcon className="icon-14" />
          </div>
          <div
            role="button"
            tabIndex={0}
            className={deletableCount ? 'icon-button' : 'icon-button-disabled'}
            title={deletableCount
              ? ('删除选中的 ' + deletableCount + ' 条快捷键')
              : '请先在上方单击选中要删除的快捷键'}
            onClick={() => removeSelectedEntries()}
          >
            <DeleteIcon className="icon-14" />
          </div>
        </div>
      </div>

      {/* 底部文字通知：与面板顶部「激活提示」同款横幅（common.css 的 .status-banner），
          容器 + 状态点 + 12px 正文一致；ok=绿点（服务就绪时）、warn=橙点（未启动/处理中）。 */}
      {message && (
        <div className={daemonConnected ? 'status-banner status-banner-ok' : 'status-banner status-banner-warn'}>
          <span className={daemonConnected ? 'indicator indicator-md indicator-ok' : 'indicator indicator-md indicator-warn'} />
          <span className="notify-text">{message}</span>
        </div>
      )}
    </>
  );
}
