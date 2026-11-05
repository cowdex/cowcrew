"""CowCrew as a desktop app: the server runs in the background and the dashboard opens in its
own native window (WebKit on macOS, via pywebview). Closing the window stops CowCrew.

Started by CowCrew.app (see `make mac-app`) or with `cowcrew app`.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

DEFAULT_PORT = 8787
EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
               str(Path.home() / ".npm-global/bin"), str(Path.home() / ".claude/local")]


def fix_path() -> None:
    """Apps opened from the Dock don't get your shell's PATH, so git, gh and claude would be
    missing. Borrow the login shell's PATH and add the usual install folders."""
    paths: list[str] = []
    shell = os.environ.get("SHELL", "/bin/zsh")
    try:
        out = subprocess.run([shell, "-ilc", "printf %s \"$PATH\""], capture_output=True,
                             text=True, timeout=5, check=False)
        paths += [p for p in out.stdout.strip().split(":") if p]
    except (OSError, subprocess.SubprocessError):
        pass
    paths += EXTRA_PATHS + os.environ.get("PATH", "").split(":")
    seen: list[str] = []
    for p in paths:
        if p and p not in seen:
            seen.append(p)
    os.environ["PATH"] = ":".join(seen)


def _running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _start_server(port: int) -> threading.Thread:
    import uvicorn

    config = uvicorn.Config("cowcrew.main:create_app", factory=True, host="127.0.0.1",
                            port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="cowcrew-server")
    thread.start()
    for _ in range(150):
        if _running(port):
            return thread
        time.sleep(0.1)
    raise RuntimeError(f"CowCrew didn't start on port {port}")


def main() -> int:
    fix_path()
    port = int(os.environ.get("COWCREW_PORT", DEFAULT_PORT))
    if not _running(port):  # reuse a CowCrew that's already running (e.g. `make serve`)
        if not _free(port):
            port = next(p for p in range(port + 1, port + 50) if _free(p))
        _start_server(port)
    try:
        import webview
    except ImportError:
        import webbrowser

        webbrowser.open(f"http://127.0.0.1:{port}/")
        print("pywebview isn't installed; opened CowCrew in your browser. Ctrl+C to stop.")
        while True:
            time.sleep(3600)
    webview.create_window("CowCrew", f"http://127.0.0.1:{port}/", width=1440, height=920,
                          min_size=(1024, 680), text_select=True)
    webview.start()
    return 0  # window closed: the server thread is a daemon and stops with us


if __name__ == "__main__":
    sys.exit(main())
