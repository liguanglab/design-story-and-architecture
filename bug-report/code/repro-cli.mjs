#!/usr/bin/env node
// canvas-cowork · 三处语义不一致 · 最小复现脚本
// 用法：
//   node repro.mjs                          # 跑 A/B/C 三段（约 0.1 credits）
//   node repro.mjs --kill-window            # 额外跑 D：3~5 秒杀进程窗口（约 0.1 credits + 1 张死卡）
//   CW_DIR=<skill 目录> BUN=<bun 路径> node repro.mjs
// 说明：需要已 `bun scripts/index.ts login` 登录，且能访问 beta.flowith.io。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BUN = process.env.BUN || 'bun';
const CW = process.env.CW_DIR || process.cwd();
const ARGS = process.argv.slice(2);
const RUN_ID = `repro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
const log = (...a) => console.log(`[${new Date().toISOString()}][${RUN_ID}]`, ...a);

function cw(args, timeout = 240000) {
  const r = spawnSync(BUN, ['scripts/index.ts', ...args], { cwd: CW, encoding: 'utf8', timeout });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const credits = () => { const j = json(cw(['credits']).out); return j ? j.credits : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(name, reproduced, detail) {
  results.push({ name, reproduced, detail });
  log(reproduced ? `REPRODUCED  ${name}` : `NOT REPRODUCED  ${name}`, '|', detail);
}

// ── A. 未知开关被静默忽略（用 A/B 对照证明：同一提示，拼错 vs 拼对） ──────────
async function testA() {
  const before = credits();
  const typo = cw(['text', '语义不一致探针 A', '--modle', 'claude-haiku-5-5']);
  await sleep(25000);
  const afterTypo = credits();
  const placed = (typo.out.match(/Placed \d+ text card \(([^)]+)\)/) || [])[1] || '';
  let line = '';
  if (!placed) {
    const headers = cw(['look']).out.split('\n').filter((l) => /^\S+\s+[0-9a-f]{8}\s/.test(l.trim()));
    line = headers.filter((l) => l.includes('语义不一致探针 A')).pop() || '';
  }
  const effectiveModel = placed || ((line.match(/\s([a-z0-9.\-/]+)\s+[✓…✗]/) || [])[1] || '');
  const usedDefault = /gemini-3\.8-flash/.test(effectiveModel);
  const ok = typo.code === 0 && usedDefault && effectiveModel !== 'claude-haiku-5-5';
  record('A/未知开关被忽略', ok,
    `exit=${typo.code} 实际模型=${effectiveModel || '?'} 扣费=${before != null && afterTypo != null ? (before - afterTypo).toFixed(2) : '?'}`);
  return { line, spent: before != null && afterTypo != null ? +(before - afterTypo).toFixed(2) : null };
}

// ── B. 余额充足却报 NO_CREDITS（档位限制） ─────────────────────────────────
function testB() {
  const c = credits();
  const r = cw(['image', '一颗红苹果', '--model', 'gpt-image-2.5-flare']);
  const noCredits = /NO_CREDITS/.test(r.out);
  const ok = c > 0 && noCredits;
  record('B/余额充足却报额度不足', ok, `credits=${c} exit=${r.code} → ${r.out.replace(/\s+/g, ' ').slice(0, 120)}`);
  // 顺带记录残留卡
  const look = cw(['look']).out;
  const ghosts = (look.match(/✗ no credits/g) || []).length;
  record('B2/失败留下残卡', ghosts > 0, `画布上 "✗ no credits" 卡片数=${ghosts}`);
  return { credits: c, ghostCards: ghosts };
}

// ── C. wait --timeout 超时仍 exit 0 ────────────────────────────────────────
async function testC() {
  // 用"要求长输出"的提示，保证 1~2 秒内跑不完
  const sub = cw(['text', '请写 800 字左右关于雨夜街道的长描写，不要标题', '--model', 'claude-haiku-5-5', '--no-wait']);
  const ref = (sub.out.match(/"ref"\s*:\s*"([0-9a-f]{6,})"/) || [])[1];
  if (!ref) { record('C/超时算成功', false, '没拿到 ref（提交失败）'); return null; }
  const w = cw(['wait', ref, '--timeout', '1']);
  const lines = w.out.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('{'));
  const payload = start >= 0 ? json(lines.slice(start).join('\n')) : null;
  let stillRunning = payload ? (payload.cards || []).some((c) => c.status === 'running') : false;
  if (!stillRunning) {
    // 兜底：直接看画布状态
    const line = cw(['look']).out.split('\n').find((l) => l.includes(ref)) || '';
    stillRunning = /…/.test(line) && !/✓/.test(line);
  }
  const ok = w.code === 0 && stillRunning;
  record('C/超时仍返回 exit 0', ok, `exit=${w.code} 超时后仍 running=${stillRunning} next=${payload ? payload.next : '?'}`);
  return { ref, exit: w.code, stillRunning };
}

// ── D.（可选）提交后 3~5 秒杀进程 → 卡片卡死 ──────────────────────────────
async function testD() {
  const before = new Set((cw(['look']).out.match(/[0-9a-f]{8}/g) || []));
  const child = spawn(BUN, ['scripts/index.ts', 'text', '语义不一致探针 D', '--model', 'claude-haiku-5-5'],
    { cwd: CW, stdio: 'ignore' });
  await sleep(3500);
  spawnSync(process.platform === 'win32' ? 'taskkill' : 'kill',
    process.platform === 'win32' ? ['/F', '/T', '/PID', String(child.pid)] : ['-9', String(child.pid)],
    { windowsHide: true });
  let ref = null, state = 'none';
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const l = cw(['look']).out;
    const fresh = [...new Set((l.match(/[0-9a-f]{8}/g) || []))].filter((x) => !before.has(x));
    if (fresh.length && !ref) ref = fresh[fresh.length - 1];
    if (ref) {
      const line = l.split('\n').find((x) => x.includes(ref)) || '';
      state = /✓/.test(line) ? 'done' : /✗/.test(line) ? 'failed' : 'running';
      if (state !== 'running') break;
    }
  }
  const ok = state === 'running';
  record('D/窗口内被杀 → 卡死', ok, `ref=${ref || '-'} 60 秒后状态=${state}`);
  if (ref) cw(['delete', ref]); // 清理
  return { ref, state };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const main = async () => {
  log('skill 目录:', CW, '| bun:', BUN);
  const who = json(cw(['whoami']).out);
  if (!who || !who.email) { console.error('未登录：先跑 bun scripts/index.ts login'); process.exit(2); }
  log('账号:', who.email, '| 站点:', who.site);
  const onlyIdx = ARGS.indexOf('--only');
  const only = onlyIdx >= 0 ? String(ARGS[onlyIdx + 1] || '').toLowerCase() : '';
  if (!only || only === 'a') await testA();
  if (!only || only === 'b') testB();
  if (!only || only === 'c') await testC();
  if (ARGS.includes('--kill-window')) await testD();

  const reproduced = results.filter((r) => r.reproduced).length;
  const outFile = path.join(process.cwd(), `repro-${RUN_ID}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, at: new Date().toISOString(), skillDir: CW, results }, null, 1));
  log(`结果：${reproduced}/${results.length} 条复现 → ${outFile}`);
  process.exit(reproduced === results.length ? 0 : 1);
};
main();
