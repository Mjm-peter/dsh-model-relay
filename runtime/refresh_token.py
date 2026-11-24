#!/usr/bin/env python3
"""Refresh the OrcaTerm lightai Bearer token via a local Chrome CDP endpoint.

Two modes:
  serve    : start `chrome --remote-debugging-port=9222 --user-data-dir=<profile> https://orcaterm.com/terminal`
             then run: python refresh_token.py grab
  grab     : connect to CDP, trigger OrcaTerm AI, capture the Bearer JWT sent to
             lightai, write it to _bearer.txt, and verify it works.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CDP = "http://127.0.0.1:9222"


def ws_connect():
    import websocket
    ver = json.loads(urllib.request.urlopen(CDP + "/json/version", timeout=6).read())
    return websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=60,
                                       origin="http://127.0.0.1:9222")


def grab() -> None:
    import websocket  # noqa
    pages = json.loads(urllib.request.urlopen(CDP + "/json/list", timeout=6).read())
    pg = next((p for p in pages if p.get("type") == "page"), None)
    if not pg:
        print("NO_PAGE")
        return
    ws = ws_connect()
    seq = 0

    def send(method, params=None):
        nonlocal seq
        seq += 1
        ws.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == seq:
                return m

    send("Network.enable")
    # Reload so all authenticated lightai requests re-fire while we listen.
    send("Page.reload", {"ignoreCache": True})
    time.sleep(9)

    ws.settimeout(2)
    token = None
    deadline = time.time() + 18
    while time.time() < deadline and not token:
        try:
            m = json.loads(ws.recv())
        except Exception:
            continue
        if m.get("method") == "Network.requestWillBeSent":
            h = m.get("params", {}).get("request", {}).get("headers", {})
            auth = h.get("Authorization") or h.get("authorization") or ""
            if auth.startswith("Bearer "):
                token = auth[7:]
                break
    ws.close()
    if not token:
        print("TOKEN_NOT_FOUND (make sure you are logged in and the AI panel opened)")
        return
    (HERE / "_bearer.txt").write_text(token, encoding="utf-8")
    print(f"TOKEN_OK len={len(token)}")

    # Verify against the real upstream.
    try:
        import httpx
        uuid_mod = __import__("uuid")
        conv = f"cid-{uuid_mod.uuid4()}-orcaterm"
        bare = conv[4:-8]
        hdr = {"Content-Type": "application/json", "Accept": "text/event-stream",
               "X-Product": "orcaterm", "Authorization": f"Bearer {token}",
               "Origin": "https://orcaterm.com", "Referer": "https://orcaterm.com/",
               "x-seqid": str(uuid_mod.uuid4())}
        env = json.dumps({"_format": "acp-prompt", "version": 1,
                          "prompt": [{"type": "text", "text": "你好"}]}, ensure_ascii=False)
        body = {"conversationId": conv,
                "user": {"id": "567026653952", "setting": {"model": "TokenHub/deepseek-v4-pro",
                         "language": "zh", "multimodal": True, "enableThinking": True}},
                "input": {"type": "start", "input": env, "id": str(uuid_mod.uuid4()), "files": []},
                "stream": True}
        with httpx.Client(timeout=60) as c:
            c.put(f"https://lightai.cloud.tencent.com/assistant/conversation/{bare}", headers=hdr,
                  json={"id": bare, "title": "probe", "ts": int(time.time()*1000), "aiTitle": "probe"})
            r = c.post("https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true",
                       headers=hdr, json=body)
            ok = "text/event-stream" in r.headers.get("content-type", "")
            print("VERIFY", "OK" if ok else "FAIL", r.status_code, r.text[:160] if not ok else "")
    except Exception as e:
        print("VERIFY_SKIP", e)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "grab":
        grab()
    else:
        print(__doc__)
