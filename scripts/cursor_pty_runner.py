#!/usr/bin/env python3
import os
import pty
import select
import signal
import sys


def main():
    argv = sys.argv[1:]
    if not argv:
        print("cursor_pty_runner.py requires a command", file=sys.stderr)
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(argv[0], argv, os.environ)
        return 127

    child_status = None

    def forward_signal(signum, _frame):
        try:
            os.kill(pid, signum)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    while True:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if fd in ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)

        done_pid, status = os.waitpid(pid, os.WNOHANG)
        if done_pid == pid:
            child_status = status
            break

    while True:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)

    if child_status is None:
        _, child_status = os.waitpid(pid, 0)

    if os.WIFEXITED(child_status):
        return os.WEXITSTATUS(child_status)
    if os.WIFSIGNALED(child_status):
        return 128 + os.WTERMSIG(child_status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
