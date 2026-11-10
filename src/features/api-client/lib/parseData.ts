/**
 * Parse a pasted data file (JSON array or CSV) into rows for the Collection
 * Runner. Each row is a flat `{ key: string }` map. Throws on malformed input
 * so the UI can show a clear error instead of silently running zero iterations.
 */
export function parseData(text: string): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseJsonData(trimmed);
  }
  return parseCsv(trimmed);
}

function stringifyRow(obj: unknown): Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Each data row must be a JSON object');
  }
  const row: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    row[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return row;
}

function parseJsonData(text: string): Record<string, string>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON data file');
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map(stringifyRow);
}

/** Minimal RFC-4180-ish CSV: first row = headers, quoted fields may contain commas/quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  if (headers.length === 0) throw new Error('CSV has no header row');

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
}

/** Split into logical lines, honoring quotes that may span newlines. */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.trim() !== '') lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') lines.push(cur);
  return lines;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}
