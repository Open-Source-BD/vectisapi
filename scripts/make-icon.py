#!/usr/bin/env python3
"""Draw the 1024x1024 app icon source: a rounded square in the primary colour
(--md-sys-color-primary, #0061a4) with a white "V". Needs Pillow.

    python3 scripts/make-icon.py /tmp/vectis-icon.png && npm run tauri icon /tmp/vectis-icon.png
"""
import sys

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # supersampling for smooth edges
PRIMARY = (0x00, 0x61, 0xA4, 255)
WHITE = (255, 255, 255, 255)


def main(out: str) -> None:
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 100 * SS  # macOS-style margin around the tile
    d.rounded_rectangle((pad, pad, s - pad, s - pad), radius=180 * SS, fill=PRIMARY)
    # "V": two thick strokes meeting at the bottom.
    top, bottom = 300 * SS, 730 * SS
    left, right, mid = 300 * SS, 724 * SS, 512 * SS
    w = 62 * SS
    d.line([(left, top), (mid, bottom), (right, top)], fill=WHITE, width=2 * w, joint="curve")
    for x in (left, right):
        d.ellipse((x - w, top - w, x + w, top + w), fill=WHITE)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "app-icon.png")
