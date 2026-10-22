#!/usr/bin/env python3
"""Save an Exa key locally without placing it in shell history or Pi logs."""
import getpass
import os
from pathlib import Path
import sys
import tempfile


def main():
    if not sys.stdin.isatty():
        raise SystemExit("Run this command in your own interactive terminal, not through the agent.")
    key = getpass.getpass("Paste your Exa API key (input hidden): ")
    # getpass may receive terminal bracketed-paste delimiters as literal input.
    key = key.replace("\x1b[200~", "").replace("\x1b[201~", "").strip()
    if not key or any(not 33 <= ord(char) <= 126 for char in key):
        raise SystemExit("Key must contain only printable ASCII characters, without spaces or terminal control codes. Nothing was saved.")
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")
    directory = agent_dir / "secrets"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / "exa-api-key"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as handle:
            temp_path = Path(handle.name)
            os.chmod(temp_path, 0o600)
            handle.write(key + "\n")
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    print(f"Saved Exa API key to {path} (owner-only permissions). The key was not printed.")
    if os.environ.get("EXA_API_KEY", "").strip():
        print("Note: EXA_API_KEY is set in this terminal and takes precedence over the saved file.")
    print("Run /reload in Pi to load the Exa extension, then try a web search.")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        raise SystemExit("\nCancelled; no key saved.")
