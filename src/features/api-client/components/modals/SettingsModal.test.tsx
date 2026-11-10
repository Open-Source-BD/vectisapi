import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../../lib/native/invoke')>()),
  setSettings: vi.fn(),
  getSettings: vi.fn(),
  getAppVersion: vi.fn(),
  exportBackup: vi.fn(),
  importBackup: vi.fn(),
  loadWorkspace: vi.fn(),
  saveEntities: vi.fn(),
  openDataDir: vi.fn(),
  pickNextPostmanWorkspace: vi.fn(),
}));

import {
  exportBackup,
  getAppVersion,
  importBackup,
  loadWorkspace,
  openDataDir,
  pickNextPostmanWorkspace,
  saveEntities,
  setSettings,
  type Settings,
  type WorkspaceSnapshot,
} from '../../lib/native/invoke';
import { serializeWorkspace, type WorkspaceData } from '../../lib/workspaceFile';
import { createDefaultTab, useApiStore } from '../../store/useApiStore';
import type { Collection } from '../../types';
import { TopBar } from '../TopBar';
import { SettingsModal } from './SettingsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
const defaults = (): Settings => ({
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  proxyUrl: null,
  userAgent: null,
  responseStoreCapBytes: 512 * MB,
  historyLimit: 1000,
  theme: null,
});

const col = (id: string, name = id) => ({ id, name, children: [], date: '2020-01-01T00:00:00.000Z' }) as Collection;

/** The next-postman workspace from NP's workspaceFile.test.ts `sample()`. */
const npSample = (): WorkspaceData => ({
  collections: [
    {
      id: 'c1',
      name: 'API',
      description: 'my api',
      date: '2020-01-01T00:00:00.000Z',
      children: [
        {
          id: 'f1',
          type: 'folder',
          name: 'Auth',
          children: [
            {
              id: 'req1',
              type: 'request',
              name: 'Login',
              request: { ...createDefaultTab(), id: 'req1', method: 'POST', url: '{{baseUrl}}/login' },
            },
          ],
        },
      ],
    } as Collection,
  ],
  environments: [
    {
      id: 'e1',
      name: 'Prod',
      vars: [
        { id: 'v1', key: 'baseUrl', value: 'https://api.x' },
        { id: 'v2', key: 'authToken', value: 'secret-t' },
      ],
    },
  ],
  globals: [{ id: 'g1', key: 'apiKey', value: 'KKK' }],
});

describe('Settings chip and modal', () => {
  let root: Root;
  let host: HTMLElement;
  const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T & HTMLElement>(sel);
  const button = (label: string) => {
    const b = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes(label));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
  };
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  const type = (sel: string, value: string) => {
    const el = $<HTMLInputElement>(sel)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const open = () => act(() => useApiStore.getState().setSettingsModalOpen(true));
  const status = () => $('[aria-live="polite"]')?.textContent ?? '';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAppVersion).mockResolvedValue('0.1.0');
    vi.mocked(setSettings).mockResolvedValue();
    vi.mocked(saveEntities).mockResolvedValue();
    useApiStore.setState({
      settings: defaults(),
      isSettingsModalOpen: false,
      collections: [],
      environments: [],
      globals: [],
      expanded: {},
      theme: 'light',
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <>
          <TopBar />
          <SettingsModal />
        </>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("SettingsChip renders in TopBar with chip classes and 'Settings' label", async () => {
    const chip = $('.top-bar-actions > button.ws-chip')!;
    expect(chip.textContent).toContain('Settings');
    expect(chip.querySelector('.material-symbols-outlined')?.textContent).toBe('settings');
    expect(host.textContent).not.toContain('Connect folder');
    await click(chip);
    expect(useApiStore.getState().isSettingsModalOpen).toBe(true);
    expect($('.md-modal-overlay .md-modal .md-modal-header h3')?.textContent).toBe('Settings');
  });

  it('SettingsModal saves timeout/redirects/verify TLS/proxy/user agent/store cap/history limit', async () => {
    open();
    await act(async () => {}); // version
    expect($<HTMLInputElement>('#set-ua')!.placeholder).toBe('VectisAPI/0.1.0');
    type('#set-timeout', '0');
    await click($('input[aria-label="Follow redirects"]')!);
    expect($<HTMLInputElement>('#set-max-redirects')!.disabled).toBe(true);
    await click($('input[aria-label="Follow redirects"]')!);
    type('#set-max-redirects', '3');
    await click($('input[aria-label="Verify TLS certificates"]')!);
    expect($('[role="note"]')?.textContent).toMatch(/Certificate checks are off/);
    type('#set-proxy', 'socks5://127.0.0.1:1080');
    type('#set-ua', 'MyAgent/1');
    type('#set-cap', '256');
    type('#set-history', '2500');
    await click(button('Save'));

    const saved: Settings = { ...defaults(), timeoutMs: 0, maxRedirects: 3, verifyTls: false };
    Object.assign(saved, {
      proxyUrl: 'socks5://127.0.0.1:1080',
      userAgent: 'MyAgent/1',
      responseStoreCapBytes: 256 * MB,
      historyLimit: 2500,
    });
    expect(setSettings).toHaveBeenCalledWith(saved);
    expect(useApiStore.getState().settings).toEqual(saved);
    expect(useApiStore.getState().isSettingsModalOpen).toBe(false);
  });

  it('history limit clamps to 50–10000 (and store cap to 64–4096 MB)', async () => {
    open();
    type('#set-history', '5');
    type('#set-cap', '1');
    await click(button('Save'));
    expect(vi.mocked(setSettings).mock.calls[0][0]).toMatchObject({ historyLimit: 50, responseStoreCapBytes: 64 * MB });

    open();
    type('#set-history', '999999');
    type('#set-cap', '100000');
    await click(button('Save'));
    expect(vi.mocked(setSettings).mock.calls[1][0]).toMatchObject({
      historyLimit: 10_000,
      responseStoreCapBytes: 4096 * MB,
    });
  });

  it('rejects a bad proxy URL or timeout and keeps the old settings when saving fails', async () => {
    open();
    type('#set-proxy', 'ftp://x');
    expect(button('Save').disabled).toBe(true);
    expect(status()).toMatch(/Proxy URL/);
    type('#set-proxy', '');
    type('#set-timeout', '-1');
    expect(button('Save').disabled).toBe(true);
    type('#set-timeout', '100');
    vi.mocked(setSettings).mockRejectedValueOnce({ kind: 'io', message: 'disk full' });
    await click(button('Save'));
    expect(status()).toContain('disk full');
    expect(useApiStore.getState().settings).toEqual(defaults());
    expect(useApiStore.getState().isSettingsModalOpen).toBe(true);
  });

  it('import next-postman workspace zip populates collections and environments', async () => {
    useApiStore.setState({
      collections: [col('mine')],
      globals: [{ id: 'gx', key: 'apiKey', value: 'already-set' }],
    });
    // As Rust returns it: an OS-made zip adds a top folder; secrets live in *.secret.json.
    const files = serializeWorkspace(npSample()).map((f) => ({ path: `my-ws/${f.path}`, text: f.content }));
    expect(files.some((f) => f.path.endsWith('.secret.json'))).toBe(true);
    vi.mocked(pickNextPostmanWorkspace).mockResolvedValue(files);
    open();
    await click(button('Import next-postman workspace (zip)'));
    expect(pickNextPostmanWorkspace).toHaveBeenCalledWith('zip');

    const s = useApiStore.getState();
    expect(s.collections.map((c) => c.id)).toEqual(['c1', 'mine']);
    expect(s.collections[0]).toMatchObject({ name: 'API', description: 'my api' });
    const folder = s.collections[0].children[0];
    expect(folder.type === 'folder' && folder.children[0]).toMatchObject({ id: 'req1', name: 'Login' });
    expect(s.environments).toHaveLength(1);
    expect(s.environments[0].vars.map((v) => [v.key, v.value])).toEqual([
      ['baseUrl', 'https://api.x'],
      ['authToken', 'secret-t'],
    ]);
    expect(s.globals).toEqual([{ id: 'gx', key: 'apiKey', value: 'already-set' }]);
    expect(s.expanded.c1).toBe(true);
    expect(status()).toContain('Imported 1 collection(s) and 1 environment(s)');

    // Re-importing (here from the folder) replaces by id instead of duplicating.
    vi.mocked(pickNextPostmanWorkspace).mockResolvedValue(files.map((f) => ({ ...f, path: f.path.slice(6) })));
    await click(button('Import next-postman workspace (folder)'));
    expect(pickNextPostmanWorkspace).toHaveBeenLastCalledWith('folder');
    expect(useApiStore.getState().collections.map((c) => c.id)).toEqual(['c1', 'mine']);
    expect(useApiStore.getState().environments).toHaveLength(1);
  });

  it('next-postman import reports a cancel as nothing and an empty selection or Rust error as an error', async () => {
    open();
    vi.mocked(pickNextPostmanWorkspace).mockResolvedValueOnce(null);
    await click(button('Import next-postman workspace (zip)'));
    expect(status()).toBe('');
    vi.mocked(pickNextPostmanWorkspace).mockResolvedValueOnce([{ path: 'package.json', text: '{}' }]);
    await click(button('Import next-postman workspace (folder)'));
    expect(status()).toMatch(/No next-postman workspace found/);
    vi.mocked(pickNextPostmanWorkspace).mockRejectedValueOnce({ kind: 'other', message: 'Workspace too large' });
    await click(button('Import next-postman workspace (zip)'));
    expect(status()).toBe('Workspace too large');
    expect(useApiStore.getState().collections).toEqual([]);
  });

  it('backup export then import restores everything', async () => {
    const original = {
      collections: [col('c1', 'Saved')],
      environments: [{ id: 'e1', name: 'Prod', vars: [{ id: 'v', key: 'k', value: 'v' }] }],
      globals: [{ id: 'g', key: 'G', value: '1' }],
    };
    useApiStore.setState(original);
    // Fake backup file: export captures the store; import serves it back through load_workspace.
    let backup: WorkspaceSnapshot | null = null;
    vi.mocked(exportBackup).mockImplementation(async () => {
      const s = useApiStore.getState();
      backup = {
        collections: s.collections,
        environments: s.environments,
        globals: s.globals,
        activeEnvId: 'e1',
        history: [],
        tabs: [],
        uiState: { theme: 'dark' },
        settings: { ...defaults(), historyLimit: 77 },
      };
      return '/tmp/vectisapi-backup.json';
    });
    vi.mocked(importBackup).mockResolvedValue('/tmp/vectisapi-backup.json');
    vi.mocked(loadWorkspace).mockImplementation(async () => backup!);

    open();
    await click(button('Export all'));
    expect(status()).toBe('Backup exported.');

    useApiStore.setState({ collections: [col('other')], environments: [], globals: [] });
    await click(button('Import all'));
    expect(importBackup).not.toHaveBeenCalled(); // asks first
    await click(button('Choose backup…'));
    expect(importBackup).toHaveBeenCalledTimes(1);

    const s = useApiStore.getState();
    expect(s.collections).toEqual(original.collections);
    expect(s.environments).toEqual(original.environments);
    expect(s.globals).toEqual(original.globals);
    expect(s.activeEnvId).toBe('e1');
    expect(s.theme).toBe('dark');
    expect(s.settings?.historyLimit).toBe(77);
    expect(s.isSettingsModalOpen).toBe(false);
  });

  it('a cancelled backup import changes nothing; Open data folder calls Rust', async () => {
    useApiStore.setState({ collections: [col('keep')] });
    vi.mocked(importBackup).mockResolvedValue(null);
    vi.mocked(openDataDir).mockResolvedValue();
    open();
    await click(button('Import all'));
    await click(button('Choose backup…'));
    expect(loadWorkspace).not.toHaveBeenCalled();
    expect(useApiStore.getState().collections.map((c) => c.id)).toEqual(['keep']);
    await click(button('Open data folder'));
    expect(openDataDir).toHaveBeenCalledTimes(1);
  });

  it('theme select uses the same theme state as the TopBar toggle', async () => {
    open();
    const select = $<HTMLSelectElement>('#set-theme')!;
    act(() => {
      select.value = 'dark';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useApiStore.getState().theme).toBe('dark');
    expect($('button[title="Toggle theme"] .material-symbols-outlined')?.textContent).toBe('light_mode');
  });
});
