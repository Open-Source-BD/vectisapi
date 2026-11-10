import { useMemo, useState } from 'react';
import { VirtualLines } from './VirtualLines';

/** Above this many lines (or characters) the body is virtualized; below it the DOM is the plain one. */
export const VIRTUALIZE_MIN_LINES = 5000;
export const VIRTUALIZE_MIN_CHARS = 1_000_000;

interface CodeViewProps {
  text: string;
  html?: string;
  /**
   * Text → HTML (must escape). Applied to the whole text for small bodies and per mounted row
   * once virtualized, so highlighting cost tracks what is on screen. Ignored when `html` is set.
   */
  highlight?: (text: string) => string;
  wrap?: boolean;
}

export function CodeView({ text, html, highlight, wrap }: CodeViewProps) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => (text ? text.split('\n') : ['']), [text]);
  const virtual = lines.length > VIRTUALIZE_MIN_LINES || text.length > VIRTUALIZE_MIN_CHARS;
  const fullHtml = useMemo(
    () => (html === undefined && highlight && !virtual ? highlight(text) : html),
    [html, highlight, virtual, text],
  );
  const lineCount = lines.length;

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-view">
      <button className="code-copy" onClick={copy} title="Copy">
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
          {copied ? 'check' : 'content_copy'}
        </span>
      </button>
      {virtual ? (
        <VirtualLines lines={lines} renderLine={highlight} />
      ) : (
        <div className="code-scroll">
          <div className="code-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          {fullHtml !== undefined ? (
            <pre className={`code-body${wrap ? ' code-body-wrap' : ''}`} dangerouslySetInnerHTML={{ __html: fullHtml }} />
          ) : (
            <pre className={`code-body${wrap ? ' code-body-wrap' : ''}`}>{text}</pre>
          )}
        </div>
      )}
    </div>
  );
}
