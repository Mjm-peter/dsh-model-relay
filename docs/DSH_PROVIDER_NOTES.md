# 把反代模型注册成 DSH 原生 provider（开发笔记）

目标：模型出现在 DSH 模型选择器里，选中即对话（而不是通过 `model_relay chat` 工具）。
实现位于 `~/.dsh/profiles/desktop/node_modules/dsh-model-relay/index.mjs`。

## 注册三件套

```js
ctx.llm.registerAdapter([ROUTE], adapter)            // 必做：provider 路由 + adapter
ctx.llm.registerConfigurableProviders([{             // 让它在选择器里出现
  provider: ROUTE, displayName: "OrcaTerm 反代模型",
  settingsNs: <非空字符串>, settingsPath: [] }])
ctx.llm.registerModelDiscovery(name, async () => [...])  // 可选：探测模型
```
`inject` 必须包含 `"llm"`，否则 `ctx.llm` 不存在。

## adapter 必须实现的方法

- `providerInfo(provider)` → `{id, name}`
- `listModels(provider)` → `[{provider, id, name, inputModalities}]`
- `resolveModel(provider, model)` → `{provider, id, name, inputModalities, context:{contextWindow}, defaultMaxTokens}`
- `prepareCall(provider, model, signal)` → `{model, stream: (options)=>iterator}`
- `stream(options)` → 返回 async iterator，yield StreamChunk

## StreamChunk 契约（踩过的坑）

| 事件 | 必需字段 |
|---|---|
| `block-start` | `{type, index, blockType:'text'\|'reasoning'\|'tool-call'}` |
| `text-delta` | `{type, index, text}` |
| `reasoning-delta` | `{type, index, text}` |
| **`block-end`** | **`{type, index, block:{type, text}}`** ← 必须带 `block`，否则 DSH 读 `chunk.block.type` 抛 `Cannot read properties of undefined (reading 'type')` |
| `usage` | `{type, usage:{inputTokens, outputTokens, totalTokens}}` |
| `finish` | `{type, reason:{kind:'stop'\|'max-tokens'\|'tool-calls'\|{kind:'error',failure:{message,code}}}}` |

顺序：`block-start` → 若干 delta → `block-end` → `usage` → `finish`。

## Token 统计（0 tok/s 的坑）

上游不返回 usage。必须在 adapter 里估算后 yield `usage` 事件，否则 DSH 的 token 表和速度显示恒为 0。
当前按 `字符数 / 1.7` 估算中英混排 token。

## 破甲/预设注入的真实边界（重要）

DSH 的 system prompt（含 dsh-purge 破甲内容）经 `system-prompt/assemble` 钩子生成，落在
`options.messages` 的 system 项里。两种投递方式实测结果：

| 投递位置 | 效果 |
|---|---|
| 拼进 user 文本前部 | 被上游身份压过，几乎无效 |
| `user.setting.extra.orcaterm.promptExtra2` | 仍是上游优先，身份不变 |

结论：**OrcaTerm 后端的身份与输出格式由服务端锁定**（它按 `action` 字段做工具决策，要求
`{"action","thinking","taskCompletion"}`），客户端注入无法覆盖。要真正破甲，只能改用官方
provider key 直连模型（`model_relay.py` 那条路），system prompt 才会原样生效。

已做的改善：adapter 会解析 ACP JSON，只把 `taskCompletion` 正文吐给界面（不再显示原始 JSON）。

## 注意

- `async` 箭头函数不能 `yield`；生成器必须写成 `async function*` 或 `async function* ()`。
- 插件改动后 DSH 不会热重载，需完全重启应用才生效。
- bearer token（`scripts/_bearer.txt`）过期后这些模型会报认证错，重新抓即可。
