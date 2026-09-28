// pixelbystef client galleries.
//
// Everything for a gallery lives in the private R2 bucket (binding GALLERIES) under g/<slug>/:
//   gallery.json          settings + photo list (written by gallery.py on Stefan's Mac)
//   thumb/<id>.jpg        grid images (~900px)
//   preview/<id>.jpg      full-screen viewer images (~2000px)
//   high/<file>           high-res originals          (download)
//   web/<file>            web & social versions       (download)
//   raw/<file>            RAW files, optional         (download)
//   film/<file>           films, optional             (watch + download)
//   favs.json             the couple's favourites (written by the gallery page)
// _config/secret holds the random key used to sign "unlocked" cookies. It is created automatically.

import PAGE from "./gallery-page.html";
import LOCK from "./gallery-lock.html";

const enc = new TextEncoder();
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin" };
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const VARIANTS = { high: "High-res", web: "Web & social", raw: "RAW" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// *word* in gallery text becomes italic rose, like the headings on the main site.
const rich = (s) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...NOINDEX, ...extra },
  });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...NOINDEX },
  });
}

// ---------- cookie signing ----------
let SECRET;
async function secret(env) {
  if (SECRET) return SECRET;
  let o = await env.GALLERIES.get("_config/secret");
  if (!o) {
    const fresh = hex(crypto.getRandomValues(new Uint8Array(32)));
    // Only write if nobody else did in the meantime.
    await env.GALLERIES.put("_config/secret", fresh, { onlyIf: { etagDoesNotMatch: "*" } }).catch(() => {});
    o = await env.GALLERIES.get("_config/secret");
  }
  SECRET = (await o.text()).trim();
  return SECRET;
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(await secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const cookieName = (slug) => "pbs_g_" + slug.replace(/-/g, "_");
function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function makeToken(env, g) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60; // 60 days
  return exp + "." + (await hmac(env, `${g.slug}|${exp}|${g.password?.hash || ""}`));
}
async function isUnlocked(req, env, g) {
  if (!g.password) return true;
  const t = getCookie(req, cookieName(g.slug));
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || +exp < Date.now() / 1000) return false;
  return safeEq(sig, await hmac(env, `${g.slug}|${exp}|${g.password.hash}`));
}

// ---------- data ----------
async function loadGallery(env, slug) {
  const o = await env.GALLERIES.get(`g/${slug}/gallery.json`);
  if (!o) return null;
  const g = await o.json();
  g.slug = slug;
  return g;
}
const today = () => new Date().toISOString().slice(0, 10);
const isExpired = (g) => g.expires && g.expires < today();
const rawOpen = (g) => !!g.raw_until && g.raw_until >= today() && g.photos.some((p) => p.raw);
function niceDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------- pages ----------
// "Sneak peek · Proposal · 16 September 2026" for previews, "Proposal · 16 September 2026" for full galleries.
function eyebrowText(g) {
  return [g.kind === "preview" ? "Sneak peek" : "", g.type, niceDate(g.date)].filter(Boolean).join(" · ");
}
function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ""));
}
function lockPage(g, { error = "", expired = false, missing = false } = {}) {
  let title, lead, form = "";
  if (missing) {
    title = "Gallery not <em>found</em>";
    lead = "This link doesn't match a gallery. Check the link in your email, or drop me a line at pixelbystef@gmail.com.";
  } else if (expired) {
    title = `${rich(g.title)}`;
    lead = `This gallery closed on ${esc(niceDate(g.expires))}. If you still need your photos, email me at pixelbystef@gmail.com and I'll reopen it.`;
  } else {
    title = rich(g.title);
    lead = "Enter the password from your email to see your photos.";
    form = `<form method="post" class="lockform">
      <label for="pw" class="mono">Password</label>
      <div class="row"><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      <button class="btn" type="submit">Open gallery</button></div>
      ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
    </form>`;
  }
  const eyebrow = g && !missing ? esc(eyebrowText(g)) : "Private gallery";
  return fill(LOCK, { title_text: esc(g && !missing ? g.title : "Gallery"), eyebrow, title, lead, form });
}

function galleryPage(g, favs) {
  const raw = rawOpen(g);
  const data = {
    slug: g.slug,
    title: g.title,
    rawOpen: raw,
    rawUntil: raw ? niceDate(g.raw_until) : "",
    photos: g.photos.map((p) => {
      const o = { id: p.id, w: p.w, h: p.h, hi: [p.high.name, p.high.size, p.high.w, p.high.h] };
      if (p.web) o.web = [p.web.name, p.web.size, p.web.w, p.web.h];
      if (p.raw) o.raw = [p.raw.name, p.raw.size];
      return o;
    }),
    films: (g.films || []).map((f) => ({
      title: f.title, file: f.file.name, size: f.file.size,
      watch: (f.preview || f.file).name, poster: f.poster ? `/g/${g.slug}/p/${encodeURIComponent(f.poster)}.jpg` : "",
    })),
    favs,
  };
  const cover = g.cover || g.photos[0]?.id;
  const intro = (g.intro || []).map((p) => `<p>${rich(p)}</p>`).join("");
  const expiry = g.expires ? `<p>This gallery stays online until ${esc(niceDate(g.expires))}. Download everything you want to keep before then.</p>` : "";
  return fill(PAGE, {
    title_text: esc(g.title),
    slug: esc(g.slug),
    eyebrow: esc(eyebrowText(g)),
    title: rich(g.title.replace("&", "*&*")),
    cover: cover ? `/g/${g.slug}/p/${encodeURIComponent(cover)}.jpg` : "",
    cover_pos: esc(g.cover_position || "50% 50%"),
    note_eyebrow: rich(g.note_eyebrow || ""),
    heading: rich(g.heading || ""),
    intro: intro + expiry,
    count: String(g.photos.length),
    days_left: g.expires ? String(Math.max(0, Math.ceil((Date.parse(g.expires + "T23:59:59Z") - Date.now()) / 864e5))) : "∞",
    data: JSON.stringify(data).replace(/</g, "\\u003c"),
  });
}

// Chapters are stored as [{title, start: "<photo id>"}]; turn them into index ranges.
function chapterRanges(g) {
  const ids = g.photos.map((p) => p.id);
  const ch = (g.chapters || [])
    .map((c) => ({ title: c.title, from: ids.indexOf(c.start) }))
    .filter((c) => c.from >= 0)
    .sort((a, b) => a.from - b.from);
  if (!ch.length || ch[0].from !== 0) ch.unshift({ title: ch.length ? "Getting started" : "All photos", from: 0 });
  return ch.map((c, i) => ({ title: c.title, from: c.from, to: (ch[i + 1]?.from ?? ids.length) - 1 }));
}

// ---------- files ----------
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] === "" ? size - 1 : Math.min(+m[2], size - 1); }
  if (start > end || start >= size) return "bad";
  return { offset: start, length: end - start + 1 };
}
async function serveFile(req, env, key, { download, filename, cache = "private, max-age=86400" } = {}) {
  const head = await env.GALLERIES.head(key);
  if (!head) return new Response("Not found", { status: 404, headers: NOINDEX });
  const range = parseRange(req.headers.get("Range"), head.size);
  if (range === "bad") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, ...NOINDEX } });
  const obj = await env.GALLERIES.get(key, range ? { range } : {});
  const h = new Headers(NOINDEX);
  obj.writeHttpMetadata(h);
  if (!h.get("Content-Type")) h.set("Content-Type", guessType(key));
  h.set("ETag", head.httpEtag);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", cache);
  if (download) h.set("Content-Disposition", `attachment; filename="${asciiName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  if (range) {
    h.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    h.set("Content-Length", String(range.length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(head.size));
  return new Response(obj.body, { status: 200, headers: h });
}
const asciiName = (n) => n.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
function guessType(k) {
  const e = k.split(".").pop().toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", json: "application/json" }[e] || "application/octet-stream";
}

// ---------- zip streaming ----------
// Files are stored uncompressed ("stored") and their CRC-32 is computed by gallery.py at upload,
// so the Worker only pipes bytes through and the total size is known in advance.
function dosDateTime(iso) {
  const d = iso ? new Date(iso + "T12:00:00Z") : new Date();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}
function planZip(files, iso) {
  const { time, date } = dosDateTime(iso);
  const MAX32 = 0xffffffff;
  let offset = 0;
  const entries = files.map((f) => {
    const name = enc.encode(f.name);
    const big = f.size >= MAX32;
    const local = new Uint8Array(30 + name.length + (big ? 20 : 0));
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, big ? 45 : 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, f.crc >>> 0, true);
    v.setUint32(18, big ? MAX32 : f.size, true);
    v.setUint32(22, big ? MAX32 : f.size, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, big ? 20 : 0, true);
    local.set(name, 30);
    if (big) {
      const x = 30 + name.length;
      v.setUint16(x, 0x0001, true); v.setUint16(x + 2, 16, true);
      v.setBigUint64(x + 4, BigInt(f.size), true); v.setBigUint64(x + 12, BigInt(f.size), true);
    }
    const e = { ...f, nameBytes: name, local, offset, big };
    offset += local.length + f.size;
    return e;
  });
  // central directory
  const cdParts = entries.map((e) => {
    const needOff = e.offset >= MAX32;
    const extraLen = e.big || needOff ? 4 + (e.big ? 16 : 0) + (needOff ? 8 : 0) : 0;
    const c = new Uint8Array(46 + e.nameBytes.length + extraLen);
    const v = new DataView(c.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, (3 << 8) | 45, true); // made by: unix, 4.5
    v.setUint16(6, e.big || needOff ? 45 : 20, true);
    v.setUint16(8, 0x0800, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, time, true);
    v.setUint16(14, date, true);
    v.setUint32(16, e.crc >>> 0, true);
    v.setUint32(20, e.big ? MAX32 : e.size, true);
    v.setUint32(24, e.big ? MAX32 : e.size, true);
    v.setUint16(28, e.nameBytes.length, true);
    v.setUint16(30, extraLen, true);
    v.setUint16(32, 0, true); v.setUint16(34, 0, true); v.setUint16(36, 0, true);
    v.setUint32(38, (0o100644 << 16) >>> 0, true);
    v.setUint32(42, needOff ? MAX32 : e.offset, true);
    c.set(e.nameBytes, 46);
    if (extraLen) {
      let x = 46 + e.nameBytes.length;
      v.setUint16(x, 0x0001, true); v.setUint16(x + 2, extraLen - 4, true); x += 4;
      if (e.big) { v.setBigUint64(x, BigInt(e.size), true); v.setBigUint64(x + 8, BigInt(e.size), true); x += 16; }
      if (needOff) v.setBigUint64(x, BigInt(e.offset), true);
    }
    return c;
  });
  const cdSize = cdParts.reduce((a, c) => a + c.length, 0);
  const cdOffset = offset;
  const z64 = cdOffset >= MAX32 || cdSize >= MAX32 || entries.length >= 0xffff;
  const tail = [];
  if (z64) {
    const r = new Uint8Array(56), v = new DataView(r.buffer);
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setUint16(12, 45, true); v.setUint16(14, 45, true);
    v.setUint32(16, 0, true); v.setUint32(20, 0, true);
    v.setBigUint64(24, BigInt(entries.length), true); v.setBigUint64(32, BigInt(entries.length), true);
    v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(cdOffset), true);
    const l = new Uint8Array(20), lv = new DataView(l.buffer);
    lv.setUint32(0, 0x07064b50, true); lv.setUint32(4, 0, true);
    lv.setBigUint64(8, BigInt(cdOffset + cdSize), true); lv.setUint32(16, 1, true);
    tail.push(r, l);
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, z64 ? 0xffff : entries.length, true);
  ev.setUint16(10, z64 ? 0xffff : entries.length, true);
  ev.setUint32(12, z64 ? MAX32 : cdSize, true);
  ev.setUint32(16, z64 ? MAX32 : cdOffset, true);
  tail.push(end);
  const total = cdOffset + cdSize + tail.reduce((a, t) => a + t.length, 0);
  return { entries, cdParts, tail, total };
}
function streamZip(env, plan) {
  const { readable, writable } = new FixedLengthStream(plan.total);
  (async () => {
    let w = writable.getWriter();
    try {
      for (const e of plan.entries) {
        await w.write(e.local);
        const obj = await env.GALLERIES.get(e.key);
        if (!obj || obj.size !== e.size) throw new Error("missing or changed file " + e.key);
        w.releaseLock();
        await obj.body.pipeTo(writable, { preventClose: true });
        w = writable.getWriter();
      }
      for (const c of plan.cdParts) await w.write(c);
      for (const t of plan.tail) await w.write(t);
      await w.close();
    } catch (err) {
      console.error("zip failed", err && err.message);
      try { await w.abort(err); } catch {}
    }
  })();
  return readable;
}
async function handleZip(req, env, g, url) {
  const variant = url.pathname.split("/")[4];
  if (!VARIANTS[variant] || (variant === "raw" && !rawOpen(g))) return new Response("Not available", { status: 404, headers: NOINDEX });
  const set = url.searchParams.get("set") || "all";
  let idx = g.photos.map((_, i) => i);
  let label = "";
  if (set === "favs") {
    const f = new Set(await readFavs(env, g.slug));
    idx = idx.filter((i) => f.has(g.photos[i].id));
    label = "favourites";
  } else if (/^\d+$/.test(set)) {
    const c = chapterRanges(g)[+set];
    if (!c) return new Response("Not found", { status: 404, headers: NOINDEX });
    idx = idx.filter((i) => i >= c.from && i <= c.to);
    label = c.title.replace(/\*/g, "");
  }
  const files = idx.map((i) => g.photos[i][variant]).filter(Boolean);
  if (!files.length) return new Response("Nothing to download", { status: 404, headers: NOINDEX });
  const seen = new Set();
  const list = files.map((f) => {
    let name = f.name;
    for (let n = 2; seen.has(name); n++) name = f.name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    seen.add(name);
    return { name, size: f.size, crc: f.crc, key: `g/${g.slug}/${variant}/${f.name}` };
  });
  const plan = planZip(list, g.date);
  const base = [g.title, label, VARIANTS[variant]].filter(Boolean).join(" - ").replace(/&/g, "and").replace(/[\\/:*?"<>|]+/g, "").trim();
  const filename = base + ".zip";
  return new Response(streamZip(env, plan), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(plan.total),
      "Content-Disposition": `attachment; filename="${asciiName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      ...NOINDEX,
    },
  });
}

// ---------- favourites ----------
async function readFavs(env, slug) {
  const o = await env.GALLERIES.get(`g/${slug}/favs.json`);
  if (!o) return [];
  try { const j = await o.json(); return Array.isArray(j.ids) ? j.ids : []; } catch { return []; }
}
async function handleFavs(req, env, g) {
  if (req.method === "GET") return json({ ids: await readFavs(env, g.slug) });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const valid = new Set(g.photos.map((p) => p.id));
  if (!valid.has(body.id)) return json({ error: "Unknown photo" }, 400);
  const ids = new Set(await readFavs(env, g.slug));
  if (body.on) ids.add(body.id); else ids.delete(body.id);
  const ordered = g.photos.map((p) => p.id).filter((id) => ids.has(id));
  await env.GALLERIES.put(`g/${g.slug}/favs.json`, JSON.stringify({ ids: ordered, updated: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ ids: ordered });
}

// ---------- public routes: /g/<slug>/... ----------
export async function handleGallery(req, env) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["g", slug, ...]
  const slug = (parts[1] || "").toLowerCase();
  if (!slug) return Response.redirect(new URL("/", url), 302);
  if (!SLUG_RE.test(slug)) return html(lockPage(null, { missing: true }), 404);
  const g = await loadGallery(env, slug);
  if (!g) return html(lockPage(null, { missing: true }), 404);
  if (isExpired(g)) return html(lockPage(g, { expired: true }), 410);

  const sub = parts[2];
  if (!sub) {
    if (url.pathname !== `/g/${slug}`) return Response.redirect(new URL(`/g/${slug}`, url), 301);
    if (req.method === "POST") {
      let pw = "";
      try { pw = String((await req.formData()).get("password") || ""); } catch {}
      const ok = g.password && safeEq(await sha256(g.password.salt + pw.trim()), g.password.hash);
      if (!ok) return html(lockPage(g, { error: "That password doesn't match. Check your email, or ask me for it." }), 401);
      const token = await makeToken(env, g);
      return new Response(null, {
        status: 303,
        headers: {
          Location: `/g/${slug}`,
          "Set-Cookie": `${cookieName(slug)}=${token}; Path=/g/${slug}; Max-Age=${60 * 60 * 24 * 60}; HttpOnly; Secure; SameSite=Lax`,
          ...NOINDEX,
        },
      });
    }
    if (!(await isUnlocked(req, env, g))) return html(lockPage(g));
    return html(galleryPage(g, await readFavs(env, slug)));
  }

  if (!(await isUnlocked(req, env, g))) return new Response("Locked", { status: 401, headers: NOINDEX });
  const rest = decodeURIComponent(parts.slice(3).join("/"));

  if (sub === "t" || sub === "p") {
    const id = rest.replace(/\.jpg$/, "");
    const folder = sub === "t" ? "thumb" : "preview";
    return serveFile(req, env, `g/${slug}/${folder}/${id}.jpg`, { cache: "private, max-age=604800" });
  }
  if (sub === "d") {
    // /g/<slug>/d/<variant>/<file>
    const [variant, ...nameParts] = parts.slice(3).map(decodeURIComponent);
    const name = nameParts.join("/");
    if (!VARIANTS[variant] || (variant === "raw" && !rawOpen(g))) return new Response("Not available", { status: 404, headers: NOINDEX });
    if (!g.photos.some((p) => p[variant]?.name === name)) return new Response("Not found", { status: 404, headers: NOINDEX });
    return serveFile(req, env, `g/${slug}/${variant}/${name}`, { download: true, filename: name, cache: "private, no-cache" });
  }
  if (sub === "v" || sub === "fd") {
    // v = watch in the page, fd = film download
    const f = (g.films || []).find((f) => f.file.name === rest || f.preview?.name === rest);
    if (!f) return new Response("Not found", { status: 404, headers: NOINDEX });
    return serveFile(req, env, `g/${slug}/film/${rest}`, sub === "fd" ? { download: true, filename: rest, cache: "private, no-cache" } : {});
  }
  if (sub === "zip") return handleZip(req, env, g, url);
  if (sub === "favs") return handleFavs(req, env, g);
  return new Response("Not found", { status: 404, headers: NOINDEX });
}

// ---------- admin API: used by gallery.py ----------
export async function handleAdmin(req, env) {
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth || !env.GALLERY_ADMIN_HASH || !safeEq(await sha256(auth), env.GALLERY_ADMIN_HASH)) {
    return json({ error: "Wrong or missing admin key" }, 401);
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/g-admin\/?/, "");
  const q = url.searchParams;
  const B = env.GALLERIES;
  const okKey = (k) => k && !k.startsWith("_config/") && !k.includes("..");

  if (path === "ping") return json({ ok: true });
  if (path === "list") {
    const r = await B.list({ prefix: q.get("prefix") || "g/", cursor: q.get("cursor") || undefined, limit: 1000, delimiter: q.get("delimiter") || undefined });
    return json({
      objects: r.objects.map((o) => ({ key: o.key, size: o.size })),
      prefixes: r.delimitedPrefixes || [],
      cursor: r.truncated ? r.cursor : null,
    });
  }
  if (path.startsWith("object/")) {
    const key = decodeURIComponent(path.slice(7));
    if (!okKey(key)) return json({ error: "Bad key" }, 400);
    if (req.method === "GET") {
      const o = await B.get(key);
      if (!o) return json({ error: "Not found" }, 404);
      return new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType || "application/octet-stream" } });
    }
    if (req.method === "PUT") {
      const o = await B.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") || guessType(key) } });
      return json({ ok: true, key, size: o.size });
    }
    if (req.method === "DELETE") { await B.delete(key); return json({ ok: true }); }
  }
  if (path === "delete-prefix" && req.method === "POST") {
    const prefix = q.get("prefix") || "";
    if (!/^g\/[a-z0-9-]+\/$/.test(prefix)) return json({ error: "Bad prefix" }, 400);
    let n = 0, cursor;
    do {
      const r = await B.list({ prefix, cursor, limit: 1000 });
      if (r.objects.length) { await B.delete(r.objects.map((o) => o.key)); n += r.objects.length; }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return json({ ok: true, deleted: n });
  }
  // Big files (films, RAW) go up in 50 MB parts.
  if (path === "mpu/create" && req.method === "POST") {
    const key = q.get("key");
    if (!okKey(key)) return json({ error: "Bad key" }, 400);
    const m = await B.createMultipartUpload(key, { httpMetadata: { contentType: q.get("type") || guessType(key) } });
    return json({ uploadId: m.uploadId, key: m.key });
  }
  if (path === "mpu/part" && req.method === "PUT") {
    const m = B.resumeMultipartUpload(q.get("key"), q.get("uploadId"));
    const part = await m.uploadPart(+q.get("part"), req.body);
    return json(part);
  }
  if (path === "mpu/complete" && req.method === "POST") {
    const m = B.resumeMultipartUpload(q.get("key"), q.get("uploadId"));
    const { parts } = await req.json();
    const o = await m.complete(parts);
    return json({ ok: true, size: o.size });
  }
  if (path === "mpu/abort" && req.method === "POST") {
    await B.resumeMultipartUpload(q.get("key"), q.get("uploadId")).abort();
    return json({ ok: true });
  }
  return json({ error: "Unknown admin route" }, 404);
}
