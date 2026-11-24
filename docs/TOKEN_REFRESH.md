# 刷新 OrcaTerm Bearer token（2 分钟，全自动）

反代靠一个 JWT Bearer token 调 lightai，有效期约 2 小时。**过期后所有模型返回空内容**，
上游报 `Invalid or expired AccessToken`。刷新方法（客户端版，最省事）：

## 前提

桌面客户端 `OrcaTerm.exe` 已登录（你已装好）。客户端把最新 token 明文存在：

```
%APPDATA%\com.orcaterm-desktop.app\data.bin
```

里面的 `oauth_access_token` 字段就是 Bearer token（客户端会自动续期，所以只要客户端
保持登录，这个文件始终是最新的）。

## 一键刷新

```powershell
$rt = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-relay\runtime"
& "$rt\.venv\Scripts\python.exe" "$rt\extract_client_token.py"
```

脚本会：读 `data.bin` → 提取 token → 打印剩余有效期 → 写入 `runtime\_bearer.txt` →
直连上游验证（`VERIFY OK 200 stream-ok` 即成功）。

## 重启反代加载新 token

对模型说「停掉反代」再「开反代」，或直接：

```powershell
# 通过 model_relay 工具 stop + start，或杀进程重开
```

## 旧方法（无客户端时）

`runtime/refresh_token.py` / `grab_token_by_chat.py` / `sniff_bearer.py` 是通过浏览器 CDP
抓 token 的备用脚本，需要带调试端口的 Chrome + 已登录页面，仅在没装客户端时用。
客户端版 `extract_client_token.py` 优先。

## 判断 token 过期

- 反代 `/v1/chat/completions` 返回 200 但 `content` 为空
- `relay.log` 里上游是 200，但响应是 `{"code":500,"message":"NEED_UIN_AND_SKEY"}`
  或 `Invalid or expired AccessToken`
- 直接跑 `extract_client_token.py`，它会打印 `valid_for_s`，小于 0 就是过期
