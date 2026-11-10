import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: T[];
  /** Fixed pixel height of each item (items may differ). */
  heightOf: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /** Viewport height assumed until the element has been measured. */
  fallbackHeight?: number;
}

/** Scroll container that mounts only the rows intersecting the viewport (plus overscan). */
export function WindowedList<T>({
  items,
  heightOf,
  keyOf,
  renderItem,
  className,
  overscan = 8,
  fallbackHeight = 600,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // offsets[i] = top of item i; offsets[n] = total height.
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + heightOf(items[i]);
    return out;
  }, [items, heightOf]);

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
      {items.slice(start, end).map((item) => (
        <div key={keyOf(item)}>{renderItem(item)}</div>
      ))}
      <div style={{ height: offsets[items.length] - offsets[end] }} />
    </div>
  );
}
