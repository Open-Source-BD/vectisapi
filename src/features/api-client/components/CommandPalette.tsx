import { useEffect, useRef, useState } from 'react';
import { useApiStore } from '../store/useApiStore';
import type { Collection } from '../types';

interface Command {
  key: string;
  label: string;
  hint: string;
  icon: string;
  run: () => void;
}

/** Flatten every request across collections, with a "Collection / Folder" trail. */
function collectRequests(cols: Collection[]): { id: string; name: string; trail: string }[] {
  const out: { id: string; name: string; trail: string }[] = [];
  const walk = (nodes: Collection['children'], trail: string) => {
    for (const n of nodes) {
      if (n.type === 'request') out.push({ id: n.id, name: n.name, trail });
      else walk(n.children, `${trail} / ${n.name}`);
    }
  };
  cols.forEach((c) => walk(c.children, c.name));
  return out;
}

export function CommandPalette() {
  const isOpen = useApiStore((s) => s.isCommandPaletteOpen);
  if (!isOpen) return null;
  return <CommandPaletteInner />;
}

function CommandPaletteInner() {
  const close = useApiStore((s) => s.setCommandPaletteOpen);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const s = useApiStore.getState; // stable action access

  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const dismiss = () => close(false);
  const act = (fn: () => void) => () => {
    dismiss();
    fn();
  };

  const commands: Command[] = [
    { key: 'new-tab', label: 'New request tab', hint: 'create', icon: 'add', run: act(() => s().newTab()) },
    { key: 'save', label: 'Save request', hint: 'save', icon: 'save', run: act(() => s().saveActiveRequest()) },
    {
      key: 'curl',
      label: 'Import cURL',
      hint: 'import curl',
      icon: 'terminal',
      run: act(() => s().setCurlModalOpen(true)),
    },
    {
      key: 'env',
      label: 'Manage environments',
      hint: 'environment variables',
      icon: 'settings',
      run: act(() => s().setEnvModalOpen(true)),
    },
    {
      key: 'theme',
      label: 'Toggle light / dark theme',
      hint: 'theme appearance',
      icon: 'dark_mode',
      run: act(() => s().toggleTheme()),
    },
    {
      key: 'settings',
      label: 'Open settings',
      hint: 'preferences backup import next-postman proxy timeout',
      icon: 'settings',
      run: act(() => s().setSettingsModalOpen(true)),
    },
    {
      key: 'cookies',
      label: 'Manage cookies',
      hint: 'cookie jar session',
      icon: 'cookie',
      run: act(() => s().setCookieModalOpen(true)),
    },
    ...environments.map((e) => ({
      key: `env-${e.id}`,
      label: `Switch to environment: ${e.name}`,
      hint: 'environment',
      icon: 'layers',
      run: act(() => s().setActiveEnv(e.id)),
    })),
    {
      key: 'env-none',
      label: 'Switch to: No Environment',
      hint: 'environment',
      icon: 'layers_clear',
      run: act(() => s().setActiveEnv(null)),
    },
    ...collectRequests(collections).map((r) => ({
      key: `req-${r.id}`,
      label: r.name,
      hint: r.trail,
      icon: 'http',
      run: act(() => s().openRequestNode(r.id)),
    })),
  ];

  const q = query.trim().toLowerCase();
  const results = q ? commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q)) : commands;
  const clampedSel = Math.min(sel, Math.max(0, results.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[clampedSel]?.run();
    }
  };

  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [clampedSel]);

  return (
    <div
      className="md-modal-overlay cmdk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="cmdk-input"
          autoFocus
          placeholder="Search requests, environments, actions…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          aria-activedescendant={results[clampedSel] ? `cmdk-${results[clampedSel].key}` : undefined}
          role="combobox"
          aria-expanded
          aria-controls="cmdk-list"
        />
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">No matches</div>}
          {results.map((c, i) => (
            <button
              key={c.key}
              id={`cmdk-${c.key}`}
              role="option"
              aria-selected={i === clampedSel}
              className={`cmdk-row ${i === clampedSel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={c.run}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                {c.icon}
              </span>
              <span className="cmdk-label">{c.label}</span>
              {c.hint && <span className="cmdk-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
