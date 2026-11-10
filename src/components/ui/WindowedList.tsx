import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: T[];
  /** Height assumed for an item until it has been measured. */
  estimateHeight: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /** Viewport height assumed until the element has been measured. */
  fallbackHeight?: number;
}

/**
 * Scroll container that mounts only the rows intersecting the viewport (plus overscan). Rows keep
 * their natural CSS size: each is measured (ResizeObserver), the height is cached per key and the
 * offsets of the following rows are recomputed. Each row sits in a plain block `div` with no
 * styling, so it is layout-neutral (the row's own box defines its height).
 */
export function WindowedList<T>({
  items,
  estimateHeight,
  keyOf,
  renderItem,
  className,
  overscan = 8,
  fallbackHeight = 600,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const rowObserver = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    const rows = new ResizeObserver((entries) => {
      const measured: [string, number][] = [];
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const key = target.dataset.key;
        if (key !== undefined && target.offsetHeight > 0) measured.push([key, target.offsetHeight]);
      }
      setHeights((prev) => {
        if (measured.every(([k, h]) => prev.get(k) === h)) return prev;
        const next = new Map(prev);
        for (const [k, h] of measured) next.set(k, h);
        return next;
      });
    });
    rowObserver.current = rows;
    return () => {
      ro.disconnect();
      rows.disconnect();
      rowObserver.current = null;
    };
  }, []);

  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node) rowObserver.current?.observe(node);
  }, []);

  // offsets[i] = top of item i; offsets[n] = total height.
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) {
      out[i + 1] = out[i] + (heights.get(keyOf(items[i])) ?? estimateHeight(items[i]));
    }
    return out;
  }, [items, estimateHeight, keyOf, heights]);

  const height = viewport || fallbackHeight;
  // First item whose bottom edge is below the scroll position (binary search).
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - overscan);
  let end = lo;
  while (end < items.length && offsets[end] < scrollTop + height) end++;
  end = Math.min(items.length, end + overscan);

  return (
    <div ref={ref} className={className} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: offsets[start] }} />
      {items.slice(start, end).map((item) => {
        const key = keyOf(item);
        return (
          <div key={key} data-key={key} ref={measure}>
            {renderItem(item)}
          </div>
        );
      })}
      <div style={{ height: offsets[items.length] - offsets[end] }} />
    </div>
  );
}
