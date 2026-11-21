// 复现：知识花园上传四类（0B / 50MB / 5MB / 不支持类型）
//
// 前置：一个已登录 Flowith 的 Chromium（Edge/Chrome）以 --remote-debugging-port=4311 启动，
//       并且已经打开过知识花园（/knowledge），里面有一个知识库。
// 用法：node repro-uploads.mjs --port=4311
//
// 说明：测试文件在系统临时目录里自动生成，不需要自带素材；结果写到当前目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = args.port || '4311';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowith-upload-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = {
  empty: path.join(TMP, '空文件.txt'),
  big50: path.join(TMP, '50MB.txt'),
  big5: path.join(TMP, '大文件-5MB.txt'),
  exe: path.join(TMP, '不支持.exe'),
};
fs.writeFileSync(files.empty, '');
const fd = fs.openSync(files.big50, 'w'); fs.ftruncateSync(fd, 50 * 1024 * 1024); fs.closeSync(fd);
const fd2 = fs.openSync(files.big5, 'w'); fs.ftruncateSync(fd2, 5 * 1024 * 1024); fs.closeSync(fd2);
fs.writeFileSync(files.exe, 'MZ fake binary');

async function attach(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); const events = [];
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } else if (msg.method) events.push(msg); };
  await new Promise((r) => { ws.onopen = r; });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result?.value; };
  return { ws, send, ev, events };
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = list.find((t) => t.type === 'page' && /knowledge/.test(t.url));
if (!pg) { console.error('没找到 /knowledge 页面：先在浏览器里打开知识花园再跑本脚本'); process.exit(2); }
const c = await attach(pg.webSocketDebuggerUrl);
await c.send('Network.enable');
for (let i = 0; i < 15; i++) { await sleep(2000); if ((await c.ev('(document.body.innerText||"").length')) > 150) break; }
await sleep(2000);
console.log('知识花园页面:', pg.url);

const waitFileInput = async (limitMs = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const doc = await c.send('DOM.getDocument', { depth: -1 });
    const input = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (input.nodeId) return input;
    await sleep(1000);
  }
  return null;
};

const upload = async (file) => {
  const input = await waitFileInput();
  if (!input) return 'no-file-input';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: input.nodeId });
  return 'ok';
};

const snap = async () => c.ev(`(() => {
  const t = document.body.innerText.replace(/[\\u0000-\\u001f]/g, ' ').replace(/\\s+/g, ' ');
  return JSON.stringify({
    count: Number((t.match(/(\\d+) 个文件/) || [])[1] || -1),
    failed: (t.match(/上传未完成/g) || []).length,
    unread: (t.match(/文字未读取/g) || []).length
  });
})()`);

const results = [];
for (const [name, file] of Object.entries(files)) {
  const before = JSON.parse(await snap());
  const up = await upload(file);
  await sleep(name === 'big50' ? 15000 : 9000);
  const after = JSON.parse(await snap());
  results.push({ name, up, before, after });
  console.log(`${name}: 上传=${up} ｜计数 ${before.count}→${after.count} ｜失败卡 ${before.failed}→${after.failed} ｜未读取 ${before.unread}→${after.unread}`);
}

fs.writeFileSync(path.join(process.cwd(), 'repro-uploads-result.json'), JSON.stringify(results, null, 1));
console.log('结果写入 repro-uploads-result.json');
c.ws.close();
