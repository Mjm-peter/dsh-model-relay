#!/usr/bin/env python3
"""Read the OrcaTerm desktop client's locked WebView2 cookie DB via Win32
CreateFileW with full share mode, then list cookie names/hosts."""
import ctypes, ctypes.wintypes as wt, os, sqlite3, tempfile
from pathlib import Path

DB = Path(os.environ["LOCALAPPDATA"]) / "com.orcaterm-desktop.app" / "EBWebView" / "Default" / "Network" / "Cookies"

GENERIC_READ = 0x80000000
SHARE = 0x1 | 0x2 | 0x4
OPEN_EXISTING = 3
INVALID = ctypes.c_void_p(-1).value

class BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

def copy_locked(src: Path, dst: Path):
    k32 = ctypes.windll.kernel32
    k32.CreateFileW.restype = wt.HANDLE
    h = k32.CreateFileW(str(src), GENERIC_READ, SHARE, None, OPEN_EXISTING, 0x80, None)
    if h == INVALID or h is None:
        raise ctypes.WinError()
    try:
        size = ctypes.c_longlong()
        k32.GetFileSizeEx(h, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        got = wt.DWORD()
        k32.ReadFile(h, buf, size.value, ctypes.byref(got), None)
        dst.write_bytes(buf.raw[:got.value])
        return got.value
    finally:
        k32.CloseHandle(h)

def main():
    tmp = Path(tempfile.gettempdir()) / "orca_client_ck.db"
    n = copy_locked(DB, tmp)
    print("COPIED", n)
    con = sqlite3.connect(tmp)
    rows = con.execute("select host_key,name,length(encrypted_value) from cookies order by host_key").fetchall()
    con.close()
    for host, name, ln in rows:
        print(f"{host:42s} {name:38s} enc={ln}")
    print("TOTAL", len(rows))

if __name__ == "__main__":
    main()
