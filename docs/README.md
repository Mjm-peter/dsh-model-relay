# OrcaTerm 模型反代

把截图里的模型选择器原样暴露成一个 OpenAI 兼容 API，客户端只改 `base_url` 即可接入。

截图中识别到的公开模型 id：

```
Hy4
Hy3
Kimi-K3
GLM-5.3-Flash
GLM-5.3
GLM-5.2
DeepSeek-V4.1-Flash
DeepSeek-V4-Flash
Deepseek-V4-Pro
```

## ★ 真·反代（已抓包取证，2026-11-23）

`lightai_relay.py` 直接对接 OrcaTerm 实际使用的后端 `lightai.cloud.tencent.com/assistant/chat`（SSE），把它翻译成标准 OpenAI 接口。**上游协议、真实模型 id、端点全部来自浏览器抓包，见 [ORIGIN_RECON.md](ORIGIN_RECON.md)**。

默认 `lightai.yaml` 里 `mock: true`，零配置先跑通：

```bat
cd model-relay
.\.venv\Scripts\python.exe -m lightai_relay --config lightai.yaml --port 8001
```

切到真实登录态（用你自己 OrcaTerm 账号正在用的模型）：
1. `lightai.yaml` 改 `server.mock: false`
2. 浏览器登录 `orcaterm.com/terminal`，F12 → Application → Cookies，复制 Cookie
3. PowerShell：`$env:LIGHTAI_COOKIE = "粘贴完整Cookie"`
4. 重启后客户端填 `base_url = http://127.0.0.1:8001/v1`

公开名 → 真实模型 id 映射（抓包取证，写在 `lightai.yaml`）：
```
Deepseek-V4-Pro      -> TokenHub/deepseek-v4-pro      (实测)
DeepSeek-V4-Flash    -> TokenHub/deepseek-v4-flash
Kimi-K3              -> TokenHub/kimi-k2.5
GLM-5.3-Flash        -> TokenHub/glm-5.1
GLM-5.3              -> TokenHub/glm-5
GLM-5.2              -> TokenHub/glm-4.6
Hy4                  -> TokenHub/hunyuan-t1-latest
Hy3                  -> TokenHub/hunyuan-turbos-latest
```

> 上面每条真实 id 都有 Rainbow 配置或 chat 请求体抓包支撑；截图里只有公开名，底层 id 靠这次抓包才拿到。
> 反代靠你自己的登录态 Cookie，脚本不导出凭证；也可改用各家官方 key（见下方 `model_relay.py` 路径）。

## 最快接法（零配置，立刻能用）

`models.yaml` 里 `server.mock: true` 已经打开，无需任何上游 key，启动后所有 9 个模型都会返回本地模拟响应，专门用来把客户端/框架先接通：

```bat
cd model-relay
.\.venv\Scripts\python.exe -m model_relay
```

另一终端验证：

```bat
curl http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"Kimi-K3\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

接通后，要真正出 token，把 `server.mock` 改成 `false`，再按下面「配置」一节填上游即可。

## 安装

```bat
cd model-relay
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 配置

编辑 `models.yaml`：

- `server.listen` / `server.port`：监听地址，默认 `127.0.0.1:8000`。
- `server.mock`：`true` = 本地模拟响应（不用 key，方便联调）；`false` = 真实转发到上游。
- `server.api_key_env`：反代自身的鉴权 key 环境变量名；设了 `RELAY_API_KEY` 才启用，留空则不鉴权。
- `providers`：每个上游的 `base_url`、key 环境变量、请求头格式。默认值给了 DeepSeek / Moonshot / 智谱 / 混元的官方端点，可改成你的中转站。
- `models`：`id` 是对外暴露的名字，`upstream_model` 是实际发给上游的名字。按你账号里真实可用的模型改 `upstream_model`。

设置环境变量（PowerShell 示例）：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:MOONSHOT_API_KEY = "sk-..."
$env:ZHIPU_API_KEY = "..."
$env:HUNYUAN_API_KEY = "..."
# 可选：$env:RELAY_API_KEY = "change-me"
```

校验配置：

```bat
python -m model_relay --check
```

## 启动

```bat
python -m model_relay
```

或双击 `start.bat`（自动装依赖并启动）。指定端口：

```bat
python -m model_relay --port 9000
```

## 客户端接入

```text
base_url = http://127.0.0.1:8000/v1
api_key  = 随便填（若设置了 RELAY_API_KEY 则填对应值）
```

Python 示例：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="none")
print(client.models.list())

resp = client.chat.completions.create(
    model="DeepSeek-V4.1-Flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

curl 示例：

```bat
curl http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"Kimi-K3\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

## 支持的端点

- `GET /v1/models`、`GET /v1/models/{id}`
- `POST /v1/chat/completions`（含 SSE 流式，流式响应里的 `model` 字段会被换回公开名）
- `POST /v1/completions`、`POST /v1/embeddings`、`POST /v1/images/generations`（需在 `models.yaml` 里给对应模型声明 `supports`）
- `GET /health`
