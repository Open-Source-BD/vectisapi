import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** `.code-scroll` / `.code-gutter > div` line height in response-pane.css; used until the real value is read. */
const FALLBACK_LINE_HEIGHT = 20;
/** Longer lines are split into several display rows so every row keeps the fixed height. */
export const MAX_ROW_CHARS = 1000;
/** Above this the scroll height is compressed: engines cap element heights (~17–33M px). */
const MAX_SCROLL_HEIGHT = 8_000_000;

interface VirtualLinesProps {
  lines: string[];
  /** Row → HTML. Called only for mounted rows; must escape its input. Defaults to plain escaping. */
  renderLine?: (line: string) => string;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /** Viewport height assumed until the element has been measured. */
  fallbackHeight?: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Rows {
  text: string[];
  /** 1-based source line number per row; 0 marks a continuation of a split line. Null = row i is line i + 1. */
  lineNo: Int32Array | null;
}

function toRows(lines: string[]): Rows {
  if (!lines.some((l) => l.length > MAX_ROW_CHARS)) return { text: lines, lineNo: null };
  const text: string[] = [];
  const nums: number[] = [];
  lines.forEach((line, i) => {
    if (line.length <= MAX_ROW_CHARS) {
      text.push(line);
      nums.push(i + 1);
      return;
    }
    for (let at = 0; at < line.length; at += MAX_ROW_CHARS) {
      text.push(line.slice(at, at + MAX_ROW_CHARS));
      nums.push(at === 0 ? i + 1 : 0);
    }
  });
  return { text, lineNo: Int32Array.from(nums) };
}

/**
 * Fixed-line-height text virtualizer with the CodeView markup (`code-scroll` / `code-gutter` /
 * `code-body`): only the rows intersecting the viewport (plus overscan) are in the DOM, and
 * `renderLine` (e.g. syntax highlighting) runs only for those rows.
 */
export function VirtualLines({ lines, renderLine = escapeHtml, overscan = 20, fallbackHeight = 600 }: VirtualLinesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [lineHeight, setLineHeight] = useState(FALLBACK_LINE_HEIGHT);
  const rows = useMemo(() => toRows(lines), [lines]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(lh) && lh > 0) setLineHeight(lh);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const count = rows.text.length;
  const height = viewport || fallbackHeight;
  const fullHeight = count * lineHeight;
  const contentHeight = Math.min(fullHeight, MAX_SCROLL_HEIGHT);
  const visible = Math.ceil(height / lineHeight);

  let first: number;
  if (fullHeight > MAX_SCROLL_HEIGHT) {
    // Compressed: map the scroll fraction onto the row range.
    const frac = Math.min(1, scrollTop / Math.max(1, contentHeight - height));
    first = Math.floor(frac * Math.max(0, count - visible));
  } else {
    first = Math.floor(scrollTop / lineHeight);
  }
  first = Math.min(Math.max(0, first), Math.max(0, count - 1));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  const top = fullHeight > MAX_SCROLL_HEIGHT ? Math.max(0, scrollTop - (first - start) * lineHeight) : start * lineHeight;
  const bottom = Math.max(0, contentHeight - top - (end - start) * lineHeight);

  const numbers: number[] = [];
  const bodies: string[] = [];
  for (let i = start; i < end; i++) {
    numbers.push(rows.lineNo ? rows.lineNo[i] : i + 1);
    bodies.push(renderLine(rows.text[i]));
  }
  const rowStyle = { height: lineHeight };

  return (
    <div ref={ref} className="code-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="code-gutter" aria-hidden="true">
        <div style={{ height: top }} />
        {numbers.map((n, i) => (
          <div key={start + i} style={rowStyle}>
            {n || ''}
          </div>
        ))}
        <div style={{ height: bottom }} />
      </div>
      <pre className="code-body">
        <div style={{ height: top }} />
        {bodies.map((html, i) => (
          <div key={start + i} style={rowStyle} dangerouslySetInnerHTML={{ __html: html }} />
        ))}
        <div style={{ height: bottom }} />
      </pre>
    </div>
  );
}
