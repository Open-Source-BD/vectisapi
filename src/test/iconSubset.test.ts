import { expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The bundled icon font is a subset (scripts/subset-icons.py). Fail when the UI names an icon the
// subset lacks, so a new icon can't silently render as its ligature text.
const SRC = join(__dirname, '..');
const NAME = /['"`]([a-z][a-z0-9_]*)['"`]|>\s*([a-z][a-z0-9_]*)\s*(?:<|\{)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });
}

test('every icon name used in src is in the subset font', () => {
  const allIcons = new Set(
    [
      ...readFileSync(join(SRC, '../node_modules/material-symbols/index.d.ts'), 'utf8').matchAll(/^\s+"([^"]+)",?$/gm),
    ].map((m) => m[1]),
  );
  const subset = new Set(readFileSync(join(SRC, 'assets/fonts/material-symbols-subset.txt'), 'utf8').split('\n'));
  const used = new Set<string>();
  for (const file of sources(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(NAME)) {
      const name = m[1] ?? m[2];
      if (allIcons.has(name)) used.add(name);
    }
  }
  expect(used.size).toBeGreaterThan(50);
  expect([...used].filter((n) => !subset.has(n))).toEqual([]);
});
