#!/usr/bin/env python3
"""
从 AWS Terrain Tiles (SRTM/3DEP, Terrarium 编码) 下载贺兰山区域高程并导出紧凑二进制。

Terrarium 编码:  elevation_m = (R * 256 + G + B / 256) - 32768

用法:
    python tools/fetch_terrain.py            # 默认 z=10 覆盖贺兰山全域
"""
import io
import json
import math
import os
import struct
import sys
import urllib.request

from PIL import Image

# 贺兰山主体范围（含东麓银川平原西缘与西侧阿拉善戈壁，保证山体有起伏对比）
LON_MIN, LON_MAX = 105.55, 106.15
LAT_MIN, LAT_MAX = 38.15, 39.35
ZOOM = 10
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", ".tiles")
OUT_BIN = os.path.join(ROOT, "data", "helan_heightmap.bin")
OUT_META = os.path.join(ROOT, "data", "helan_meta.json")


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    url = TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            return path
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f"    retry {attempt + 1}: {e}", file=sys.stderr)
    return path


def decode_terrarium(img):
    """RGB PNG -> float elevation in metres."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    out = [[0.0] * w for _ in range(h)]
    for j in range(h):
        row = out[j]
        for i in range(w):
            r, g, b = px[i, j]
            row[i] = (r * 256.0 + g + b / 256.0) - 32768.0
    return out


def main():
    tx0, ty0 = lonlat_to_tile(LON_MIN, LAT_MAX, ZOOM)   # 左上
    tx1, ty1 = lonlat_to_tile(LON_MAX, LAT_MIN, ZOOM)   # 右下
    x0, y0 = int(tx0), int(ty0)
    x1, y1 = int(tx1), int(ty1)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    TS = 256
    W, H = nx * TS, ny * TS
    print(f"zoom={ZOOM}  tiles={nx}x{ny} ({nx*ny})  pixels={W}x{H}")

    grid = [[0.0] * W for _ in range(H)]
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            p = fetch_tile(ZOOM, tx, ty)
            img = Image.open(p)
            elev = decode_terrarium(img)
            ox, oy = (tx - x0) * TS, (ty - y0) * TS
            for j in range(TS):
                grid[oy + j][ox:ox + TS] = elev[j]
            print(f"  tile {tx},{ty} ok")

    # 裁剪到精确经纬度边界
    px0 = int((tx0 - x0) * TS)
    px1 = int((tx1 - x0) * TS)
    py0 = int((ty0 - y0) * TS)
    py1 = int((ty1 - y0) * TS)
    crop = [row[px0:px1] for row in grid[py0:py1]]
    ch, cw = len(crop), len(crop[0])
    print(f"cropped to {cw}x{ch}")

    # 归一化到 uint16（米），并记录高度范围
    flat = [v for row in crop for v in row]
    emin, emax = min(flat), max(flat)
    print(f"elevation range: {emin:.0f} .. {emax:.0f} m")

    with open(OUT_BIN, "wb") as f:
        f.write(struct.pack("<IIff", cw, ch, emin, emax))
        for row in crop:
            f.write(struct.pack(f"<{cw}H", *[max(0, min(65535, int(round(v)))) for v in row]))

    meta = {
        "width": cw,
        "height": ch,
        "zoom": ZOOM,
        "tile_x0": x0, "tile_y0": y0, "tile_x1": x1, "tile_y1": y1,
        "lon_min": LON_MIN, "lon_max": LON_MAX,
        "lat_min": LAT_MIN, "lat_max": LAT_MAX,
        "elev_min": round(emin, 1), "elev_max": round(emax, 1),
        "source": "AWS Terrain Tiles (SRTM 1arcsec / 3DEP), Terrarium encoding",
        "encoding": "uint16 little-endian, row-major, offset 16-byte header (uint32 w,h; float32 emin,emax)",
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    size = os.path.getsize(OUT_BIN)
    print(f"wrote {OUT_BIN} ({size/1024:.0f} KB)")
    print(f"wrote {OUT_META}")


if __name__ == "__main__":
    main()
