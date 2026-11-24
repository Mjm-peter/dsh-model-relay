# OrcaTerm 真实上游侦察记录（浏览器抓包取证）

时间：2026-11-23，通过 DSH browser-skill 的 `bsk_inspect debug` 在**已登录**的
`https://orcaterm.com/terminal` 页面抓包，并让用户在 OrcaTerm AI 里实际发了
一条消息「你好」。仅记录端点结构与协议，**不含任何 cookie / token / skey**
（浏览器工具按策略不导出凭证）。

## 一、真实对话端点（核心）

```
POST https://lightai.cloud.tencent.com/assistant/chat
     ?name=orcaterm&mode=0&csrfCode=&sseresume=true
Content-Type: application/json
Response: text/event-stream   (SSE)
```

请求体结构（抓包原文，已去掉冗长的系统提示词）：

```json
{
  "conversationId": "cid-<uuid>-orcaterm",
  "user": {
    "id": "567026653952",
    "setting": {
      "mcpServers": ["mcp-server-orcaterm-oauth"],
      "model": "TokenHub/deepseek-v4-pro",
      "modelDesc": {"kwargs": {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}},
      "language": "zh",
      "multimodal": true,
      "enableThinking": true
    }
  },
  "input": {
    "type": "start",
    "input": "{\"_format\":\"acp-prompt\",\"version\":1,\"prompt\":[{\"type\":\"text\",\"text\":\"你好\"}]}",
    "id": "<uuid>",
    "files": []
  },
  "stream": true
}
```

SSE 响应帧（逐帧，抓包原文节选）：

```
data: {"id":"...","content":"","reasoningContent":"用户","reasoning":true,"type":"ai","code":0}
data: {"id":"...","content":"","reasoningContent":"再次发送了","reasoning":true,"type":"ai","code":0}
data: {"id":"...","content":"```json\n{\n","reasoningContent":"","reasoning":false,"type":"ai","code":0}
data: {"id":"...","content":" \"action\": \"completion\",\n","reasoningContent":"","reasoning":false,"type":"ai","code":0}
...
```

字段语义：
- `reasoning:true` + `reasoningContent` → 思考链（reasoning 模型）
- `reasoning:false` + `content` → 正文 token 片段
- `code:0` → 正常帧；`type:"ai"` → AI 消息
- 结束：流自然结束（未见显式 [DONE]，适配器补发 `data: [DONE]`）

## 二、辅助端点

| 用途 | 方法 | 端点 |
|---|---|---|
| 会话注册/改名 | PUT | `https://lightai.cloud.tencent.com/assistant/conversation/<uuid>` body `{"id","title","ts","aiTitle"}` |
| 取消息 | GET | `https://lightai.cloud.tencent.com/assistant/messages/cid-<uuid>-orcaterm?name=orcaterm&mode=0&csrfCode=` |
| 会话列表 | GET | `https://lightai.cloud.tencent.com/assistant/conversation/list?offset=0&limit=100&orderBy=ts&order=desc&filter={"tags":["orcaterm"]}` |
| API 网关 | POST | `https://orcaterm.com/cgi/api?action=<Action>&uin=&ownerUin=` |
| 云 API 网关 | POST | `https://orcaterm.com/cgi/capi?i=<svc>/<Action>&uin=&region=ap-guangzhou` |
| 配置下发 | POST | `https://dnspod.cloud.tencent.com/ajax/rainbow?action=getRainbowConfig` |
| 登录 | GET | `/oauth/wechat/config` → 微信 QR → `/oauth/wechat/bridge?code=` → `/oauth/wechat/exchange` |

## 三、真实模型 id（Rainbow 配置 "orcaterm.第三方模型提供商"）

关键 provider 与 base_url（截图 9 模型均落在这些里）：

| provider | base_url | 模型 id 举例 |
|---|---|---|
| deepseek | `https://api.deepseek.com` | `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` |
| moonshot | `https://api.moonshot.cn/v1` | `kimi-k2.5`, `kimi-k2-thinking`, `kimi-k2-thinking-turbo` |
| zhipu | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1`, `glm-5`, `glm-4.6`, `glm-4.5` |
| hunyuan | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-t1-latest`, `hunyuan-turbos-latest` |
| tokenhub(腾讯云) | `https://api.lkeap.cloud.tencent.com/plan/v3` | `tc-code-latest`, `glm-5`, `kimi-k2.5`, `hunyuan-2.0-instruct` |

实际 chat 请求里 `user.setting.model` = `TokenHub/deepseek-v4-pro`，即
**`TokenHub/` 前缀 + provider 模型 id**。截图公开名 → 真实 id 映射见 `lightai.yaml`。

## 四、鉴权形态与可用路径

- lightai 对话靠 **Cookie + uin/skey 会话**（URL 里 `uin=` 为空，靠 cookie 注入）。
  浏览器工具按策略不导出这些凭证，因此反代无法自动拿到，需操作者自己粘贴
  `LIGHTAI_COOKIE` 环境变量。
- 另有更稳的路：直接用上表各家 **官方 base_url + 自己的 API key**，完全绕开
  OrcaTerm 登录态。原 `model_relay.py` 就是走这条。

## 五、两条可用反代路径

1. **`lightai_relay.py`**（本目录）：把 OpenAI 请求翻译成 OrcaTerm 的 lightai
   SSE 协议，用你自己的登录态 Cookie 调真后端。改 `lightai.yaml` 的 `mock:false`
   并设 `LIGHTAI_COOKIE`。
2. **`model_relay.py`**：标准 OpenAI → 官方 provider 转发，用各家官方 key。
   改 `models.yaml` 填 key。

默认 `mock:true`，两者都零配置可先跑通接口。
