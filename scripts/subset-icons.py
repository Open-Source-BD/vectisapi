#!/usr/bin/env python3
"""Subset the Material Symbols Outlined font to the icons the UI uses (offline).

The font draws icons through ligatures ("send" -> send glyph). A plain subset by text keeps every
ligature made of the kept letters, i.e. the whole font, so this prunes the GSUB ligature table to
the wanted names first, then subsets (all variation axes kept).

Icon names are every lowercase identifier literal in src/ (quoted strings and JSX text) that is
an icon name in the font: over-inclusive by a few glyphs, never missing a dynamic name such as
`{theme === 'dark' ? 'light_mode' : 'dark_mode'}`.

Usage (needs `pip install fonttools brotli`):
    python3 scripts/subset-icons.py            # writes src/assets/fonts/material-symbols-subset.woff2
Re-run after using a new icon; `npm run test` checks every literal icon name is in the subset.
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_FONT = ROOT / "node_modules/material-symbols/material-symbols-outlined.woff2"
OUT_FONT = ROOT / "src/assets/fonts/material-symbols-subset.woff2"
OUT_LIST = ROOT / "src/assets/fonts/material-symbols-subset.txt"

WORD = re.compile(r"""['"`]([a-z][a-z0-9_]*)['"`]|>\s*([a-z][a-z0-9_]*)\s*(?:<|\{)""")


def candidate_names() -> set[str]:
    names: set[str] = set()
    for path in (ROOT / "src").rglob("*"):
        if path.suffix in {".ts", ".tsx"}:
            for m in WORD.finditer(path.read_text(encoding="utf-8")):
                names.add(m.group(1) or m.group(2))
    return names


def ligature_subtables(font: TTFont):
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            real = st.ExtSubTable if lookup.LookupType == 7 else st
            if real.LookupType == 4:
                yield real


def main() -> int:
    font = TTFont(SRC_FONT)
    cmap = font.getBestCmap()
    char_glyph = {chr(cp): g for cp, g in cmap.items()}
    glyph_char = {g: c for c, g in char_glyph.items()}

    wanted = candidate_names()
    kept_names: set[str] = set()
    kept_glyphs: set[str] = set()
    for st in ligature_subtables(font):
        pruned = {}
        for first, ligs in st.ligatures.items():
            keep = []
            for lig in ligs:
                try:
                    name = "".join(glyph_char[g] for g in [first, *lig.Component])
                except KeyError:
                    continue
                if name in wanted:
                    keep.append(lig)
                    kept_names.add(name)
                    kept_glyphs.add(lig.LigGlyph)
            if keep:
                pruned[first] = keep
        st.ligatures = pruned

    letters = "abcdefghijklmnopqrstuvwxyz0123456789_ "
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(text=letters, glyphs=sorted(kept_glyphs))
    sub.subset(font)
    OUT_FONT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUT_FONT)
    OUT_LIST.write_text("\n".join(sorted(kept_names)) + "\n", encoding="utf-8")
    print(f"{len(kept_names)} icons -> {OUT_FONT.relative_to(ROOT)} ({OUT_FONT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
