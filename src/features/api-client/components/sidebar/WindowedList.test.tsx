import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WindowedList } from './WindowedList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WindowedList', () => {
  let root: Root | undefined;
  afterEach(() => act(() => root?.unmount()));

  it('renders only the visible rows of 10,000 and keeps total height', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root!.render(
        <WindowedList
          items={items}
          heightOf={() => 40}
          keyOf={String}
          renderItem={(n) => <span className="row">{n}</span>}
          overscan={2}
          fallbackHeight={400}
        />,
      ),
    );
    const rows = host.querySelectorAll('.row');
    expect(rows.length).toBeLessThan(20);
    expect(rows[0].textContent).toBe('0');

    const scroller = host.firstElementChild as HTMLElement;
    scroller.scrollTop = 40 * 5000;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const after = [...host.querySelectorAll('.row')].map((r) => Number(r.textContent));
    expect(after.length).toBeLessThan(20);
    expect(after).toContain(5000);
    const spacers = [...scroller.children].filter((c) => !c.querySelector('.row')) as HTMLElement[];
    const total = spacers.reduce((n, el) => n + parseFloat(el.style.height), 0) + after.length * 40;
    expect(total).toBe(400_000);
  });
});
