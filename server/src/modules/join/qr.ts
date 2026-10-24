import { encode } from "uqr";

/** Quiet zone around the symbol, in modules (the QR standard asks for four). */
export const QUIET_ZONE = 4;

/** The modules of a QR code for `text` (error correction M); `true` = dark. No border: the quiet zone is added when drawing. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: 0 }).data;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A self-contained SVG of the QR code: black modules on a white square (quiet zone 4 modules), one path, no external reference,
 * no script, no style attribute (the pages are served with a CSP that forbids inline styles). `title` is the accessible name.
 */
export function qrSvg(text: string, title: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + 2 * QUIET_ZONE;
  let path = "";
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  const label = escapeXml(title);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 4}" height="${size * 4}" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<title>${label}</title><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}

/** The QR code for a terminal: black on white (scanners want dark modules on a light ground), two rows of modules per line. */
export function qrTerminal(text: string): string {
  const matrix = qrMatrix(text);
  const n = matrix.length + 2 * QUIET_ZONE;
  const dark = (x: number, y: number) => matrix[y - QUIET_ZONE]?.[x - QUIET_ZONE] === true;
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "\u001b[30;47m";
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line + "\u001b[0m");
  }
  return lines.join("\n");
}
