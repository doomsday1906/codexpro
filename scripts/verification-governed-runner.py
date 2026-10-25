#!/usr/bin/env python3
"""Run one verification command under the shared AgentWorkspace memory governor."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

AGENTWORKSPACE = Path("/home/andrew/AgentWorkspace")
sys.path.insert(0, str(AGENTWORKSPACE))

from safe_test.memory import TestMemory
from safe_test.runner import get_profile, resolve_control_environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lifetime-ms", type=int, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.lifetime_ms <= 0 or not command:
        parser.error("a positive lifetime and command after -- are required")

    profile = get_profile("default")
    control_env = resolve_control_environment()
    memory = TestMemory(profile, control_env)
    scope = f"codexpro-verify-{uuid.uuid4().hex}.scope"
    deadline = time.monotonic() + args.lifetime_ms / 1000
    process = None
    received_signal = None

    def interrupted(signum, _frame):
        nonlocal received_signal
        received_signal = signum
        raise InterruptedError

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupted)

    try:
        if not memory.inherited:
            memory.lease.acquire(deadline=deadline)
            memory.prepare()
        argv = [
            "systemd-run", "--user", "--scope", "--collect",
            f"--slice={memory.unit}", f"--unit={scope}",
            "--property=TimeoutStopSec=1s", "--property=KillMode=control-group", "--",
            *command,
        ]
        process = subprocess.Popen(argv, env=control_env)
        code = process.wait()
        return code if code >= 0 else 128 + -code
    except InterruptedError:
        for unit in ([scope] if memory.inherited else [scope, memory.unit]):
            try:
                subprocess.run(
                    ["systemctl", "--user", "stop", unit],
                    env=control_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1.0,
                )
            except (OSError, subprocess.SubprocessError):
                pass
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=0.5)
        return 128 + (received_signal or signal.SIGTERM)
    except TimeoutError:
        print("Verification memory admission reached its lifetime deadline.", file=sys.stderr)
        return 124
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Verification governor launch failed: {type(error).__name__}.", file=sys.stderr)
        return 1
    finally:
        clean = process is None or process.poll() is not None
        try:
            memory.close(clean=clean)
        except (OSError, subprocess.SubprocessError):
            pass
        if received_signal is not None:
            signal.signal(received_signal, signal.SIG_DFL)
            os.kill(os.getpid(), received_signal)


if __name__ == "__main__":
    raise SystemExit(main())
