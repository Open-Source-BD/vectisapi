export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream). Feed it decoded
 * text chunks; it returns whole events as they complete, buffering partial
 * frames across chunk boundaries. Handles CRLF/CR, leading BOM, comments (`:`),
 * multi-line `data`, `event`, `id` (NUL ignored), and `retry`. Tracks the last
 * id for `Last-Event-ID` reconnects.
 */
export function createSseParser() {
  let buffer = '';
  let dataLines: string[] = [];
  let eventType = '';
  let retry: number | undefined;
  let lastId: string | undefined;
  let bomChecked = false;

  function push(chunk: string): SseEvent[] {
    if (!bomChecked) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      bomChecked = true;
    }
    buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      if (line === '') {
        // Blank line dispatches the event — but only if data was collected.
        if (dataLines.length > 0) {
          out.push({ event: eventType || 'message', data: dataLines.join('\n'), id: lastId, retry });
        }
        dataLines = [];
        eventType = '';
        retry = undefined;
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventType = value;
      else if (field === 'id') {
        if (!value.includes('\0')) lastId = value;
      } else if (field === 'retry') {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) retry = n;
      }
    }
    return out;
  }

  return { push, lastId: () => lastId };
}
