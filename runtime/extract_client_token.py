#!/usr/bin/env python3
"""Extract the fresh oauth_access_token from the OrcaTerm desktop client's
data.bin, write it to _bearer.txt, and verify against the lightai upstream."""
import json, time, uuid
from pathlib import Path
import httpx

HERE = Path(__file__).resolve().parent
DATA = Path.home() / "AppData" / "Roaming" / "com.orcaterm-desktop.app" / "data.bin"


def main():
    raw = DATA.read_bytes()
    obj = json.loads(raw.decode("utf-8-sig"))
    # Look for any oauth access token key.
    token = None
    for k, v in obj.items():
        if "access_token" in k.lower() and isinstance(v, str) and v.startswith("eyJ"):
            token = v
            print("KEY", k)
            break
    if not token:
        print("NO_TOKEN keys=", list(obj))
        return
    print("TOKEN len", len(token))
    # Decode payload to check expiry.
    try:
        import base64
        p = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        exp = payload.get("exp", 0)
        print("EXP", exp, "now", int(time.time()), "valid_for_s", exp - int(time.time()))
    except Exception as e:
        print("decode skip", e)

    (HERE / "_bearer.txt").write_text(token, encoding="utf-8")

    conv = f"cid-{uuid.uuid4()}-orcaterm"; bare = conv[4:-8]
    hdr = {"Content-Type": "application/json", "Accept": "text/event-stream",
           "X-Product": "orcaterm", "Authorization": f"Bearer {token}",
           "Origin": "https://orcaterm.com", "Referer": "https://orcaterm.com/",
           "x-seqid": str(uuid.uuid4())}
    env = json.dumps({"_format": "acp-prompt", "version": 1,
                      "prompt": [{"type": "text", "text": "你好"}]}, ensure_ascii=False)
    body = {"conversationId": conv, "user": {"id": "567026653952", "setting": {
            "model": "TokenHub/deepseek-v4-pro", "language": "zh", "multimodal": True, "enableThinking": True}},
            "input": {"type": "start", "input": env, "id": str(uuid.uuid4()), "files": []}, "stream": True}
    with httpx.Client(timeout=60) as c:
        c.put(f"https://lightai.cloud.tencent.com/assistant/conversation/{bare}", headers=hdr,
              json={"id": bare, "title": "probe", "ts": int(time.time()*1000), "aiTitle": "probe"})
        r = c.post("https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true",
                   headers=hdr, json=body)
        ok = "text/event-stream" in r.headers.get("content-type", "")
        print("VERIFY", "OK" if ok else "FAIL", r.status_code, r.text[:200] if not ok else "stream-ok")


if __name__ == "__main__":
    main()
