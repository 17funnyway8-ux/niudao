#!/usr/bin/env python3
"""生成牛刀的应用图标（纯标准库，超采样抗锯齿，无需 Pillow）。

产出：
  package/ICON.PNG        64x64
  package/ICON_256.PNG    256x256
  package/app/ui/images/icon_64.png
  package/app/ui/images/icon_256.png
图形与网页里的品牌标记一致：圆角方形青柠底 + 深色趋势折线 + 圆点。
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4  # 超采样倍数

BG_TOP = (233, 255, 122)
BG_BOTTOM = (134, 216, 47)
FG = (11, 15, 20)

# 归一化坐标（与 src/web/index.html 里的 logo 同一套几何）
POLY = [(0.281, 0.672), (0.4125, 0.406), (0.506, 0.569), (0.578, 0.4625), (0.719, 0.672)]
STROKE = 0.075
DOT = (0.681, 0.34375, 0.06875)
RADIUS = 0.28


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def in_round_rect(x, y, r):
    if x < 0 or y < 0 or x > 1 or y > 1:
        return False
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist_point_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def on_polyline(x, y):
    half = STROKE / 2
    for i in range(len(POLY) - 1):
        if dist_point_seg(x, y, *POLY[i], *POLY[i + 1]) <= half:
            return True
    return False


def render(size):
    px = bytearray()
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0
        for x in range(size):
            acc_bg = 0.0
            acc_fg = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    if not in_round_rect(u, v, RADIUS):
                        continue
                    acc_bg += 1.0
                    if on_polyline(u, v) or math.hypot(u - DOT[0], v - DOT[1]) <= DOT[2]:
                        acc_fg += 1.0
            total = SS * SS
            alpha = acc_bg / total
            if alpha <= 0.001:
                row.extend((0, 0, 0, 0))
                continue
            base = lerp(BG_TOP, BG_BOTTOM, y / max(1, size - 1))
            fg_ratio = (acc_fg / acc_bg) if acc_bg else 0.0
            color = lerp(base, FG, fg_ratio)
            row.extend((int(color[0]), int(color[1]), int(color[2]), int(alpha * 255)))
        px.extend(row)
    return bytes(px)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(blob)
    return len(blob)


if __name__ == "__main__":
    targets = [
        (os.path.join(ROOT, "package", "ICON.PNG"), 64),
        (os.path.join(ROOT, "package", "ICON_256.PNG"), 256),
        (os.path.join(ROOT, "package", "app", "ui", "images", "icon_64.png"), 64),
        (os.path.join(ROOT, "package", "app", "ui", "images", "icon_256.png"), 256),
    ]
    for path, size in targets:
        n = write_png(path, size)
        print(f"{os.path.relpath(path, ROOT)}  {size}x{size}  {n / 1024:.1f}KB")
