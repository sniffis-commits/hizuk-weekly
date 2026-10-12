"""PoC: send a real test message via the project's whatsapp-web.js client.

Delegates the actual WhatsApp work to waSend.js (same Client + LocalAuth +
project-local Chrome as index.js); this script only validates the target and
streams the sender's output. First run prints a QR code — scan it with
WhatsApp > Linked devices.

Usage:
    python Python/testWhatsapp.py <target-jid> [message]

Example:
    python Python/testWhatsapp.py 120363000000000000@g.us "hello from PoC"
"""

import argparse
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # project root (scripts live in Python/)


def main():
    ap = argparse.ArgumentParser(description="Send a WhatsApp PoC test message.")
    ap.add_argument("target", help="Group JID (...@g.us) or contact JID (...@c.us)")
    ap.add_argument(
        "message",
        nargs="?",
        default="\u2705 PoC test from testWhatsapp.py",
        help="Text to send (default: PoC greeting)",
    )
    args = ap.parse_args()

    if not (args.target.endswith("@g.us") or args.target.endswith("@c.us")):
        print("error: target must end with @g.us (group) or @c.us (contact)", file=sys.stderr)
        sys.exit(2)
    if not (BASE / "node_modules" / "whatsapp-web.js").exists():
        print("error: node_modules missing — run `npm install` first", file=sys.stderr)
        sys.exit(2)
    if not (BASE / "waSend.js").exists():
        print("error: waSend.js helper missing", file=sys.stderr)
        sys.exit(2)

    print(f"[testWhatsapp] sending to {args.target} ...")
    proc = subprocess.run(["node", "waSend.js", args.target, args.message], cwd=BASE)
    if proc.returncode == 0:
        print("[testWhatsapp] OK — message delivered")
    else:
        print(f"[testWhatsapp] FAILED (exit code {proc.returncode})", file=sys.stderr)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
