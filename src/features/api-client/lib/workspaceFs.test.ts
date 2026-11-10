import { describe, expect, it, vi } from 'vitest';
import { isFsSupported, handleName, ensurePermission } from './workspaceFs';
import type { WorkspaceHandle } from './workspaceFs';

describe('isFsSupported', () => {
  it('returns false in jsdom (no showDirectoryPicker)', () => {
    expect(isFsSupported()).toBe(false);
  });
});

describe('handleName', () => {
  it('returns name when handle is provided', () => {
    const handle = { name: 'my-workspace' } as WorkspaceHandle;
    expect(handleName(handle)).toBe('my-workspace');
  });

  it('returns empty string for null', () => {
    expect(handleName(null)).toBe('');
  });
});

describe('ensurePermission', () => {
  it('returns true when permission is granted', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('granted'),
    } as unknown as WorkspaceHandle;
    await expect(ensurePermission(handle)).resolves.toBe(true);
  });

  it('requests permission when not granted', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('granted'),
    } as unknown as WorkspaceHandle;
    await expect(ensurePermission(handle)).resolves.toBe(true);
    expect(handle.requestPermission).toHaveBeenCalledOnce();
  });

  it('returns false when permission denied', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    } as unknown as WorkspaceHandle;
    await expect(ensurePermission(handle)).resolves.toBe(false);
  });
});
