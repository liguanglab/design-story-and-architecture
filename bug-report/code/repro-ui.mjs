#!/usr/bin/env node
// Flowith 画布并发写入 · 最小复现脚本（UI 层）
//
// 用途：证明"同一张卡被两个窗口同时提交不同位置时，后端两个请求都 2xx，
//       请求/响应里没有任何版本或条件字段，最终只剩一份位置"。
//
// 前置：
//   1) 用 --remote-debugging-port=4311 启动一个已登录 Flowith 的 Edge/Chrome
//   2) 打开目标画布（URL 里带 conv/{id}），确认画布上有一张卡
//   3) node repro-ui.mjs --canvas=<convId> --card="卡片标题关键字"
//
// 产物：race-<时间>.json（两端 payload、请求头、响应码），控制台给出判定。

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = args.port || '4311';
const CANVAS = args.canvas;
const CARD_TEXT = args.card || '';
if (!CANVAS) { console.error('缺少 --canvas=<convId>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const events = [];
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } else if (msg.method) events.push(msg); };
  await new Promise((r) => { ws.onopen = r; });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result?.value; };
  return { ws, send, ev, events };
}

async function newTab() {
  const url = `http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent(`https://beta.flowith.io/conv/${CANVAS}`);
  const t = await (await fetch(url, { method: 'PUT' })).json();
  const c = await attach(t.webSocketDebuggerUrl);
  await c.send('Network.enable');
  for (let i = 0; i < 12; i++) { await sleep(4000); if ((await c.ev('(document.body.innerText||"").length')) > 200) break; }
  return c;
}

const center = (c) => c.ev(`(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const kw = ${JSON.stringify(CARD_TEXT)};
  const el = [...document.querySelectorAll('div')].filter(e => norm(e.innerText).includes(kw)).sort((a,b)=>norm(a.innerText).length - norm(b.innerText).length)[0];
  if (!el) return null;
  let card = el;
  for (let i = 0; i < 6 && card.parentElement; i++) { const r = card.getBoundingClientRect(); if (r.width > 200 && r.height > 100) break; card = card.parentElement; }
  const r = card.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`);

const drag = async (c, dx, dy) => {
  const b = await center(c);
  if (!b) return 'card-not-found';
  const { x, y } = JSON.parse(b);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.round(dx * i / 6), y: y + Math.round(dy * i / 6), button: 'left', buttons: 1 }); await sleep(40); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  return 'ok';
};

const harvest = (c, mark) => {
  const reqs = c.events.slice(mark).filter((e) => e.method === 'Network.requestWillBeSent' && /batch-update-nodes/.test(e.params.request.url));
  const ids = reqs.map((r) => r.params.requestId);
  const resps = c.events.filter((e) => e.method === 'Network.responseReceived' && ids.includes(e.params.requestId));
  return {
    posts: reqs.filter((r) => r.params.request.method === 'POST').map((r) => ({
      headers: r.params.request.headers, body: r.params.request.postData,
    })),
    statuses: resps.map((r) => r.params.response.status),
    etags: resps.map((r) => (r.params.response.headers || {}).ETag || null),
  };
};

const A = await newTab();
const B = await newTab();
const mA = A.events.length, mB = B.events.length;
await drag(A, -140, -70);
await sleep(90);
await drag(B, 160, 80);
await sleep(6000);

const out = { at: new Date().toISOString(), canvas: CANVAS, card: CARD_TEXT, A: harvest(A, mA), B: harvest(B, mB) };
fs.writeFileSync(`race-${Date.now()}.json`, JSON.stringify(out, null, 1), 'utf-8');

let verdict = true;
for (const side of ['A', 'B']) {
  const s = out[side];
  console.log(`--- 窗口 ${side} ---`);
  if (!s.posts.length) { console.log('  没有捕获到写入请求'); verdict = false; continue; }
  for (const p of s.posts) {
    const headers = Object.keys(p.headers || {}).map((k) => k.toLowerCase());
    const hasCond = headers.some((h) => /if-match|if-none-match|version|etag/.test(h));
    const body = p.body || '';
    const hasVerField = /"version"|"etag"|"rev"/i.test(body);
    console.log('  body:', body.slice(0, 220));
    console.log('  条件头:', hasCond ? '有（违背结论，需人工复核）' : '无');
    console.log('  body 里 version 字段:', hasVerField ? '有' : '无');
    if (hasCond || hasVerField) verdict = false;
  }
  console.log('  响应码:', JSON.stringify(s.statuses), '｜ETag:', JSON.stringify(s.etags));
  if (!s.statuses.every((x) => x >= 200 && x < 300)) verdict = false;
}

const pa = (out.A.posts[0]?.body || '').match(/"position":\{"x":([-\d.]+),"y":([-\d.]+)\}/);
const pb = (out.B.posts[0]?.body || '').match(/"position":\{"x":([-\d.]+),"y":([-\d.]+)\}/);
if (pa && pb) console.log(`\n两端提交位置：A (${pa[1]},${pa[2]}) ｜ B (${pb[1]},${pb[2]})（不同即为并发冲突输入）`);

console.log('\n判定：' + (verdict
  ? '复现成功 —— 两端都 2xx、无版本/条件字段 → 后端没有并发控制（其中一份会被静默覆盖）'
  : '未完全复现 —— 见上面逐条输出'));
A.ws.close(); B.ws.close();
process.exit(verdict ? 0 : 1);
