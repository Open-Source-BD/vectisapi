import { useEffect, useRef, useState } from 'react';
import { useApiStore } from '../../store/useApiStore';

interface VarInputProps {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  spellCheck?: boolean;
  'aria-label'?: string;
  /** Escape pressed while no suggestion list is open. */
  onEscape?: () => void;
}

/** Render text with `{{var}}` tokens wrapped in colored spans (HTML-escaped). */
function highlight(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\{\{([^{}]*)\}\}/g, '<span class="tok-var">{{$1}}</span>');
}

/** Find an open `{{partial` token immediately before the caret (no closing `}}`). */
function openToken(text: string, caret: number): { start: number; partial: string } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('{{');
  if (open === -1) return null;
  const between = before.slice(open + 2);
  if (between.includes('}}')) return null;
  return { start: open, partial: between };
}

/**
 * Text input with `{{variable}}` autocomplete. Suggestions come from globals +
 * the active environment. Reads raw store slices and derives the list locally —
 * a `[...globals, ...vars]` selector would return a new array each render and
 * trip Zustand's "getSnapshot should be cached" loop. Caret/suggestion state is
 * computed in event handlers (never reading the ref during render).
 */
export function VarInput({
  value,
  onValueChange,
  className,
  placeholder,
  spellCheck,
  onEscape,
  ...rest
}: VarInputProps) {
  const globals = useApiStore((s) => s.globals);
  const environments = useApiStore((s) => s.environments);
  const activeEnvId = useApiStore((s) => s.activeEnvId);

  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const caretToRestore = useRef<number | null>(null);

  const syncScroll = () => {
    if (backdropRef.current && inputRef.current) backdropRef.current.scrollLeft = inputRef.current.scrollLeft;
  };
  const [matches, setMatches] = useState<string[]>([]);
  const [tokenStart, setTokenStart] = useState<number | null>(null);
  const [sel, setSel] = useState(0);

  const activeEnv = environments.find((e) => e.id === activeEnvId);
  const varNames = [...new Set([...globals, ...(activeEnv?.vars ?? [])].map((v) => v.key).filter(Boolean))];

  const open = tokenStart !== null && matches.length > 0;
  const clampedSel = Math.min(sel, Math.max(0, matches.length - 1));

  // Restore caret after a programmatic insert (controlled input).
  useEffect(() => {
    if (caretToRestore.current !== null && inputRef.current) {
      inputRef.current.setSelectionRange(caretToRestore.current, caretToRestore.current);
      caretToRestore.current = null;
    }
  });

  const recompute = (text: string, caret: number) => {
    const token = openToken(text, caret);
    if (!token) {
      setTokenStart(null);
      setMatches([]);
      return;
    }
    const m = varNames.filter((n) => n.toLowerCase().includes(token.partial.toLowerCase())).slice(0, 8);
    setTokenStart(m.length ? token.start : null);
    setMatches(m);
    setSel(0);
  };

  const insert = (name: string) => {
    if (tokenStart === null) return;
    const caretPos = inputRef.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, tokenStart)}{{${name}}}${value.slice(caretPos)}`;
    caretToRestore.current = tokenStart + name.length + 4;
    onValueChange(next);
    setTokenStart(null);
    setMatches([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === 'Escape' && onEscape) onEscape();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(matches[clampedSel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTokenStart(null);
      setMatches([]);
    }
  };

  return (
    <div className="var-input-wrap">
      <div
        ref={backdropRef}
        className={`var-input-backdrop ${className ?? ''}`}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlight(value) || '&#8203;' }}
      />
      <input
        ref={inputRef}
        className={`var-input-field ${className ?? ''}`}
        value={value}
        placeholder={placeholder}
        spellCheck={spellCheck}
        aria-label={rest['aria-label']}
        onChange={(e) => {
          onValueChange(e.target.value);
          recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
          syncScroll();
        }}
        onScroll={syncScroll}
        onKeyUp={(e) => {
          syncScroll();
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')
            recompute(value, e.currentTarget.selectionStart ?? value.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={() =>
          setTimeout(() => {
            setTokenStart(null);
            setMatches([]);
          }, 120)
        }
      />
      {open && (
        <div className="var-suggest" role="listbox">
          {matches.map((name, i) => (
            <button
              key={name}
              role="option"
              aria-selected={i === clampedSel}
              className={`var-suggest-row ${i === clampedSel ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(name);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="var-suggest-name">{`{{${name}}}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
