#!/usr/bin/env python3
"""4K 随机读写（O_DIRECT，绕过页缓存）。由 Node 侧 spawn 调用，输出单行 JSON。

为什么必须 O_DIRECT：不做直读时 4K 读会被 page cache 接住，测出来的数字和真实磁盘无关。
为什么用 mmap 当缓冲区：O_DIRECT 要求用户缓冲区按页对齐，mmap 起点天然页对齐。
"""
import argparse
import json
import mmap
import os
import random
import sys
import time

BLOCK = 4096


def ensure_file(path, size_mb):
    need = size_mb * 1024 * 1024
    if os.path.exists(path) and os.path.getsize(path) >= need:
        return False
    with open(path, "wb") as f:
        chunk = b"\0" * (1024 * 1024)
        written = 0
        while written < need:
            f.write(chunk)
            written += len(chunk)
        f.flush()
        os.fsync(f.fileno())
    return True


def run(path, size_mb, seconds, direct=True):
    flags_base = os.O_DIRECT if direct else 0
    nblocks = max(1, (size_mb * 1024 * 1024) // BLOCK)
    rnd = random.Random(0xC0FFEE)
    offsets = [rnd.randrange(nblocks) * BLOCK for _ in range(8192)]

    out = {"file_mb": size_mb, "direct": direct}
    buf = mmap.mmap(-1, BLOCK)
    view = memoryview(buf)
    try:
        # ---- 随机读 ----
        try:
            fd = os.open(path, os.O_RDONLY | flags_base)
        except OSError as e:
            out["error"] = f"open read failed: {e}"
            return out
        try:
            count = 0
            idx = 0
            t0 = time.perf_counter()
            deadline = t0 + seconds
            next_report = t0 + 1
            while time.perf_counter() < deadline:
                off = offsets[idx & 8191]
                idx += 1
                os.preadv(fd, [view], off)
                count += 1
                now = time.perf_counter()
                if now >= next_report:
                    # 每秒一行进度（NDJSON），让前端能看到数字在动，而不是干等进度条
                    print(json.dumps({"progress": "read", "phase": "random", "iops": round(count / (now - t0))}), flush=True)
                    next_report = now + 1
            dt = time.perf_counter() - t0
            out["rand_read_iops"] = round(count / dt) if dt > 0 else 0
            out["rand_read_lat_us"] = round(dt / max(count, 1) * 1e6, 1)
        except OSError as e:
            out["error"] = f"read failed: {e}"
        finally:
            os.close(fd)

        # ---- 随机写 ----
        try:
            fdw = os.open(path, os.O_WRONLY | flags_base)
        except OSError as e:
            out["write_error"] = f"open write failed: {e}"
            return out
        try:
            count = 0
            idx = 0
            t0 = time.perf_counter()
            deadline = t0 + seconds
            next_report = t0 + 1
            while time.perf_counter() < deadline:
                off = offsets[idx & 8191]
                idx += 1
                os.pwritev(fdw, [view], off)
                count += 1
                now = time.perf_counter()
                if now >= next_report:
                    print(json.dumps({"progress": "write", "phase": "random", "iops": round(count / (now - t0))}), flush=True)
                    next_report = now + 1
            dt = time.perf_counter() - t0
            os.fsync(fdw)
            out["rand_write_iops"] = round(count / dt) if dt > 0 else 0
            out["rand_write_lat_us"] = round(dt / max(count, 1) * 1e6, 1)
        finally:
            os.close(fdw)
    finally:
        view.release()
        buf.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--file-mb", type=int, default=512)
    ap.add_argument("--seconds", type=float, default=6)
    ap.add_argument("--no-direct", action="store_true")
    args = ap.parse_args()

    created = ensure_file(args.path, args.file_mb)
    result = run(args.path, args.file_mb, args.seconds, direct=not args.no_direct)
    result["created"] = created
    result["final"] = True
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
