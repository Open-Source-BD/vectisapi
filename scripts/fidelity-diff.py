#!/usr/bin/env python3
"""Pixel diff of the reference app vs VectisAPI fidelity captures (needs Pillow).

    FIDELITY_OUT=/tmp/fid npx playwright test -c playwright.tools.config.ts fidelity
    python3 scripts/fidelity-diff.py /tmp/fid

For each `<state>-<theme>-ref.png` / `-va.png` pair: % of pixels whose difference, converted to
luminance (Pillow mode "L"), exceeds 24/255,
and the row bands (y0, y1, x0, x1) where they differ. Run it on raw captures: the committed copies in
docs/fidelity/ are palette-quantized, which adds its own noise.
"""
import pathlib
import sys

from PIL import Image, ImageChops

THRESHOLD = 24


def bands(mask: Image.Image) -> list[tuple[int, int, int, int]]:
    w, h = mask.size
    rows = [y for y in range(h) if mask.crop((0, y, w, y + 1)).getbbox()]
    out: list[list[int]] = []
    for y in rows:
        if out and y - out[-1][1] <= 3:
            out[-1][1] = y
        else:
            out.append([y, y])
    result = []
    for y0, y1 in out:
        box = mask.crop((0, y0, w, y1 + 1)).getbbox()
        result.append((y0, y1, box[0], box[2]))
    return result


def main(folder: str) -> None:
    root = pathlib.Path(folder)
    for ref_path in sorted(root.glob("*-ref.png")):
        va_path = ref_path.with_name(ref_path.name.replace("-ref.png", "-va.png"))
        if not va_path.exists():
            continue
        a = Image.open(ref_path).convert("RGB")
        b = Image.open(va_path).convert("RGB")
        mask = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > THRESHOLD else 0)
        hist = mask.histogram()
        pct = hist[255] / (a.size[0] * a.size[1]) * 100
        print(f"{ref_path.name[:-7]}: {pct:.2f}% {bands(mask)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "docs/fidelity")
