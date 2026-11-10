export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatXml(xml: string): string {
  const withBreaks = xml.replace(/>\s*</g, '>\n<');
  let pad = 0;
  return withBreaks
    .split('\n')
    .map((raw) => {
      const line = raw.trim();
      if (!line) return '';
      if (/^<\/\w/.test(line)) pad = Math.max(pad - 1, 0);
      const out = '  '.repeat(pad) + line;
      if (/^<\w[^>]*[^/]>$/.test(line) && !/^<.*<\/.*>$/.test(line)) pad += 1;
      return out;
    })
    .filter(Boolean)
    .join('\n');
}

/** Beautify raw body content based on its content type. Returns input unchanged on parse failure. */
export function beautify(content: string, rawType: string): string {
  if (rawType === 'application/json') {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  if (rawType === 'application/xml' || rawType === 'text/html') {
    return formatXml(content);
  }
  return content;
}
