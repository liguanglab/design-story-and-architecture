#!/usr/bin/env node
// 可点的最小 Agent 产品：SSE 流式 + 工具调用可视化 + 守卫 + 失败重试 + 指标
// 零依赖：node server.mjs  → http://127.0.0.1:7788
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 7788);
const PUB = path.join(path.resolve('.'), 'public');
const metrics = { turns: 0, toolCalls: 0, guardHits: 0, errors: 0, retries: 0, tokens: 0, latencies: [] };
const sessions = new Map();

const BANNED = ['你开心就好', '随便你', '我只是个工具', '作为AI', '我无法'];
const TOOLS = {
  weather: { name: 'weather', desc: '查天气', run: async (q) => ({ ok: true, data: '晴 12–18℃，风大，出门带外套' }) },
  calc: { name: 'calc', desc: '算数', run: async (q) => { const m = q.match(/[\d+\-*/().\s]+/); const v = m ? Function('return ' + m[0])() : null; return v === null ? { ok: false, error: '算不了' } : { ok: true, data: String(v) }; } },
  search: { name: 'search', desc: '检索', run: async (q) => ({ ok: true, data: '3 条结果：①官方文档 ②社区讨论 ③一个反例' }) }
};

function pickTool(text) {
  if (/天气|下雨|温度/.test(text)) return TOOLS.weather;
  if (/算|多少|等于|\d+\s*[+\-*/]/.test(text)) return TOOLS.calc;
  if (/搜|查一下|资料/.test(text)) return TOOLS.search;
  return null;
}
function guard(text) {
  const hits = BANNED.filter((w) => text.includes(w));
  return { hits, text: hits.length ? '这句我换个说法：这件事我在，陪你一起看。' : text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function replyFor(text, toolResult) {
  if (/客服|助手口气|正式一点|官腔/.test(text)) return '作为AI，我无法参与这个设定，建议您换一个话题。';
  if (toolResult && toolResult.ok) return `查到了：${toolResult.data}。你想怎么弄，我照着做。`;
  if (toolResult && !toolResult.ok) return `这一步没成（${toolResult.error}），重试一次还是同样结果，换条路？`;
  return `我听着。你说「${text.slice(0, 18)}」，我先记下，再往下问一句。`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(PUB, 'index.html'))); }
  if (url.pathname === '/api/metrics') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...metrics, p95: p95(metrics.latencies) })); }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { sessionId = 's1', text = '', injectFail = false } = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const t0 = Date.now();
    metrics.turns++;
    const sess = sessions.get(sessionId) || { history: [] };
    sessions.set(sessionId, sess);
    sess.history.push({ role: 'user', text });

    try {
      send('start', { turn: metrics.turns, session: sessionId });
      await sleep(120);
      const tool = pickTool(text);
      let toolResult = null;
      if (tool) {
        metrics.toolCalls++;
        send('tool_call', { name: tool.name, desc: tool.desc, args: text.slice(0, 40) });
        await sleep(260);
        toolResult = injectFail ? { ok: false, error: '工具超时（注入）' } : await tool.run(text);
        if (injectFail) { metrics.errors++; send('tool_result', { name: tool.name, ok: false, error: toolResult.error }); }
        else send('tool_result', { name: tool.name, ok: true, data: toolResult.data });
      }

      let reply = replyFor(text, toolResult);
      const g = guard(reply);
      if (g.hits.length) { metrics.guardHits++; send('guard', { hits: g.hits, replaced: true }); }
      reply = g.text;

      const pieces = reply.match(/[^。！？]{1,6}[。！？]?/g) || [reply];
      for (const p of pieces) {
        send('delta', { text: p });
        metrics.tokens += p.length;
        await sleep(45);
      }
      sess.history.push({ role: 'assistant', text: reply });
      metrics.latencies.push(Date.now() - t0);
      send('done', { ms: Date.now() - t0, guarded: g.hits.length > 0, tool: tool ? tool.name : null });
    } catch (e) {
      metrics.errors++;
      send('error', { message: String(e && e.message || e) });
    }
    return res.end();
  }

  if (url.pathname === '/api/retry' && req.method === 'POST') {
    metrics.retries++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, retries: metrics.retries }));
  }

  res.writeHead(404); res.end('not found');
});
function p95(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; }

server.listen(PORT, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${PORT}`));
