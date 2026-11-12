export type DiffType = 'same' | 'add' | 'del';
export interface DiffLine {
  type: DiffType;
  text: string;
}

/**
 * Line-level diff via longest-common-subsequence. Returns an ordered list of
 * lines tagged same / del (only in `a`) / add (only in `b`). O(n*m) — fine for
 * response bodies, not meant for huge files.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length;
  const m = bl.length;

  // dp[i][j] = LCS length of al[i:] and bl[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ type: 'same', text: al[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: al[i] });
      i++;
    } else {
      out.push({ type: 'add', text: bl[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: al[i++] });
  while (j < m) out.push({ type: 'add', text: bl[j++] });
  return out;
}

/** Counts of changed lines, for a summary line. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
  };
}
