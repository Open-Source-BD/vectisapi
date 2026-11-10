import type { ReactNode } from 'react';

interface KvItem {
  id: string;
  key: string;
  value: string;
  type?: 'text' | 'file';
  file?: File | null;
}

interface KvEditorProps {
  items: KvItem[];
  onChange: (items: KvItem[]) => void;
  allowFile?: boolean;
  renderRowExtra?: (item: KvItem, index: number) => ReactNode;
}

let _id = 0;
const uid = () => `kv-${Date.now().toString(36)}-${++_id}`;

export function KvEditor({ items, onChange, allowFile = false, renderRowExtra }: KvEditorProps) {
  const patch = (idx: number, updates: Partial<KvItem>) => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...updates } : it));
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {items.map((item, idx) => (
        <div key={item.id} className="kv-row">
          <input
            className="md-input kv-input"
            placeholder="Key"
            value={item.key}
            onChange={(e) => patch(idx, { key: e.target.value })}
          />
          {allowFile && (
            <select
              className="md-select kv-type-select"
              value={item.type || 'text'}
              onChange={(e) => patch(idx, { type: e.target.value as KvItem['type'] })}
            >
              <option value="text">Text</option>
              <option value="file">File</option>
            </select>
          )}
          {item.type === 'file' ? (
            <input
              type="file"
              className="md-input kv-input"
              onChange={(e) => patch(idx, { file: e.target.files?.[0] ?? null })}
            />
          ) : (
            <input
              className="md-input kv-input"
              placeholder="Value"
              value={item.value}
              onChange={(e) => patch(idx, { value: e.target.value })}
            />
          )}
          {renderRowExtra?.(item, idx)}
          <button
            className="md-icon-btn danger delete-row-btn"
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      ))}
      <button
        className="md-text-btn add-row-btn"
        onClick={() => onChange([...items, { id: uid(), key: '', value: '', type: 'text' }])}
      >
        <span className="material-symbols-outlined">add</span> Add Row
      </button>
    </div>
  );
}
