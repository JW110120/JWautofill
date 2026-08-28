// 模拟 UXP 端与守护进程的 WebSocket 通信，验证 config 推送 -> 落盘 -> 广播链路
const ws = new WebSocket('ws://127.0.0.1:18923');
const log = (m) => console.log('[test] ' + m);

ws.onopen = () => {
  log('connected');
  ws.send(JSON.stringify({ type: 'getConfig' }));
};
ws.onmessage = (e) => {
  log('recv: ' + e.data);
};
ws.onclose = () => log('closed');
ws.onerror = (e) => log('error: ' + (e.message || e));

// 500ms 后推送一条与 UXP 端完全相同结构的配置（小写键名）
setTimeout(() => {
  log('sending config push (lowercase keys, same as UXP pushConfig)');
  ws.send(JSON.stringify({ type: 'config', payload: [
    { id: 'bk_test', combo: 'Ctrl+Alt+K', action: 'applyBrush', brush: '多线混合' }
  ]}));
}, 500);

// 1500ms 后再拉一次配置，看守护进程回传什么
setTimeout(() => {
  log('sending getConfig again');
  ws.send(JSON.stringify({ type: 'getConfig' }));
}, 1500);

setTimeout(() => { log('done'); process.exit(0); }, 3000);
