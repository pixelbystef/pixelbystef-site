// Minimal PDF writer for signed contracts (A4, built-in Helvetica / Times fonts, no dependencies).
//
// buildPdf(blocks, { footer }) -> Uint8Array
// Block types:
//   { t: "title", text }      big heading
//   { t: "h", text }          section heading
//   { t: "p", text }          paragraph (wrapped)
//   { t: "small", text }      small grey paragraph
//   { t: "gap", h }           vertical space
//   { t: "sig", label, typed, strokes, caption }   signature box (typed name or drawn strokes [[ [x,y]... ]] in 0..1)

const W = 595, H = 842, MX = 56, MT = 64, MB = 64;
const WIDTHS = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
const SUBS = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " ", "€": "\u0080", "•": "\u0095" };

// Keep text inside WinAnsi (Latin-1 plus the euro sign and bullet); everything else becomes "?".
export function winAnsi(s) {
  return String(s ?? "").replace(/[^\x00-\xff]/g, (c) => SUBS[c] ?? "?").replace(/\t/g, "  ");
}
const cw = (c) => { const i = c.charCodeAt(0) - 32; return i >= 0 && i < WIDTHS.length ? WIDTHS[i] : 556; };
const width = (s, size, bold) => { let w = 0; for (const c of s) w += cw(c); return (w * size / 1000) * (bold ? 1.06 : 1); };
const esc = (s) => s.replace(/[\\()]/g, "\\$&");
const num = (n) => (Math.round(n * 100) / 100).toString();

function wrap(text, size, bold, maxW) {
  const out = [];
  for (const para of winAnsi(text).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(" ")) {
      const t = line ? line + " " + word : word;
      if (line && width(t, size, bold) > maxW) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export function buildPdf(blocks, { footer = "" } = {}) {
  const pages = [[]];
  let y = H - MT;
  const cur = () => pages[pages.length - 1];
  const newPage = () => { pages.push([]); y = H - MT; };
  const need = (h) => { if (y - h < MB) newPage(); };
  const text = (x, yy, s, font, size, gray = 0.1) =>
    cur().push(`BT ${num(gray)} g /${font} ${size} Tf ${num(x)} ${num(yy)} Td (${esc(s)}) Tj ET`);

  const para = (s, size, bold, gray, lead, after) => {
    for (const line of wrap(s, size, bold, W - 2 * MX)) {
      need(lead);
      y -= lead;
      if (line) text(MX, y, line, bold ? "F2" : "F1", size, gray);
    }
    y -= after;
  };

  for (const b of blocks) {
    if (b.t === "title") { para(b.text, 22, true, 0.1, 28, 10); }
    else if (b.t === "h") { need(50); y -= 8; para(b.text, 12.5, true, 0.1, 17, 3); }
    else if (b.t === "p") para(b.text, 10.5, false, 0.15, 15, 6);
    else if (b.t === "small") para(b.text, 8.5, false, 0.4, 12, 3);
    else if (b.t === "gap") y -= b.h || 10;
    else if (b.t === "sig") {
      need(120);
      para(b.label || "Signature", 9, true, 0.4, 13, 4);
      const bx = MX, bw = 240, bh = 70;
      y -= bh;
      if (b.typed) {
        text(bx + 6, y + 22, winAnsi(b.typed), "F3", 28, 0.1);
      } else if (b.strokes) {
        const ops = ["0.1 G 1.6 w 1 J 1 j"];
        for (const st of b.strokes) {
          if (!st.length) continue;
          const pt = ([px, py]) => `${num(bx + 6 + px * (bw - 12))} ${num(y + (1 - py) * (bh - 8) + 4)}`;
          ops.push(`${pt(st[0])} m`);
          if (st.length === 1) ops.push(`${pt([st[0][0] + 0.002, st[0][1]])} l`);
          for (const p of st.slice(1)) ops.push(`${pt(p)} l`);
          ops.push("S");
        }
        cur().push(ops.join("\n"));
      }
      cur().push(`0.6 G 0.6 w ${num(bx)} ${num(y)} m ${num(bx + bw)} ${num(y)} l S`);
      y -= 4;
      if (b.caption) para(b.caption, 8.5, false, 0.4, 12, 6);
    }
  }

  // Footer with page numbers.
  pages.forEach((ops, i) => {
    ops.push(`0.6 G 0.5 w ${MX} 46 m ${W - MX} 46 l S`);
    ops.push(`BT 0.45 g /F1 8 Tf ${MX} 32 Td (${esc(winAnsi(footer).slice(0, 110))}) Tj ET`);
    const pn = `Page ${i + 1} of ${pages.length}`;
    ops.push(`BT 0.45 g /F1 8 Tf ${num(W - MX - width(pn, 8))} 32 Td (${pn}) Tj ET`);
  });

  // Assemble objects: 1 catalog, 2 pages, 3-5 fonts, then page/content pairs.
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>";
  pages.forEach((ops, i) => {
    const content = ops.join("\n");
    objs[6 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
    objs[7 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
