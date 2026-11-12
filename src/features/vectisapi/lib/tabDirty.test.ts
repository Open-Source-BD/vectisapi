import { describe, expect, it } from 'vitest';
import { requestKey, isTabDirty } from './tabDirty';
import { createDefaultTab } from '../store/useApiStore';
import type { Collection, TabState } from '../types';
import { makeRequest, makeFolder } from './collectionTree';

const tab = (overrides: Partial<TabState> = {}): TabState => ({
  ...createDefaultTab(),
  id: 't1',
  url: 'https://example.com',
  ...overrides,
});

const collection = (children: Collection['children']): Collection => ({
  id: 'c1',
  name: 'Test',
  date: '2026-01-01',
  children,
});

describe('requestKey', () => {
  it('returns same key for identical tabs', () => {
    const a = tab({ method: 'POST', url: 'https://a.com' });
    const b = tab({ method: 'POST', url: 'https://a.com' });
    expect(requestKey(a)).toBe(requestKey(b));
  });

  it('returns different key for different urls', () => {
    const a = tab({ url: 'https://a.com' });
    const b = tab({ url: 'https://b.com' });
    expect(requestKey(a)).not.toBe(requestKey(b));
  });

  it('returns different key for different methods', () => {
    const a = tab({ method: 'GET' });
    const b = tab({ method: 'POST' });
    expect(requestKey(a)).not.toBe(requestKey(b));
  });

  it('ignores response, sourceNodeId, activeSubTab', () => {
    const a = tab({
      response: null,
      sourceNodeId: 'x',
      activeSubTab: 'params',
    });
    const b = tab({
      response: {
        ok: true,
        status: 200,
        statusText: 'OK',
        timeTaken: 1,
        size: 1,
        rawText: '{}',
        headers: {},
        testResults: [],
      },
      sourceNodeId: undefined,
      activeSubTab: 'body',
    });
    expect(requestKey(a)).toBe(requestKey(b));
  });
});

describe('isTabDirty', () => {
  it('is false for unsaved tab with default values', () => {
    const t = createDefaultTab();
    expect(isTabDirty(t, [])).toBe(false);
  });

  it('is true for unsaved tab that has been edited', () => {
    const t = tab({ url: 'https://edited.com' });
    expect(isTabDirty(t, [])).toBe(true);
  });

  it('is false when tab matches its source node', () => {
    const src: TabState = tab();
    const request = makeRequest('Get Users', src);
    const tabWithSrc = { ...src, sourceNodeId: request.id };
    const cols = [collection([request])];
    expect(isTabDirty(tabWithSrc, cols)).toBe(false);
  });

  it('is true when tab differs from its source node', () => {
    const src: TabState = tab({ url: 'https://original.com' });
    const request = makeRequest('Get Users', src);
    const cols = [collection([request])];
    const edited = tab({ sourceNodeId: request.id, url: 'https://edited.com' });
    expect(isTabDirty(edited, cols)).toBe(true);
  });

  it('is true when sourceNodeId points to a folder (not found as request)', () => {
    const folder = makeFolder('f1');
    const cols = [collection([folder])];
    const t = tab({ sourceNodeId: 'f1' });
    expect(isTabDirty(t, cols)).toBe(true);
  });
});
