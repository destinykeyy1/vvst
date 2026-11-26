export async function exportRowsToExcel(filename: string, rows: Record<string, string | number>[]) {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Лист1");
  XLSX.writeFile(book, filename);
}

export async function readExcelRows(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const book = XLSX.read(buf);
  const first = book.SheetNames[0];
  if (!first) return [];
  const sheet = book.Sheets[first];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false, blankrows: true });
  const header = rows.findIndex(row => row.some(cell => /^(?:вид занятия|вид перевозок|вид мероприятия|название занятия|название мероприятия|дисциплина)$/i.test(String(cell).trim())));
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, ...(header >= 0 ? { range: header } : {}) });
}

export function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const found = Object.keys(row).find((k) => k.trim().toLowerCase() === key.toLowerCase());
    if (found !== undefined) {
      const v = row[found];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}
