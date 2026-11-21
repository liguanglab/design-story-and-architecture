// 复现：生成中途断网 15 秒 → 恢复后是否续写、界面是否有"网络中断/重连"提示
//
// 前置：
//   1) 一个已登录 Flowith 的 Chromium 以 --remote-debugging-port=4311 启动，打开目标画布
//   2) 本机有可用的代理（默认 <本地代理端口>），且能通过它访问 beta.flowith.io
//   3) 有 canvas-cowork 仓库（用于读 credits）：设 CW_DIR 与 BUN
//
// 用法：
//   set CW_DIR=<本机路径>  （Windows）
//   set BUN=bun
//   node repro-netdrop.mjs --port=4311 --canvas=<convId> --cut-ms=15000
//   node repro-netdrop.mjs --port=4311 --canvas=<convId> --proxy-cmd="taskkill /F /IM mihomo.exe"
//
// 说明：断网指令依赖本机代理实现，用 --proxy-cmd / --restore-cmd 指定即可（默认按 mihomo 处理）。
//       没有 canvas-cowork 时仍可跑，只是不打印花费。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = args.port || '4311';
const CANVAS = args.canvas;
const CUT_MS = Number(args['cut-ms'] || 15000);
const PROXY_CMD = args['proxy-cmd'] || '';
const RESTORE_CMD = args['restore-cmd'] || '';
const BUN = process.env.BUN || 'bun';
const CW = process.env.CW_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CANVAS) { console.error('缺少 --canvas=<convId>'); process.exit(2); }
const cw = (a) => {
  if (!CW) return '';
  const r = spawnSync(BUN, ['scripts/index.ts', ...a], { cwd: CW, encoding: 'utf8', timeout: 120000 });
  return (r.stdout || '') + (r.stderr || '');
};
const credits = () => { try { return JSON.parse(cw(['credits'])).credits; } catch { return null; } };

async function attach(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } };
  await new Promise((r) => { ws.onopen = r; });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result?.value; };
  return { ws, send, ev };
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = list.find((t) => t.type === 'page' && /conv\//.test(t.url)) || list.find((t) => t.type === 'page');
if (!pg) { console.error('没有可用页面'); process.exit(2); }
const c = await attach(pg.webSocketDebuggerUrl);
await c.send('Page.navigate', { url: `https://beta.flowith.io/conv/${CANVAS}` });
for (let i = 0; i < 15; i++) { await sleep(4000); if ((await c.ev('(document.body.innerText||"").length')) > 200) break; }

const c0 = credits();
console.log('起始 credits=', c0);

await c.ev(`(() => { const e = document.querySelector('[contenteditable=true],textarea'); if (e) e.focus(); return true; })()`);
await c.send('Input.insertText', { text: '断线复现：请写 300 字关于雨天的短文，直接输出正文。' });
await sleep(600);
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

const base = (await c.ev('document.body.innerText')).length;
let started = null;
for (let i = 1; i <= 40; i++) { await sleep(1000); if ((await c.ev('document.body.innerText')).length > base + 30) { started = i; break; } }
console.log('流式开始于第', started, '秒');

if (PROXY_CMD) { console.log('执行断网命令:', PROXY_CMD); spawnSync('cmd', ['/c', PROXY_CMD], { windowsHide: true }); }
else console.log('⚠️ 没给 --proxy-cmd，请手动断开网络', CUT_MS, '毫秒');
await sleep(CUT_MS);
const cutLen = (await c.ev('document.body.innerText')).length;
const hintAtCut = await c.ev(`/网络|重连|连接中断/.test(document.body.innerText)`);
console.log('断网结束时字数=', cutLen, '｜界面有网络提示=', hintAtCut);

if (RESTORE_CMD) { console.log('执行恢复命令:', RESTORE_CMD); spawnSync('cmd', ['/c', RESTORE_CMD], { windowsHide: true }); }
else console.log('⚠️ 没给 --restore-cmd，请手动恢复网络');
await sleep(3000);

let firstGrowth = null;
for (let i = 1; i <= 24; i++) {
  await sleep(5000);
  const len = (await c.ev('document.body.innerText')).length;
  if (len > cutLen + 20 && firstGrowth === null) { firstGrowth = i * 5; break; }
}
const body = await c.ev('document.body.innerText');
const c1 = credits();
const result = {
  canvas: CANVAS, cutMs: CUT_MS, started, cutLen, firstGrowth,
  finalLen: body.length,
  complete: !/琢磨中|生成中/.test(body),
  networkHintSeen: hintAtCut || /网络|重连|连接中断/.test(body),
  cost: c0 != null && c1 != null ? +(c0 - c1).toFixed(2) : null,
};
fs.writeFileSync(path.join(process.cwd(), 'repro-netdrop-result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
c.ws.close();
