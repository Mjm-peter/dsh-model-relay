# dsh-model-relay

DeepSeek Harness 插件：把 OrcaTerm 的 9 个模型（Hy4 / Hy3 / Kimi-K3 / GLM-5.3 系列 /
DeepSeek-V4 系列）注册成 DSH 原生 provider，在模型选择器里直接选用。

插件用 DSH 内核的 `PiAiAdapter`，因此 system prompt（含破甲）、工具、技能按标准管线传递。
上游走 OrcaTerm 的 lightai 后端，**需要你自己的 OrcaTerm 登录态**。

## 安装

```powershell
# 1. 克隆到 DSH profile 的 node_modules
$nm = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
git clone https://github.com/Mjm-peter/dsh-model-relay.git "$nm\dsh-model-relay"
cd "$nm\dsh-model-relay"

# 2. 创建 Python 虚拟环境（需要 Python 3.10+）
python -m venv runtime\.venv
.\runtime\.venv\Scripts\python.exe -m pip install -r runtime\requirements.txt

# 3. 在 DSH 的 package.json 里登记（两个位置）
#    dependencies 加:  "dsh-model-relay": "file:./node_modules/dsh-model-relay"
#    dsh.profile.bundles 数组末尾加: "dsh-model-relay"
# 文件: $env:USERPROFILE\.dsh\profiles\desktop\package.json

# 4. 在 cordis.patch.yml 末尾加（同样在 profiles\desktop 下）
#    - insert:
#        - id: dsh-model-relay
#          name: "dsh-model-relay"

# 5. 完全重启 DSH
```

## 配置凭证

插件**不含任何 token/cookie**（发布时必须删掉 `runtime/_bearer.txt` 和 `_cookie.txt`）。
首次使用需要你自己的登录态，二选一：

- **有 OrcaTerm 桌面客户端**（推荐）：登录后运行
  `.\runtime\.venv\Scripts\python.exe .\runtime\extract_client_token.py`
  它从客户端 `data.bin` 自动提取 token 并写入 `runtime/_bearer.txt`。
- **只有网页版**：在已登录页面 F12 → Network → 发一条消息 → 找 `chat?name=orcaterm`
  请求 → 复制 `Authorization: Bearer xxx` 的 token，粘贴到 `runtime/_bearer.txt`。

token 有效期约 2 小时，过期后模型返回空。重新跑一次上面的命令即可。详见
[docs/TOKEN_REFRESH.md](docs/TOKEN_REFRESH.md)。

## 使用

- 模型选择器里出现「OrcaTerm 反代模型」分组，9 个模型直接选用对话。
- 对模型说「开反代 / 反代状态 / 用反代问一句 / 停掉反代」可调用 `model_relay` 管理插件。

## 端点与协议（供二次开发）

见 [docs/ORIGIN_RECON.md](docs/ORIGIN_RECON.md) 与 [docs/DSH_PROVIDER_NOTES.md](docs/DSH_PROVIDER_NOTES.md)。

## License

MIT
