"""Command line: `cowcrew serve | seed | reset`."""

from __future__ import annotations

import argparse
import os
import sys

from cowcrew.db import Database
from cowcrew.settings import DEFAULT_PORT, Config

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    if args.host not in LOOPBACK:
        print(f"warning: binding to {args.host} exposes CowCrew to your network; it has no "
              "authentication.", file=sys.stderr)
        os.environ["COWCREW_ALLOWED_HOSTS"] = args.host
    config = Config.from_env()
    mode = "SIMULATE (no agent calls)" if config.simulate else "live agents"
    print(f"CowCrew on http://{args.host}:{args.port} · {mode} · data in {config.home}")
    uvicorn.run("cowcrew.main:create_app", factory=True, host=args.host, port=args.port,
                reload=args.reload, log_level="info")
    return 0


def _seed(_args: argparse.Namespace) -> int:
    from cowcrew.seed import seed

    config = Config.from_env()
    db = Database(config.db_path)
    seed(db)
    db.close()
    print(f"Seeded demo project 'orbit-api' into {config.db_path}")
    return 0


def _reset(_args: argparse.Namespace) -> int:
    config = Config.from_env()
    db = Database(config.db_path)
    db.wipe()
    db.close()
    print(f"Wiped {config.db_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cowcrew", description="CowCrew — AI software factory")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="run the web app")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int,
                       default=int(os.environ.get("COWCREW_PORT", DEFAULT_PORT)))
    serve.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    serve.set_defaults(func=_serve)
    sub.add_parser("app", help="open CowCrew in its own window (desktop app)").set_defaults(
        func=lambda _args: __import__("cowcrew.desktop", fromlist=["main"]).main())
    sub.add_parser("seed", help="insert demo data").set_defaults(func=_seed)
    sub.add_parser("reset", help="wipe the database").set_defaults(func=_reset)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
