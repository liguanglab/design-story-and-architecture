# 最小复现脚本 · 说明（给 issue 附件用）

> 一个文件、三段检查、约 0.1 credits。
> 目的：让任何人用 5 分钟在**自己的账号**上看到同一组"说的和做的不是一回事"。

---

## 一、前置条件

```
① 已安装 canvas-cowork（bun ≥ 1.1）
   npx skills add flowith-ai/canvas-cowork
② 已登录：bun scripts/index.ts login（浏览器点 Allow）
③ 能访问 https://beta.flowith.io（需要能出网的环境）
④ 免费号即可（本报告所有结论都在 free_trial / t2 档上复现）
```

## 二、跑法

```bash
# 在 skill 仓库根目录（有 scripts/index.ts 的那层）
node repro.mjs

# 只跑某一段（省钱）
node repro.mjs --only b
node repro.mjs --only c

# 只在需要时加：验证"3~5 秒窗口内杀进程 → 卡片卡死"
node repro.mjs --kill-window
```

自定义路径：

```bash
CW_DIR=/path/to/canvas-cowork-main BUN=/path/to/bun node repro.mjs
```

产物：`repro-<运行号>.json`（每条检查的 reproduced 标记 + 原始回显摘要）。

## 三、三段检查分别验什么

| 段 | 检查 | 预期（复现成功长什么样） | 花费（实测） |
|---|---|---|---|
| A | 未知开关被静默忽略 | `--modle` 提交后 `exit=0`，命令自己打印 `Placed 1 text card (gemini-3.8-flash)`（不是指定的 haiku） | **~9.7 credits**（见下注） |
| B | 余额充足却报 `NO_CREDITS` | `credits` > 0，但图片生成返回 `NO_CREDITS`；画布留下 `✗ no credits` 卡 | 0（被拒绝） |
| C | `wait --timeout` 超时仍 `exit 0` | `wait <ref> --timeout 1` 返回 0，payload 里 `status: "running"` | ~0.06 |
| D（可选） | 提交后 3.5 秒杀进程 | 60 秒后该卡仍是 `running`（脚本会自动 delete 清理） | ~0.06 |

> 注：A 段之所以贵，是因为拼错开关后走的是**默认模型 gemini-3.8-flash**（$0.75/$3.75 每 M tokens），
> 单条一句话提示实测扣 **9.67~10.95 credits**；同一句改用 `--model claude-haiku-5-5` 只扣 **0.06**。
> 这本身就是该 bug 的成本后果；跑之前请知悉。想省钱可只跑 B/C：`node repro.mjs --only b`、`--only c`。

## 四、验收口径

```
全部复现 → 退出码 0（脚本会打印 REPRODUCED 三/四行）
有任一条没复现 → 退出码 1，并打印该条的实际回显
未登录 → 退出码 2
```

注意：脚本**不修改任何配置、不删旧数据**；D 段产生的死卡会自动 `delete` 掉。
唯一副作用是画布上会多几张测试卡（A、C 段各一张，标题以"语义不一致探针"开头）。

## 五、如果某一条没复现，可能的原因

```
A 没复现：该版本已加未知开关校验（好事，说明修了）→ 看是否报 INVALID_PARAM
B 没复现：账号有付费额度 / 图片模型不在 t2 限制内 → 换纯免费新号再试
C 没复现：任务太快完成（1 秒内就 done）→ 改用长输出提示词，或把 --timeout 降到 0
D 没复现：杀早了（请求未发出，无卡）或太晚（已完成）→ 窗口约在提交后 3~5 秒
```

## 六、与主报告的关系

```
主报告：00-合并报告-三处语义不一致.md（结论、证据、修复建议）
本脚本：把主报告里的三段检查变成一条命令，供对方自查
原始回显：evidence\（31 个文件，含窗口试验逐条结果）
```

---

## 附：一段可直接贴进 issue 的运行示例

```text
$ node repro.mjs
[2026-11-19T14:52:03.000Z][repro-m3x9k1-a7f2c4] skill 目录: /path/canvas-cowork | bun: bun
[..] 账号: user@example.com | 站点: https://beta.flowith.io
[..] REPRODUCED  A/未知开关被忽略 | exit=0 卡片="text 1a2b3c4d "语义不一致探针 A" gemini-3.8-flash ✓" 扣费=1.72
[..] REPRODUCED  B/余额充足却报额度不足 | credits=489.49 exit=1 → {"error":"NO_CREDITS", ...}
[..] REPRODUCED  B2/失败留下残卡 | 画布上 "✗ no credits" 卡片数=7
[..] REPRODUCED  C/超时仍返回 exit 0 | exit=0 running=true next=Still generating: `wait ...` later.
[..] 结果：4/4 条复现 → ./repro-repro-m3x9k1-a7f2c4.json
```


---

## 七、附带发现：`spent` 能看按模型的扣费（但看不到 token 数）

```
$ bun scripts/index.ts spent --since 2h
{ "chargedCredits": 28.08,
  "byModel": { "gemini-3.8-flash": 11.2, "claude-haiku-5-5": 10.59, "web_search": 6.29 },
  "note": "Everything charged on this canvas (by you, Flo, other tabs and agents), refunds included" }
```

用途：核对"哪次调用贵"。缺口：只有 credits，没有 token 数，也没有单次调用粒度。
