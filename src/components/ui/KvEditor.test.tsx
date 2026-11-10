import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickFile } from '@/features/api-client/lib/native/invoke';
import { KvEditor } from './KvEditor';

vi.mock('@/features/api-client/lib/native/invoke', () => ({ pickFile: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('KvEditor file cell', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it('shows chosen file name', () => {
    const item = { id: '1', key: 'f', value: '', type: 'file' as const, filePath: '/tmp/a.png', fileName: 'a.png' };
    act(() => root.render(<KvEditor items={[item]} onChange={() => {}} allowFile />));
    expect(host.querySelector('.kv-file-btn')?.textContent).toBe('a.png');
  });

  it('picking a file stores path and basename', async () => {
    vi.mocked(pickFile).mockResolvedValue({ path: '/tmp/b.txt', name: 'b.txt' });
    const onChange = vi.fn();
    const item = { id: '1', key: 'f', value: '', type: 'file' as const };
    act(() => root.render(<KvEditor items={[item]} onChange={onChange} allowFile />));
    const btn = host.querySelector('.kv-file-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('Choose file');
    await act(async () => btn.click());
    expect(onChange).toHaveBeenCalledWith([{ ...item, filePath: '/tmp/b.txt', fileName: 'b.txt' }]);
  });

  it('cancelled dialog changes nothing', async () => {
    vi.mocked(pickFile).mockResolvedValue(null);
    const onChange = vi.fn();
    act(() =>
      root.render(<KvEditor items={[{ id: '1', key: 'f', value: '', type: 'file' }]} onChange={onChange} allowFile />),
    );
    await act(async () => (host.querySelector('.kv-file-btn') as HTMLButtonElement).click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
