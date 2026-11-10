import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WindowedList } from './WindowedList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Captures observers so a test can report measured sizes. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(targets: Element[]) {
    this.cb(targets.map((target) => ({ target }) as ResizeObserverEntry), this as never);
  }
}

describe('WindowedList', () => {
  let root: Root | undefined;
  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it('windows 10,000 mixed-height rows and shifts followers when a measured height changes', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root!.render(
        <WindowedList
          items={items}
          estimateHeight={(n) => (n % 10 === 0 ? 25 : 34)}
          keyOf={String}
          renderItem={(n) => <span className="row">{n}</span>}
          overscan={2}
          fallbackHeight={400}
        />,
      ),
    );
    expect(host.querySelectorAll('.row').length).toBeLessThan(25);
    const scroller = host.firstElementChild as HTMLElement;
    const rowsObserver = FakeResizeObserver.all[1];

    // Row 1 turns out to be 100px tall.
    const wrapper = host.querySelector('[data-key="1"]') as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { configurable: true, value: 100 });
    act(() => rowsObserver.fire([wrapper]));

    scroller.scrollTop = 50_000;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const rendered = [...host.querySelectorAll('.row')].map((r) => Number(r.textContent));
    expect(rendered.length).toBeLessThan(25);
    const first = rendered[0];
    const estimated = (n: number) => (n % 10 === 0 ? 25 : 34);
    let expectedTop = 0;
    for (let i = 0; i < first; i++) expectedTop += i === 1 ? 100 : estimated(i);
    expect(parseFloat((scroller.firstElementChild as HTMLElement).style.height)).toBe(expectedTop);
  });
});
