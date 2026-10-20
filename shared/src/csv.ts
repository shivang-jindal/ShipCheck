/**
 * CSV helpers shared by the export endpoints and the import preview.
 *
 * Formula-injection protection (Part A / A4, Part B / B8): any cell that
 * starts with `=`, `+`, `-`, `@`, tab, CR or LF is prefixed with a single
 * quote so spreadsheets treat it as text.
 */

const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

  if (text.length > 0 && FORMULA_TRIGGERS.includes(text.charAt(0))) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows: readonly (readonly unknown[])[], header: readonly string[]): string {
  const lines: string[] = [];
  if (header.length > 0) lines.push(header.map(escapeCsvCell).join(','));
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  // UTF-8 BOM keeps Excel happy with currency symbols.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Minimal RFC-4180 parser: handles quoted fields, escaped quotes, CRLF and
 * embedded newlines. Returns the header row plus data rows.
 */
export function parseCsv(input: string): { header: string[]; rows: string[][] } {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const [header = [], ...data] = rows;
  return { header: header.map((cell) => cell.trim()), rows: data };
}