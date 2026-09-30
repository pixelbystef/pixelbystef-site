// Minimal PDF writer for signed contracts (A4, built-in Helvetica / Times fonts, no dependencies).
//
// buildPdf(blocks, { footer }) -> Uint8Array
// Text may contain **bold** runs. Block types:
//   { t: "header", brand, sub, meta: [[label, value], ...] }   top of page 1: brand left, dates right
//   { t: "doctitle", text }      large document name
//   { t: "fromto", from, to }    two columns
//   { t: "title", text }         centred bold agreement title
//   { t: "h", text }             numbered section heading
//   { t: "p", text }             paragraph (wrapped, **bold** supported)
//   { t: "bullets", items }      bullet list
//   { t: "small", text }         small grey text
//   { t: "gap", h }              vertical space
//   { t: "sigs", cols: [{ label, typed, strokes, sub }, ...] }   signatures side by side; strokes = [[ [x,y]... ]] in 0..1

const W = 595, H = 842, MX = 50, MT = 56, MB = 64;
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

// "a **b** c" -> words [{w, b, sp}] where sp = whitespace before the word
function tokens(text) {
  const out = [];
  let pending = false;
  winAnsi(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    const bold = part.length > 4 && part.startsWith("**") && part.endsWith("**");
    for (const w of (bold ? part.slice(2, -2) : part).split(/(\s+)/)) {
      if (!w) continue;
      if (/^\s+$/.test(w)) pending = true;
      else { out.push({ w, b: bold, sp: pending && out.length > 0 }); pending = false; }
    }
  });
  return out;
}
// Lines of runs [{t, b}] fitting maxW.
function wrap(text, size, maxW) {
  const lines = [];
  const spW = width(" ", size);
  for (const para of String(text).split("\n")) {
    if (!para.trim()) { lines.push([]); continue; }
    let cur = [], w = 0;
    for (const tk of tokens(para)) {
      const tw = width(tk.w, size, tk.b);
      const gap = cur.length && tk.sp ? spW : 0;
      if (cur.length && w + gap + tw > maxW) { lines.push(cur); cur = []; w = 0; }
      const lead = cur.length && tk.sp ? " " : "";
      cur.push({ t: lead + tk.w, b: tk.b });
      w += (lead ? spW : 0) + tw;
    }
    lines.push(cur);
  }
  return lines;
}

export function buildPdf(blocks, { footer = "" } = {}) {
  const pages = [[]];
  let y = H - MT;
  const cur = () => pages[pages.length - 1];
  const newPage = () => { pages.push([]); y = H - MT; };
  const need = (h) => { if (y - h < MB) newPage(); };
  const text = (x, yy, s, font, size, gray = 0.1) =>
    cur().push(`BT ${num(gray)} g /${font} ${size} Tf ${num(x)} ${num(yy)} Td (${esc(winAnsi(s))}) Tj ET`);
  const runsAt = (x, yy, runs, size, gray) => {
    if (!runs.length) return;
    const ops = [`BT ${num(gray)} g ${num(x)} ${num(yy)} Td`];
    let font = "";
    for (const r of runs) {
      const f = r.b ? "F2" : "F1";
      if (f !== font) { ops.push(`/${f} ${size} Tf`); font = f; }
      ops.push(`(${esc(r.t)}) Tj`);
    }
    ops.push("ET");
    cur().push(ops.join(" "));
  };
  const para = (s, size, gray, lead, after, x = MX, maxW = W - 2 * MX) => {
    for (const ln of wrap(s, size, maxW)) { need(lead); y -= lead; runsAt(x, y, ln, size, gray); }
    y -= after;
  };
  const strokesAt = (strokes, bx, by, bw, bh) => {
    const ops = ["0.1 G 1.6 w 1 J 1 j"];
    for (const st of strokes) {
      if (!st.length) continue;
      const pt = ([px, py]) => `${num(bx + 4 + px * (bw - 8))} ${num(by + (1 - py) * (bh - 8) + 4)}`;
      ops.push(`${pt(st[0])} m`);
      if (st.length === 1) ops.push(`${pt([st[0][0] + 0.002, st[0][1]])} l`);
      for (const p of st.slice(1)) ops.push(`${pt(p)} l`);
      ops.push("S");
    }
    cur().push(ops.join("\n"));
  };

  for (const b of blocks) {
    if (b.t === "header") {
      const top = y;
      text(MX, y - 12, winAnsi(b.brand), "F1", 17, 0.15);
      text(MX, y - 34, winAnsi(b.sub), "F1", 15, 0.5);
      let ry = top - 8;
      for (const [k, v] of b.meta || []) {
        text(MX + 300, ry, k, "F1", 8.5, 0.5);
        const lines = wrap(v, 8.5, 130);
        lines.forEach((ln, i) => runsAt(W - MX - 130, ry - i * 11, ln, 8.5, 0.2));
        ry -= 12 + (lines.length - 1) * 11 + 6;
      }
      y = Math.min(top - 46, ry) - 26;
    }
    else if (b.t === "doctitle") { need(40); y -= 22; text(MX, y, b.text, "F1", 19, 0.15); y -= 26; }
    else if (b.t === "fromto") {
      need(60);
      text(MX, y - 4, "From", "F1", 8.5, 0.5); text(MX + 125, y - 4, "To", "F1", 8.5, 0.5);
      text(MX, y - 26, b.from, "F1", 9, 0.15); text(MX + 125, y - 26, b.to, "F1", 9, 0.15);
      y -= 56;
    }
    else if (b.t === "title") { need(50); y -= 14; const t = winAnsi(b.text); text((W - width(t, 17, true)) / 2, y - 14, t, "F2", 17, 0.15); y -= 34; }
    else if (b.t === "h") { need(60); y -= 10; para("**" + b.text.replace(/\*/g, "") + "**", 14, 0.15, 19, 4); }
    else if (b.t === "p") para(b.text, 9.2, 0.2, 12.6, 6);
    else if (b.t === "bullets") {
      for (const it of b.items) {
        const lines = wrap(it, 9.2, W - 2 * MX - 28);
        lines.forEach((ln, i) => {
          need(12.6); y -= 12.6;
          if (i === 0) cur().push(`0.2 g ${num(MX + 14)} ${num(y + 1.6)} 3 3 re f`);
          runsAt(MX + 26, y, ln, 9.2, 0.2);
        });
      }
      y -= 6;
    }
    else if (b.t === "small") para(b.text, 8, 0.4, 11, 2);
    else if (b.t === "gap") y -= b.h || 10;
    else if (b.t === "sigs") {
      need(150);
      text(MX, y - 4, "Signatures", "F1", 11, 0.15);
      y -= 12;
      const colW = (W - 2 * MX) / 2;
      const boxH = 62;
      const top = y;
      b.cols.forEach((c, i) => {
        const x = MX + i * colW;
        const by = top - boxH - 8;
        if (c.typed) text(x + 6, by + 20, winAnsi(c.typed), "F3", 26, 0.1);
        else if (c.strokes) strokesAt(c.strokes, x, by, colW - 30, boxH);
        cur().push(`0.75 G 0.6 w ${num(x)} ${num(by)} m ${num(x + colW - 24)} ${num(by)} l S`);
        text(x, by - 13, c.label, "F1", 8.5, 0.15);
        if (c.sub) text(x, by - 25, c.sub, "F1", 8.5, 0.5);
      });
      y = top - boxH - 8 - 36;
    }
  }

  // Footer with page numbers.
  pages.forEach((ops, i) => {
    ops.push(`0.8 G 0.5 w ${MX} 46 m ${W - MX} 46 l S`);
    ops.push(`BT 0.5 g /F1 7.5 Tf ${MX} 32 Td (${esc(winAnsi(footer).slice(0, 110))}) Tj ET`);
    const pn = `Page ${i + 1} of ${pages.length}`;
    ops.push(`BT 0.5 g /F1 7.5 Tf ${num(W - MX - width(pn, 7.5))} 32 Td (${pn}) Tj ET`);
  });

  // Objects: 1 catalog, 2 pages, 3-5 fonts, then page/content pairs.
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
