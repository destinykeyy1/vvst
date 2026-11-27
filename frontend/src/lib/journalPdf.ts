type Cell = { text: string; width: number; span?: number };

export function downloadJournalPdf(title: string, headers: Cell[][], rows: Cell[][]) {
  const width = 2100;
  const height = 1485;
  const margin = 42;
  const lineHeight = 20;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось подготовить PDF.");
  const scale = (width - 2 * margin) / rows[0].reduce((sum, cell) => sum + cell.width, 0);
  const pages: string[] = [];
  let y = 0;

  function wrap(text: string, available: number) {
    return text.split(/\r?\n/).flatMap(paragraph => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        const joined = line ? line + " " + word : word;
        if (ctx!.measureText(joined).width <= available) {
          line = joined;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        for (const char of word) {
          if (line && ctx!.measureText(line + char).width > available) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      }
      return [...lines, line];
    });
  }

  function drawCell(text: string[], x: number, top: number, w: number, h: number, heading: boolean) {
    ctx!.fillStyle = heading ? "#f2f2f2" : "#ffffff";
    ctx!.fillRect(x, top, w, h);
    ctx!.strokeStyle = "#aaaaaa";
    ctx!.strokeRect(x, top, w, h);
    ctx!.fillStyle = "#111111";
    text.forEach((line, index) => ctx!.fillText(line, x + 5, top + 17 + index * lineHeight));
  }

  function beginPage() {
    ctx!.fillStyle = "#ffffff";
    ctx!.fillRect(0, 0, width, height);
    ctx!.fillStyle = "#111111";
    ctx!.font = "bold 25px Arial";
    ctx!.fillText(title, margin, margin + 22);
    ctx!.font = "15px Arial";
    const [top, lower] = headers;
    const groups = top.map(cell => wrap(cell.text, cell.width * scale - 10));
    const sublabels = lower.map(cell => wrap(cell.text, cell.width * scale - 10));
    const firstHeight = Math.max(2, ...groups.map(lines => lines.length)) * lineHeight + 8;
    const secondHeight = Math.max(2, ...sublabels.map(lines => lines.length)) * lineHeight + 8;
    y = margin + 43;
    let x = margin;
    let index = 0;
    top.forEach((cell, column) => {
      const w = cell.width * scale;
      drawCell(groups[column], x, y, w, firstHeight + (cell.span ? 0 : secondHeight), true);
      let subX = x;
      for (let count = 0; count < (cell.span ?? 0); count++, index++) {
        const subWidth = lower[index].width * scale;
        drawCell(sublabels[index], subX, y + firstHeight, subWidth, secondHeight, true);
        subX += subWidth;
      }
      x += w;
    });
    y += firstHeight + secondHeight;
  }

  function finishPage() {
    ctx!.fillStyle = "#111111";
    ctx!.fillText(String(pages.length + 1), width - margin - 24, height - 16);
    pages.push(atob(canvas.toDataURL("image/jpeg", 0.92).split(",")[1]));
  }

  beginPage();
  for (const row of rows) {
    const lines = row.map(cell => wrap(cell.text, cell.width * scale - 10));
    const lineCount = Math.max(...lines.map(cell => cell.length));
    let offset = 0;
    while (offset < lineCount) {
      const available = Math.floor((height - margin - y - 8) / lineHeight);
      if (available < 1) {
        finishPage();
        beginPage();
        continue;
      }
      const count = Math.min(lineCount - offset, available);
      const rowHeight = count * lineHeight + 8;
      let x = margin;
      row.forEach((cell, index) => {
        const w = cell.width * scale;
        drawCell(lines[index].slice(offset, offset + count), x, y, w, rowHeight, false);
        x += w;
      });
      y += rowHeight;
      offset += count;
    }
  }
  finishPage();

  // PDF offsets count bytes. JPEG and PDF strings below are both converted byte for byte.
  const parts: BlobPart[] = [];
  const offsets = [0];
  let length = 0;
  function append(value: string) {
    parts.push(Uint8Array.from(value, char => char.charCodeAt(0)));
    length += value.length;
  }
  function object(value: string) {
    const id = offsets.length;
    offsets.push(length);
    append(id + " 0 obj\n" + value + "\nendobj\n");
  }
  function stream(attributes: string, bytes: string) {
    object("<< " + attributes + " /Length " + bytes.length + " >>\nstream\n" + bytes + "\nendstream");
  }
  append("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  object("<< /Type /Catalog /Pages 2 0 R >>");
  object("<< /Type /Pages /Count " + pages.length + " /Kids [" +
    pages.map((_, index) => (3 + index * 3) + " 0 R").join(" ") + "] >>");
  pages.forEach((jpeg, index) => {
    const page = 3 + index * 3;
    object("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Resources << /XObject << /Sheet " +
      (page + 1) + " 0 R >> >> /Contents " + (page + 2) + " 0 R >>");
    stream("/Type /XObject /Subtype /Image /Width " + width + " /Height " + height +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg);
    stream("", "q 1191 0 0 842 0 0 cm /Sheet Do Q");
  });
  const xref = length;
  append("xref\n0 " + offsets.length + "\n0000000000 65535 f \n");
  offsets.slice(1).forEach(offset => append(String(offset).padStart(10, "0") + " 00000 n \n"));
  append("trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");

  const url = URL.createObjectURL(new Blob(parts, { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = title + ".pdf";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
