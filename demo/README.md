# Agent 运行时 · 可点的最小产品

不是文档站，是一个能点的东西：**流式输出 + 工具调用可视化 + 守卫拦截 + 失败重试 + 实时指标**。

```bash
node server.mjs
# 打开 http://127.0.0.1:7788
```

零依赖（Node 18+），单进程，起停在 1 秒内。

## 能试什么

| 输入 | 你会看到 |
|---|---|
| `北京天气怎么样` | 工具卡：调用 weather → 返回结果 → 流式回复 |
| `帮我算 12*38+7` | 工具卡：calc → 结果 → 回复 |
| `用客服口气回我` | 守卫卡：命中「作为AI / 我无法」→ 替换为安全话术 |
| 勾「注入工具失败」再发 | 工具报错卡 + 「重试这一轮」按钮 + 指标里 errors+1 |
| `随便聊聊` | 纯流式回复，不调工具 |

## 它证明了什么

```
① 流式：SSE 事件流（start / tool_call / tool_result / delta / guard / done）
② 工具编排：按意图选工具、串行调用、结果注入下一轮
③ 守卫：输出侧拦截（不是输入侧），命中即替换，并在 UI 上标出来
④ 容错：工具失败不崩，给错误卡和重试入口；重试是独立接口
⑤ 可观测：轮次/工具/守卫/错误/重试/输出字符/P95 全部实时可见
```

## 接口

```
POST /api/chat   { sessionId, text, injectFail }
     → text/event-stream
POST /api/retry  { }
GET  /api/metrics → { turns, toolCalls, guardHits, errors, retries, tokens, p95 }
GET  /            → 单页 UI
```

## 实测（本机，SSE 原样）

```
天气：event start → tool_call(weather) → tool_result(ok) → delta×6 → done {ms:654}
守卫：event guard {hits:["作为AI","我无法"],replaced:true} → delta → done
失败：tool_result {ok:false,error:"工具超时（注入）"} → delta → done
指标：{"turns":3,"toolCalls":2,"guardHits":1,"errors":1,"tokens":95,"p95":654}
```

## 边界（没装成"完整产品"的部分）

```
· 模型是本地规则，不接真 LLM（避免 key 与费用；接口形状与真模型一致）
· 会话只存内存，重启即清（要持久化可换 SQLite）
· 无鉴权、无多租户（单机 demo）
· 重试是重发同一轮，不做指数退避
```
