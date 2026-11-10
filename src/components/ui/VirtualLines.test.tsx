import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MAX_ROW_CHARS, VirtualLines } from './VirtualLines';
import { CodeView, VIRTUALIZE_MIN_LINES } from './CodeView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bodyRows = (host: HTMLElement) => host.querySelectorAll('.code-body > div[style*="height: 20px"]');
const gutterRows = (host: HTMLElement) => host.querySelectorAll('.code-gutter > div[style*="height: 20px"]');

describe('VirtualLines', () => {
  let root: Root | undefined;
  let host: HTMLElement;
  const render = (el: React.ReactNode) => {
    host = document.createElement('div');
    root = createRoot(host);
    act(() => root!.render(el));
  };
  afterEach(() => act(() => root?.unmount()));

  it('renders only visible rows', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
    render(<VirtualLines lines={lines} />);
    const rows = bodyRows(host);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(rows[0].textContent).toBe('line 0');
    expect(gutterRows(host)[0].textContent).toBe('1');
  });

  it('scrolls to later rows and highlights only the mounted ones', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `"k${i}": ${i}`);
    const seen: string[] = [];
    const renderLine = (l: string) => {
      seen.push(l);
      return `<span class="json-number">${l}</span>`;
    };
    render(<VirtualLines lines={lines} renderLine={renderLine} />);
    const scroller = host.querySelector('.code-scroll')!;
    scroller.scrollTop = 50_000 * 20;
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    const numbers = [...gutterRows(host)].map((r) => Number(r.textContent));
    expect(numbers).toContain(50_001);
    expect(host.querySelector('.code-body .json-number')).not.toBeNull();
    expect(seen.length).toBeLessThan(400);
  });

  it('escapes HTML by default and splits over-long lines into numbered-once rows', () => {
    const long = 'x'.repeat(MAX_ROW_CHARS * 2 + 5);
    render(<VirtualLines lines={['<b>&</b>', long]} />);
    expect(bodyRows(host)[0].innerHTML).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect([...gutterRows(host)].map((r) => r.textContent)).toEqual(['1', '2', '', '']);
    expect(bodyRows(host)).toHaveLength(4);
  });

  it('compressed scroll range (>8M px): first visible row tracks the scroll fraction, last line reachable', () => {
    const n = 500_000; // 500k × 20px = 10M px > 8M cap → compressed branch
    const lines = Array.from({ length: n }, (_, i) => `l${i}`);
    render(<VirtualLines lines={lines} />);
    const scroller = host.querySelector('.code-scroll')!;
    const spacers = () => host.querySelectorAll<HTMLElement>('.code-gutter > div:not([style*="height: 20px"])');
    const scrollTo = (y: number) => {
      scroller.scrollTop = y;
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    };
    const viewport = 600; // fallbackHeight in jsdom
    const contentHeight = 8_000_000;
    const visible = viewport / 20;
    const maxTop = contentHeight - viewport;
    // Rendered content (spacers + rows) always equals the compressed height.
    const total = () => {
      const [top, bottom] = [...spacers()].map((d) => parseFloat(d.style.height));
      return { top, bottom, rows: gutterRows(host).length };
    };

    for (const frac of [0.5, 0.25]) {
      const y = Math.round(maxTop * frac);
      scrollTo(y);
      const { top, bottom, rows } = total();
      expect(top + rows * 20 + bottom).toBe(contentHeight);
      // The row drawn at pixel `y` is the first visible one.
      const firstVisible = Number(gutterRows(host)[(y - top) / 20].textContent) - 1;
      expect(Math.abs(firstVisible - frac * (n - visible))).toBeLessThanOrEqual(1);
    }

    scrollTo(maxTop);
    const { top, bottom, rows } = total();
    const nums = [...gutterRows(host)].map((r) => Number(r.textContent));
    expect(nums[nums.length - 1]).toBe(n);
    expect(bottom).toBe(0);
    // The last row's bottom edge sits exactly at the viewport's bottom edge.
    expect(top + rows * 20).toBe(maxTop + viewport);
  });

  // Soft perf check (jsdom timing varies by machine). Skipped in CI; run locally.
  it.skipIf(!!process.env.CI)('PERF (soft, skipped in CI): 1,000,000 lines mount < 200 rows in < 50 ms', () => {
    const lines = Array.from({ length: 1_000_000 }, (_, i) => `{"id": ${i}}`);
    const t0 = performance.now();
    render(<VirtualLines lines={lines} />);
    const ms = performance.now() - t0;
    expect(bodyRows(host).length).toBeLessThan(200);
    expect(ms).toBeLessThan(50);
  });
});

describe('CodeView', () => {
  let root: Root | undefined;
  afterEach(() => act(() => root?.unmount()));

  it('keeps the plain DOM at or below the threshold and virtualizes above it', () => {
    const host = document.createElement('div');
    root = createRoot(host);
    const small = Array.from({ length: VIRTUALIZE_MIN_LINES }, (_, i) => `${i}`).join('\n');
    act(() => root!.render(<CodeView text={small} html="<i>x</i>" wrap />));
    expect(host.querySelectorAll('.code-gutter > div')).toHaveLength(VIRTUALIZE_MIN_LINES);
    expect(host.querySelector('pre.code-body.code-body-wrap')!.innerHTML).toBe('<i>x</i>');

    const big = `${small}\nlast`;
    act(() => root!.render(<CodeView text={big} highlight={(t) => `<u>${t}</u>`} wrap />));
    expect(host.querySelectorAll('.code-gutter > div').length).toBeLessThan(200);
    expect(host.querySelector('.code-body > div u')?.textContent).toBe('0');
  });

  it('applies highlight to the whole text when small (same markup as precomputed html)', () => {
    const host = document.createElement('div');
    root = createRoot(host);
    act(() => root!.render(<CodeView text={'a\nb'} highlight={(t) => `<u>${t}</u>`} />));
    expect(host.querySelector('pre.code-body')!.innerHTML).toBe('<u>a\nb</u>');
    expect(host.querySelectorAll('.code-gutter > div')).toHaveLength(2);
  });
});
