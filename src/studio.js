// pixelbystef studio manager: clients, projects, contracts (e-sign), invoices, client portal.
//
//   /studio            admin app (password = the gallery admin key), page: studio-admin.html
//   /studio/api/*      admin JSON API
//   /sign/<token>      client reads + signs a contract (and downloads the signed PDF)
//   /i/<token>         an invoice, with payment instructions
//   /c/<token>         the client's portal: contracts, invoices, gallery link
//
// Data lives in the private R2 bucket (GALLERIES) under studio/<type>/<id>.json, with studio/tok/<token>
// pointing at "<type>:<id>" so public links can be resolved without listing. Signed PDFs: studio/pdf/<id>.pdf.

import ADMIN from "./studio-admin.html";
import { buildPdf } from "./studio-pdf.js";

const enc = new TextEncoder();
const OWNER_EMAIL = "pixelbystef@gmail.com";
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin" };
const TYPES = ["client", "project", "template", "contract", "invoice"];

// ---------- small helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const rid = (n = 12) => hex(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
const str = (v, max = 200) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
const line = (v, max = 200) => str(v, max).replace(/\n+/g, " ");
const money = (n) => { n = Number(n) || 0; return n < 0 ? 0 : Math.round(n * 100) / 100; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) => (isDate(iso) ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const niceStamp = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const fmt = (n, cur) => (cur || "€") + (Number(n) || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function respond(body, status = 200, type = "text/html; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-store", ...NOINDEX, ...extra } });
}
const json = (obj, status = 200) => respond(JSON.stringify(obj), status, "application/json; charset=utf-8");
const ipOf = (req) => req.headers.get("CF-Connecting-IP") || "unknown";
const uaOf = (req) => line(req.headers.get("User-Agent"), 200);

// ---------- storage ----------
const key = (type, id) => `studio/${type}/${id}.json`;
async function load(env, type, id) {
  if (!/^[a-f0-9]{6,32}$/.test(id || "")) return null;
  const o = await env.GALLERIES.get(key(type, id));
  return o ? o.json() : null;
}
async function save(env, type, obj) {
  await env.GALLERIES.put(key(type, obj.id), JSON.stringify(obj), { httpMetadata: { contentType: "application/json" } });
  return obj;
}
async function listAll(env, type) {
  const keys = [];
  let cursor;
  do {
    const r = await env.GALLERIES.list({ prefix: `studio/${type}/`, cursor, limit: 1000 });
    keys.push(...r.objects.map((o) => o.key));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  const out = [];
  for (let i = 0; i < keys.length; i += 20) {
    const objs = await Promise.all(keys.slice(i, i + 20).map((k) => env.GALLERIES.get(k)));
    for (const o of objs) if (o) out.push(await o.json());
  }
  return out;
}
async function byToken(env, type, token) {
  if (!/^[a-f0-9]{32}$/.test(token || "")) return null;
  const o = await env.GALLERIES.get(`studio/tok/${token}`);
  if (!o) return null;
  const [t, id] = (await o.text()).split(":");
  return t === type ? load(env, t, id) : null;
}
async function newToken(env, type, id) {
  const token = rid(32);
  await env.GALLERIES.put(`studio/tok/${token}`, `${type}:${id}`);
  return token;
}
async function getSettings(env) {
  const o = await env.GALLERIES.get("studio/settings.json");
  const s = o ? await o.json() : {};
  return {
    businessName: "pixelbystef", ownerName: "Stefan", email: OWNER_EMAIL, fromEmail: "studio@pixelbystef.com",
    currency: "€", address: "", signerName: "", nextInvoice: 1, methods: [], emailFooter: "", ...s,
  };
}
const putSettings = (env, s) => env.GALLERIES.put("studio/settings.json", JSON.stringify(s), { httpMetadata: { contentType: "application/json" } });

// ---------- admin session ----------
let SECRET;
async function secret(env) {
  if (SECRET) return SECRET;
  let o = await env.GALLERIES.get("_config/secret");
  if (!o) {
    await env.GALLERIES.put("_config/secret", hex(crypto.getRandomValues(new Uint8Array(32))), { onlyIf: { etagDoesNotMatch: "*" } }).catch(() => {});
    o = await env.GALLERIES.get("_config/secret");
  }
  SECRET = (await o.text()).trim();
  return SECRET;
}
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(await secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const cookieOf = (req, name) => ((req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")) || [])[1] || null;
async function isAdmin(req, env) {
  const t = cookieOf(req, "pbs_studio");
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || +exp < Date.now() / 1000) return false;
  return safeEq(sig, await hmac(env, `studio|${exp}`));
}

// ---------- email ----------
const b64 = (s) => { const b = enc.encode(s); let bin = ""; for (const c of b) bin += String.fromCharCode(c); return btoa(bin); };
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function mailHtml(settings, heading, paras, button) {
  return `<div style="font-family:Georgia,serif;max-width:560px;color:#1d1a19">
<h2 style="font-weight:normal;font-size:24px">${esc(heading)}</h2>
${paras.map((p) => `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(p)}</p>`).join("\n")}
${button ? `<p style="margin:26px 0"><a href="${esc(button.url)}" style="font-family:Arial,sans-serif;font-size:15px;background:#1d1a19;color:#fbf9f6;text-decoration:none;padding:13px 26px;border-radius:99px;display:inline-block">${esc(button.label)}</a></p>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#6f6863">Button not working? Copy this link: ${esc(button.url)}</p>` : ""}
<p style="font-family:Arial,sans-serif;font-size:13px;color:#6f6863;white-space:pre-wrap">${esc(settings.emailFooter || `${settings.ownerName}\n${settings.businessName}`)}</p></div>`;
}

// Sends through the unrestricted MAILER binding if there is one, else the site's EMAIL binding.
async function sendMail(env, settings, { to, subject, heading, paras, button }) {
  const recipients = [].concat(to).filter(validEmail);
  if (!recipients.length) throw new Error("No valid email address");
  const text = paras.join("\n\n") + (button ? `\n\n${button.label}: ${button.url}` : "") + `\n\n${settings.emailFooter || `${settings.ownerName}\n${settings.businessName}`}`;
  const msg = {
    to: recipients.length === 1 ? recipients[0] : recipients,
    from: { email: settings.fromEmail, name: settings.businessName },
    replyTo: { email: settings.email, name: settings.ownerName },
    subject, text, html: mailHtml(settings, heading, paras, button),
  };
  const binding = env.MAILER || env.EMAIL;
  try {
    await binding.send(msg);
  } catch (err) {
    // Older Email Routing bindings can only send raw MIME to their verified address.
    if (recipients.length === 1 && recipients[0] === OWNER_EMAIL && env.EMAIL) {
      const boundary = "pbs-" + crypto.randomUUID();
      const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");
      const raw = [
        `From: ${encWord(settings.businessName)} <${settings.fromEmail}>`, `To: <${OWNER_EMAIL}>`,
        `Subject: ${encWord(subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@pixelbystef.com>`,
        "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
        `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text)),
        `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(msg.html)),
        `--${boundary}--`, "",
      ].join("\r\n");
      const { EmailMessage } = await import("cloudflare:email");
      await env.EMAIL.send(new EmailMessage(settings.fromEmail, OWNER_EMAIL, raw));
      return;
    }
    throw err;
  }
}
const clientEmails = (c) => [c.email, c.email2].filter(validEmail);

// ---------- templates: merge fields + light markup ("# Heading", blank line = new paragraph) ----------
function fields(settings, client, project) {
  const cur = settings.currency;
  const price = project ? money(project.price) : 0;
  const deposit = project ? money(project.deposit) : 0;
  return {
    client_name: client?.name || "", client_email: client?.email || "", client_phone: client?.phone || "",
    project_title: project?.title || "", project_type: project?.type || "", event_date: niceDate(project?.date), location: project?.location || "",
    package: project?.package || "", price: price ? fmt(price, cur) : "", deposit: deposit ? fmt(deposit, cur) : "",
    balance: price ? fmt(price - deposit, cur) : "", today: niceDate(today()),
    business_name: settings.businessName, owner_name: settings.ownerName, business_email: settings.email,
  };
}
const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
function blocks(body) {
  return String(body).split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean).map((chunk) =>
    chunk.startsWith("# ") && !chunk.includes("\n") ? { t: "h", text: chunk.slice(2) } : { t: "p", text: chunk });
}
const bodyHtml = (body) => blocks(body).map((b) => (b.t === "h" ? `<h3>${esc(b.text)}</h3>` : `<p>${esc(b.text).replace(/\n/g, "<br>")}</p>`)).join("\n");

const DEFAULT_TEMPLATES = [
  { name: "Wedding photography & film", body: `# Agreement

This agreement is made on {{today}} between {{business_name}} ("the Photographer") and {{client_name}} ("the Client") for {{project_title}}.

# The booking

Date: {{event_date}}
Location: {{location}}
Package: {{package}}

# Fee and payment

The total fee is {{price}}. A non-refundable retainer of {{deposit}} secures the date and is due on signing. The remaining balance of {{balance}} is due before the wedding day, as set out on the invoice. The date is not reserved until the retainer has been received.

# What you receive

An edited online gallery of photographs and/or a film, as described in the package above, delivered within the timeframe agreed in writing. The Photographer decides the final selection and editing style.

# Cancellation and rescheduling

If the Client cancels, the retainer is not refunded. If the Client reschedules, the Photographer will move the booking to a new date if available; if not, the retainer is retained. If the Photographer cannot attend for a reason beyond their control, they will do their best to arrange a suitable replacement, or refund all payments made.

# Copyright and usage

The Photographer keeps the copyright to all images and films. The Client receives a personal licence to print, share and post them. The Photographer may use the images in their portfolio, website and social media, unless the Client asks in writing for particular images to stay private.

# Liability

The Photographer will take every reasonable care to keep all files safe. Liability is limited to the fee paid. The Photographer is not responsible for events outside their control, such as weather, venue restrictions or guest behaviour.

# Agreement

By signing below, both parties agree to these terms.` },
  { name: "Pre-wedding / couple session", body: `# Photo session agreement

This agreement is made on {{today}} between {{business_name}} ("the Photographer") and {{client_name}} ("the Client").

# The session

Session: {{project_title}}
Date: {{event_date}}
Location: {{location}}
Package: {{package}}

# Fee and payment

The total fee is {{price}}. A deposit of {{deposit}} secures the date and is due on signing; the balance of {{balance}} is due on or before the session day.

# Delivery

The Client receives an online gallery of edited photographs after the session. Weather-dependent sessions can be moved once at no cost if agreed at least 48 hours in advance.

# Copyright and usage

The Photographer keeps the copyright. The Client may print, share and post the images for personal use. The Photographer may use the images in their portfolio and on social media.

# Cancellation

The deposit is non-refundable. If the Client cancels less than 48 hours before the session, the full fee is due.

By signing below, both parties agree to these terms.` },
  { name: "Proposal / engagement", body: `# Proposal photography agreement

This agreement is made on {{today}} between {{business_name}} ("the Photographer") and {{client_name}} ("the Client").

# The booking

Occasion: {{project_title}}
Date: {{event_date}}
Location: {{location}}
Package: {{package}}

# Fee and payment

The total fee is {{price}}. A deposit of {{deposit}} secures the booking and is due on signing; the balance of {{balance}} is due before the proposal day.

# Discretion

The Photographer will be discreet and follow the Client's plan so the surprise is protected. The Client will share the timing, location and how the Photographer should be introduced.

# Delivery and usage

Edited photographs are delivered in an online gallery. The Photographer keeps the copyright; the Client may print and share the images personally. The Photographer may use the images in their portfolio unless the Client asks otherwise in writing.

# Cancellation

The deposit is non-refundable. If the plan changes, the Photographer will rebook where possible.

By signing below, both parties agree to these terms.` },
  { name: "Elopement", body: `# Elopement photography agreement

This agreement is made on {{today}} between {{business_name}} ("the Photographer") and {{client_name}} ("the Client").

# The booking

Date: {{event_date}}
Location: {{location}}
Package: {{package}}

# Fee and payment

The total fee is {{price}}. A non-refundable retainer of {{deposit}} secures the date; the balance of {{balance}} is due before the day. Travel and accommodation costs, if any, are agreed in writing.

# Delivery, copyright and usage

Edited photographs and/or film are delivered in an online gallery. The Photographer keeps the copyright; the Client may print and share them personally. The Photographer may use the images in their portfolio unless the Client asks otherwise in writing.

# Cancellation and weather

Weather changes are planned together, with a backup date or location where possible. If the Client cancels, the retainer is not refunded.

By signing below, both parties agree to these terms.` },
];

// ---------- sanitisers ----------
function cleanClient(b) {
  return { name: line(b.name, 120), email: line(b.email, 160), email2: line(b.email2, 160), phone: line(b.phone, 40), notes: str(b.notes, 3000) };
}
const STATUSES = ["enquiry", "proposal", "booked", "shot", "delivered", "completed", "lost"];
function cleanProject(b) {
  return {
    clientId: line(b.clientId, 40), title: line(b.title, 160), type: line(b.type, 60), date: isDate(b.date) ? b.date : "",
    location: line(b.location, 160), package: line(b.package, 160), price: money(b.price), deposit: money(b.deposit),
    status: STATUSES.includes(b.status) ? b.status : "enquiry", galleryUrl: line(b.galleryUrl, 300), notes: str(b.notes, 3000),
  };
}
function cleanTemplate(b) { return { name: line(b.name, 120), body: str(b.body, 30000) }; }
function cleanInvoice(b) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((i) => ({ desc: line(i.desc, 200), qty: Math.max(0, Number(i.qty) || 1), amount: money(i.amount) })).filter((i) => i.desc || i.amount);
  const parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, 12).map((p) => ({
    label: line(p.label, 80), amount: money(p.amount), due: isDate(p.due) ? p.due : "", paid: !!p.paid, paidAt: isDate(p.paidAt) ? p.paidAt : "",
  }));
  return {
    clientId: line(b.clientId, 40), projectId: line(b.projectId, 40), issued: isDate(b.issued) ? b.issued : today(), items, parts,
    methods: (Array.isArray(b.methods) ? b.methods : []).map((m) => line(m, 40)).slice(0, 20), notes: str(b.notes, 2000), published: !!b.published,
  };
}
const invTotal = (inv) => money(inv.items.reduce((s, i) => s + i.qty * i.amount, 0));
function invStatus(inv) {
  const total = invTotal(inv);
  const paid = money(inv.parts.filter((p) => p.paid).reduce((s, p) => s + p.amount, 0));
  const overdue = inv.parts.some((p) => !p.paid && p.due && p.due < today());
  return { total, paid, outstanding: money(total - paid), status: !inv.published ? "draft" : total > 0 && paid >= total ? "paid" : overdue ? "overdue" : paid > 0 ? "part-paid" : "unpaid" };
}

// ---------- public pages ----------
const CSS = `:root{color-scheme:light;--paper:#fbf9f6;--paper-2:#f1ece6;--ink:#1d1a19;--muted:#6f6863;--line:rgba(29,26,25,.12);--rose:#8c5a63;--rose-soft:#e9dcdc;--serif:"Instrument Serif","Cormorant Garamond",Georgia,serif;--sans:"Hanken Grotesk","Helvetica Neue",Arial,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--line);padding:16px 20px;text-align:center}.logo{font-family:var(--serif);font-size:30px;text-decoration:none;line-height:1;color:inherit}.logo em{color:var(--rose)}
main{max-width:720px;margin:0 auto;padding:36px 20px 64px}h1{font-family:var(--serif);font-weight:400;font-size:clamp(38px,8vw,60px);line-height:1.05;margin:0 0 10px}h1 em{color:var(--rose)}
h2{font-family:var(--serif);font-weight:400;font-size:28px;margin:36px 0 10px}h3{font-size:15px;margin:22px 0 4px}p{margin:0 0 12px}
.mono{font:11.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.muted{color:var(--muted)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 12px}.doc{background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px 28px}
.btn{display:inline-block;padding:12px 24px;border-radius:999px;border:0;cursor:pointer;background:var(--ink);color:var(--paper);font:500 15px var(--sans);text-decoration:none}.btn:hover{background:var(--rose)}.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
input[type=text]{width:100%;font:inherit;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font:11.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:400}.r{text-align:right}
.pill{display:inline-block;font:11px var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;border-radius:99px;background:var(--paper-2);color:var(--muted)}.pill.ok{background:#dfeadf;color:#3c6b3c}.pill.bad{background:#f3dcdc;color:#9b3b3b}.pill.warn{background:var(--rose-soft);color:var(--rose)}
.row{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}footer{text-align:center;color:var(--muted);font-size:13px;padding:24px 20px;border-top:1px solid var(--line)}
@media print{header,footer,.noprint{display:none}body{background:#fff}.doc,.card{border:0}}`;
function shell(title, inner, extraHead = "", settings) {
  return respond(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · pixelbystef</title><link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>${CSS}</style>${extraHead}</head>
<body><header><a class="logo" href="/">pixelby<em>stef</em></a></header><main>${inner}</main><footer>Questions? Email ${esc(settings?.email || OWNER_EMAIL)}</footer></body></html>`);
}
const notFound = () => shell("Not found", `<h1>Link not <em>found</em></h1><p class="muted">This link doesn't match anything. Check the link in your email, or write to ${OWNER_EMAIL}.</p>`);
const statusPill = (s) => `<span class="pill ${{ paid: "ok", signed: "ok", overdue: "bad", void: "bad" }[s] || (s === "draft" ? "" : "warn")}">${esc(s)}</span>`;

function paymentBlock(settings, inv) {
  const chosen = settings.methods.filter((m) => !inv.methods.length || inv.methods.includes(m.id));
  if (!chosen.length) return "";
  return `<h2>How to pay</h2><p class="muted">Please use <strong>${esc(inv.number)}</strong> as the payment reference.</p>` +
    chosen.map((m) => `<div class="card"><strong>${esc(m.name)}</strong><p style="white-space:pre-wrap;margin:6px 0 0">${esc(m.instructions)}</p>${/^https?:\/\//.test(m.link || "") ? `<p style="margin:12px 0 0"><a class="btn" href="${esc(m.link)}" target="_blank" rel="noopener">Pay with ${esc(m.name)}</a></p>` : ""}</div>`).join("");
}
function invoiceHtml(settings, client, project, inv, { forPortal = false } = {}) {
  const st = invStatus(inv);
  const cur = settings.currency;
  return `<p class="mono">Invoice ${esc(inv.number)} · issued ${esc(niceDate(inv.issued))}</p>
<h1>${esc(project?.title || "Invoice")}</h1>
<p class="muted">For ${esc(client?.name || "")} ${statusPill(st.status)}</p>
<div class="doc"><table><tr><th>Description</th><th class="r">Qty</th><th class="r">Amount</th></tr>
${inv.items.map((i) => `<tr><td>${esc(i.desc)}</td><td class="r">${i.qty}</td><td class="r">${esc(fmt(i.qty * i.amount, cur))}</td></tr>`).join("")}
<tr><td colspan="2" class="r"><strong>Total</strong></td><td class="r"><strong>${esc(fmt(st.total, cur))}</strong></td></tr></table>
<h3>Payment schedule</h3><table><tr><th>Payment</th><th>Due</th><th class="r">Amount</th><th class="r">Status</th></tr>
${inv.parts.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc(niceDate(p.due) || "On receipt")}</td><td class="r">${esc(fmt(p.amount, cur))}</td><td class="r">${p.paid ? `<span class="pill ok">Paid${p.paidAt ? " " + esc(niceDate(p.paidAt)) : ""}</span>` : p.due && p.due < today() ? '<span class="pill bad">Overdue</span>' : '<span class="pill">Due</span>'}</td></tr>`).join("")}
</table>${inv.notes ? `<p style="white-space:pre-wrap;margin-top:16px" class="muted">${esc(inv.notes)}</p>` : ""}
${settings.address ? `<p class="muted" style="white-space:pre-wrap;margin-top:16px;font-size:13px">${esc(settings.businessName)}\n${esc(settings.address)}</p>` : ""}</div>
${st.status === "paid" ? "" : paymentBlock(settings, inv)}
${forPortal ? "" : `<p class="noprint" style="margin-top:24px"><a class="btn ghost" href="javascript:print()">Print / save as PDF</a></p>`}`;
}

async function contractPdf(env, settings, client, c) {
  const sig = c.signature;
  const out = [
    { t: "title", text: c.title },
    { t: "small", text: `${settings.businessName} and ${client?.name || ""}  |  Document ${c.id}` },
    { t: "gap", h: 8 },
    ...blocks(c.body),
    { t: "gap", h: 14 },
    { t: "h", text: "Signatures" },
    { t: "sig", label: `Signed by the Client: ${sig.name}`, typed: sig.mode === "type" ? sig.name : "", strokes: sig.mode === "draw" ? sig.strokes : null,
      caption: `${sig.name}  |  ${niceStamp(sig.at)}  |  IP ${sig.ip}` },
  ];
  if (settings.signerName) {
    out.push({ t: "sig", label: `Signed for ${settings.businessName}: ${settings.signerName}`, typed: settings.signerName, caption: `${settings.signerName}  |  ${niceStamp(sig.at)}` });
  }
  out.push({ t: "h", text: "Audit trail" });
  for (const a of c.audit) out.push({ t: "small", text: `${niceStamp(a.t)}  |  ${a.e}  |  IP ${a.ip || "-"}${a.note ? "  |  " + a.note : ""}` });
  out.push({ t: "gap", h: 4 }, { t: "small", text: `Document fingerprint (SHA-256 of title and text): ${c.hash}` },
    { t: "small", text: `Signer agreed to sign electronically. Browser: ${sig.ua}` });
  return buildPdf(out, { footer: `${c.title} | ${c.id} | ${c.hash.slice(0, 16)}` });
}

const SIGN_JS = `
const $=s=>document.querySelector(s);let mode='type',strokes=[],drawing=null;
const cv=$('#pad'),ctx=cv.getContext('2d');
function pos(e){const r=cv.getBoundingClientRect();return[Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))]}
function redraw(){ctx.clearRect(0,0,cv.width,cv.height);ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#1d1a19';
for(const s of strokes){ctx.beginPath();s.forEach(([x,y],i)=>{const px=x*cv.width,py=y*cv.height;i?ctx.lineTo(px,py):ctx.moveTo(px,py)});if(s.length==1)ctx.lineTo(s[0][0]*cv.width+.1,s[0][1]*cv.height);ctx.stroke()}}
cv.addEventListener('pointerdown',e=>{e.preventDefault();cv.setPointerCapture(e.pointerId);drawing=[pos(e)];strokes.push(drawing);redraw()});
cv.addEventListener('pointermove',e=>{if(!drawing)return;drawing.push(pos(e));redraw()});
['pointerup','pointercancel'].forEach(t=>cv.addEventListener(t,()=>{drawing=null}));
$('#clear').onclick=()=>{strokes=[];redraw()};
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;$('#typed').style.display=mode=='type'?'block':'none';$('#drawn').style.display=mode=='draw'?'block':'none';
document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('ghost',x!==b))});
$('#typedname').addEventListener('input',e=>{$('#preview').textContent=e.target.value});
$('#go').onclick=async()=>{const err=$('#err');err.textContent='';
const name=$('#fullname').value.trim();if(name.length<2){err.textContent='Please type your full name.';return}
if(mode=='draw'&&!strokes.length){err.textContent='Please draw your signature in the box.';return}
if(!$('#agree').checked){err.textContent='Please tick the box to confirm.';return}
$('#go').disabled=true;
const body={name,mode,agree:true,strokes:mode=='draw'?strokes.map(s=>s.map(p=>[+p[0].toFixed(3),+p[1].toFixed(3)])):null};
try{const r=await fetch(location.pathname+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();
if(j.ok)location.reload();else{err.textContent=j.error||'Something went wrong.';$('#go').disabled=false}}catch(e){err.textContent='Connection problem, please try again.';$('#go').disabled=false}};
`;

async function contractPage(req, env, c, isPreview) {
  const settings = await getSettings(env);
  const client = await load(env, "client", c.clientId);
  const doc = `<div class="doc">${bodyHtml(c.body)}</div>`;
  if (c.status === "void") return shell(c.title, `<p class="mono">Contract</p><h1>${esc(c.title)}</h1><p class="muted">This contract has been withdrawn. Please get in touch if you have questions.</p>`, "", settings);
  if (c.status === "signed") {
    return shell(c.title, `<p class="mono">Signed contract</p><h1>${esc(c.title)}</h1>
<p class="muted">Signed by ${esc(c.signature.name)} on ${esc(niceStamp(c.signature.at))}. A copy was emailed to you.</p>
<p><a class="btn" href="/sign/${c.token}/pdf">Download signed PDF</a></p>${doc}`, "", settings);
  }
  const canSign = c.status === "sent";
  return shell(c.title, `<p class="mono">Contract for ${esc(client?.name || "")}</p><h1>${esc(c.title)}</h1>
<p class="muted">Please read the contract below, then sign at the bottom.</p>${doc}
${canSign ? `<h2>Sign</h2><div class="card">
<p style="margin-bottom:6px"><label for="fullname"><strong>Your full name</strong></label></p><input type="text" id="fullname" autocomplete="name" value="">
<p style="margin:16px 0 8px"><strong>Signature</strong></p>
<p><button type="button" class="btn" data-mode="type">Type</button> <button type="button" class="btn ghost" data-mode="draw">Draw</button></p>
<div id="typed"><input type="text" id="typedname" placeholder="Type your name to sign"><div id="preview" style="font:italic 40px/1.3 Georgia,serif;min-height:56px;border-bottom:1px solid var(--line);padding:6px 4px;overflow-wrap:anywhere"></div></div>
<div id="drawn" style="display:none"><canvas id="pad" width="552" height="150" style="width:100%;max-width:552px;height:auto;aspect-ratio:552/150;touch-action:none;border:1px dashed var(--line);border-radius:12px;background:#fff"></canvas><p><button type="button" class="btn ghost" id="clear" style="padding:6px 14px;font-size:13px">Clear</button></p></div>
<p style="margin-top:16px"><label><input type="checkbox" id="agree" style="width:auto"> I have read this contract and agree to sign it electronically. I understand this counts as my legal signature.</label></p>
<p id="err" style="color:var(--rose)"></p><button type="button" class="btn" id="go">Sign contract</button></div>
<script>${SIGN_JS}</script>` : `<p class="muted">This contract isn't open for signing yet.</p>`}`, "", settings);
}

async function handleSign(req, env, token, sub) {
  const c = await byToken(env, "contract", token);
  if (!c) return notFound();
  const settings = await getSettings(env);
  const client = await load(env, "client", c.clientId);

  if (sub === "pdf") {
    if (c.status !== "signed") return notFound();
    const o = await env.GALLERIES.get(`studio/pdf/${c.id}.pdf`);
    if (!o) return notFound();
    return new Response(o.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${(c.title || "contract").replace(/[^\w.-]+/g, "-")}-signed.pdf"`, "Cache-Control": "private, no-cache", ...NOINDEX } });
  }
  if (sub === "submit" && req.method === "POST") {
    if (c.status !== "sent") return json({ ok: false, error: c.status === "signed" ? "This contract is already signed." : "This contract isn't open for signing." }, 409);
    let b;
    try { b = await req.json(); } catch { return json({ ok: false, error: "Bad request" }, 400); }
    const name = line(b.name, 120);
    if (name.length < 2 || !b.agree) return json({ ok: false, error: "Please type your full name and tick the box." }, 400);
    const mode = b.mode === "draw" ? "draw" : "type";
    let strokes = null;
    if (mode === "draw") {
      let pts = 0;
      strokes = (Array.isArray(b.strokes) ? b.strokes : []).slice(0, 80).map((s) => (Array.isArray(s) ? s : []).slice(0, 2000).map((p) => [Math.min(1, Math.max(0, +p[0] || 0)), Math.min(1, Math.max(0, +p[1] || 0))])).filter((s) => { pts += s.length; return s.length && pts <= 12000; });
      if (!strokes.length) return json({ ok: false, error: "Please draw your signature." }, 400);
    }
    const at = new Date().toISOString();
    const ip = ipOf(req), ua = uaOf(req);
    c.signature = { name, mode, strokes, at, ip, ua };
    c.hash = await sha256(`${c.title}\n${c.body}`);
    c.status = "signed";
    c.signedAt = at;
    c.audit.push({ t: at, e: "signed", ip, ua, note: `${mode === "draw" ? "drawn" : "typed"} signature by ${name}` });
    const pdf = await contractPdf(env, settings, client, c);
    await env.GALLERIES.put(`studio/pdf/${c.id}.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await save(env, "contract", c);
    const link = new URL(`/sign/${c.token}`, req.url).toString();
    const portal = client?.token ? new URL(`/c/${client.token}`, req.url).toString() : link;
    const mails = [];
    if (client && clientEmails(client).length) {
      mails.push(sendMail(env, settings, { to: clientEmails(client), subject: `Signed: ${c.title}`, heading: "Thank you, it's signed",
        paras: [`Hi ${client.name.split(/\s+/)[0]},`, `Your signed copy of "${c.title}" is ready. You can download the PDF any time from your page.`], button: { label: "Download signed PDF", url: link + "/pdf" } }));
    }
    mails.push(sendMail(env, settings, { to: settings.email, subject: `Signed: ${c.title} · ${client?.name || ""}`, heading: "Contract signed",
      paras: [`${name} signed "${c.title}" on ${niceStamp(at)} (IP ${ip}).`, "The signed PDF with the audit trail is stored in the studio."], button: { label: "Open client page", url: portal } }));
    const results = await Promise.allSettled(mails);
    results.forEach((r) => r.status === "rejected" && console.error("signed mail failed", r.reason && r.reason.message));
    return json({ ok: true });
  }
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (c.status === "sent") {
    // First view is worth recording; later views only if from a new IP.
    const ip = ipOf(req);
    if (!c.audit.some((a) => a.e === "viewed" && a.ip === ip)) {
      c.audit.push({ t: new Date().toISOString(), e: "viewed", ip, ua: uaOf(req) });
      c.audit = c.audit.slice(-100);
      await save(env, "contract", c);
    }
  }
  return contractPage(req, env, c);
}

async function handleInvoicePage(req, env, token) {
  const inv = await byToken(env, "invoice", token);
  if (!inv || !inv.published) return notFound();
  const settings = await getSettings(env);
  const [client, project] = await Promise.all([load(env, "client", inv.clientId), load(env, "project", inv.projectId)]);
  return shell(`Invoice ${inv.number}`, invoiceHtml(settings, client, project, inv), "", settings);
}

async function handlePortal(req, env, token) {
  const client = await byToken(env, "client", token);
  if (!client) return notFound();
  const settings = await getSettings(env);
  const [projects, contracts, invoices] = await Promise.all([listAll(env, "project"), listAll(env, "contract"), listAll(env, "invoice")]);
  const mine = (x) => x.clientId === client.id;
  const cs = contracts.filter((c) => mine(c) && (c.status === "sent" || c.status === "signed")).sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  const is = invoices.filter((i) => mine(i) && i.published).sort((a, b) => (b.issued || "").localeCompare(a.issued || ""));
  const ps = projects.filter(mine);
  const galleries = ps.filter((p) => /^https?:\/\//.test(p.galleryUrl || ""));
  const html = `<p class="mono">Your page</p><h1>Hello, <em>${esc(client.name.split(/\s+/)[0] || "there")}</em></h1>
<p class="muted">Everything for your booking with ${esc(settings.businessName)} in one place.</p>
${ps.length ? `<h2>Your booking</h2>${ps.map((p) => `<div class="card"><strong>${esc(p.title)}</strong><br><span class="muted">${esc([niceDate(p.date), p.location, p.package].filter(Boolean).join(" · "))}</span></div>`).join("")}` : ""}
<h2>Contracts</h2>${cs.length ? cs.map((c) => `<div class="card row"><div><strong>${esc(c.title)}</strong><br>${statusPill(c.status === "sent" ? "waiting for signature" : "signed")}</div>
<a class="btn" href="/sign/${c.token}${c.status === "signed" ? "/pdf" : ""}">${c.status === "signed" ? "Download PDF" : "Read &amp; sign"}</a></div>`).join("") : '<p class="muted">Nothing here yet.</p>'}
<h2>Invoices</h2>${is.length ? is.map((i) => { const s = invStatus(i); const next = i.parts.find((p) => !p.paid); return `<div class="card row"><div><strong>${esc(i.number)}</strong> · ${esc(fmt(s.total, settings.currency))}<br>${statusPill(s.status)} <span class="muted">${s.outstanding > 0 ? esc(fmt(s.outstanding, settings.currency)) + " to pay" + (next?.due ? ", next due " + esc(niceDate(next.due)) : "") : ""}</span></div><a class="btn" href="/i/${i.token}">View &amp; pay</a></div>`; }).join("") : '<p class="muted">Nothing here yet.</p>'}
<h2>Your photos &amp; films</h2>${galleries.length ? galleries.map((p) => `<div class="card row"><strong>${esc(p.title)}</strong><a class="btn" href="${esc(p.galleryUrl)}">Open gallery</a></div>`).join("") : '<p class="muted">Your gallery link will appear here once it\'s ready.</p>'}`;
  return shell("Your page", html, "", settings);
}

// ---------- admin ----------
function loginPage(error = "") {
  return shell("Studio", `<p class="mono">Studio</p><h1>Sign <em>in</em></h1>
<form method="post" action="/studio/login"><p><input type="password" name="key" placeholder="Admin key" autofocus style="width:100%;font:inherit;padding:12px 16px;border:1px solid var(--line);border-radius:12px"></p>
${error ? `<p style="color:var(--rose)">${esc(error)}</p>` : ""}<button class="btn" type="submit">Enter</button></form>`);
}

async function ensureDefaults(env) {
  const o = await env.GALLERIES.head("studio/seeded");
  if (o) return;
  await env.GALLERIES.put("studio/seeded", "1");
  for (const t of DEFAULT_TEMPLATES) await save(env, "template", { id: rid(), ...t, created: new Date().toISOString() });
}

async function handleApi(req, env, path) {
  const url = new URL(req.url);
  const origin = url.origin;
  const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : {};
  const settings = await getSettings(env);

  if (path === "all") {
    await ensureDefaults(env);
    const [clients, projects, templates, contracts, invoices] = await Promise.all(TYPES.map((t) => listAll(env, t)));
    return json({
      settings, origin, clients, projects, templates,
      contracts: contracts.map(({ signature, ...c }) => ({ ...c, signedBy: signature?.name || "" })),
      invoices: invoices.map((i) => ({ ...i, ...invStatus(i) })),
    });
  }
  if (path === "settings" && req.method === "POST") {
    const s = {
      businessName: line(body.businessName, 80) || "pixelbystef", ownerName: line(body.ownerName, 80), email: validEmail(body.email) ? body.email : OWNER_EMAIL,
      fromEmail: validEmail(body.fromEmail) ? body.fromEmail : "studio@pixelbystef.com", currency: line(body.currency, 4) || "€",
      address: str(body.address, 500), signerName: line(body.signerName, 80), emailFooter: str(body.emailFooter, 600), nextInvoice: Math.max(1, parseInt(body.nextInvoice) || settings.nextInvoice),
      methods: (Array.isArray(body.methods) ? body.methods : []).slice(0, 12).map((m) => ({ id: /^[\w-]{3,40}$/.test(m.id || "") ? m.id : rid(8), name: line(m.name, 60), instructions: str(m.instructions, 800), link: line(m.link, 300) })).filter((m) => m.name),
    };
    await putSettings(env, s);
    return json({ ok: true, settings: s });
  }

  const parts = path.split("/");
  const [type, id, action] = parts;

  // Generic create / update / delete
  if (TYPES.includes(type) && req.method === "POST" && !action) {
    const existing = id ? await load(env, type, id) : null;
    if (id && !existing) return json({ error: "Not found" }, 404);
    const now = new Date().toISOString();
    let obj;
    if (type === "client") {
      const c = cleanClient(body);
      if (!c.name) return json({ error: "Name is required" }, 400);
      obj = { ...(existing || { id: rid(), created: now }), ...c };
      if (!obj.token) obj.token = await newToken(env, "client", obj.id);
    } else if (type === "project") {
      const p = cleanProject(body);
      if (!p.clientId || !p.title) return json({ error: "Client and title are required" }, 400);
      obj = { ...(existing || { id: rid(), created: now }), ...p };
    } else if (type === "template") {
      const t = cleanTemplate(body);
      if (!t.name) return json({ error: "Name is required" }, 400);
      obj = { ...(existing || { id: rid(), created: now }), ...t };
    } else if (type === "contract") {
      if (existing?.status === "signed") return json({ error: "Signed contracts can't be edited." }, 409);
      const title = line(body.title, 160), text = str(body.body, 30000);
      if (!title || !text) return json({ error: "Title and text are required" }, 400);
      obj = existing || { id: rid(), created: now, status: "draft", audit: [{ t: now, e: "created", ip: ipOf(req), ua: uaOf(req) }] };
      if (!existing) { obj.clientId = line(body.clientId, 40); obj.projectId = line(body.projectId, 40); obj.token = await newToken(env, "contract", obj.id); if (!(await load(env, "client", obj.clientId))) return json({ error: "Client not found" }, 400); }
      else if (existing.status === "sent" && (existing.body !== text || existing.title !== title)) obj.audit.push({ t: now, e: "edited", ip: ipOf(req), ua: uaOf(req), note: "text changed after sending" });
      obj.title = title; obj.body = text;
    } else if (type === "invoice") {
      const i = cleanInvoice(body);
      if (!i.clientId) return json({ error: "Client is required" }, 400);
      if (!i.items.length) return json({ error: "Add at least one line item" }, 400);
      const total = invTotal(i);
      if (!i.parts.length) i.parts = [{ label: "Payment in full", amount: total, due: "", paid: false, paidAt: "" }];
      const sum = money(i.parts.reduce((s, p) => s + p.amount, 0));
      if (Math.abs(sum - total) > 0.005) return json({ error: `Payments add up to ${sum} but the total is ${total}` }, 400);
      obj = { ...(existing || { id: rid(), created: now }), ...i };
      if (!obj.token) obj.token = await newToken(env, "invoice", obj.id);
      if (!obj.number) {
        const s = await getSettings(env);
        obj.number = "INV-" + String(s.nextInvoice).padStart(4, "0");
        await putSettings(env, { ...s, nextInvoice: s.nextInvoice + 1 });
      }
    }
    await save(env, type, obj);
    return json({ ok: true, item: type === "invoice" ? { ...obj, ...invStatus(obj) } : obj });
  }
  if (TYPES.includes(type) && req.method === "DELETE" && id) {
    const existing = await load(env, type, id);
    if (!existing) return json({ ok: true });
    if (type === "contract" && existing.status === "signed") return json({ error: "Signed contracts can't be deleted (void is not possible either)." }, 409);
    if (type === "client") {
      const [ps, cs, is] = await Promise.all([listAll(env, "project"), listAll(env, "contract"), listAll(env, "invoice")]);
      if ([...ps, ...cs, ...is].some((x) => x.clientId === id)) return json({ error: "Delete this client's projects, contracts and invoices first." }, 409);
    }
    if (existing.token) await env.GALLERIES.delete(`studio/tok/${existing.token}`);
    await env.GALLERIES.delete(key(type, id));
    return json({ ok: true });
  }

  // Render a template for a client/project
  if (path === "render" && req.method === "POST") {
    const [tpl, client, project] = await Promise.all([load(env, "template", body.templateId), load(env, "client", body.clientId), load(env, "project", body.projectId)]);
    if (!tpl || !client) return json({ error: "Template and client are required" }, 400);
    return json({ ok: true, title: `${tpl.name}${project ? " · " + project.title : ""}`, body: fill(tpl.body, fields(settings, client, project)) });
  }

  // Contract actions
  if (type === "contract" && id && action) {
    const c = await load(env, "contract", id);
    if (!c) return json({ error: "Not found" }, 404);
    const client = await load(env, "client", c.clientId);
    const link = `${origin}/sign/${c.token}`;
    if (action === "send" && req.method === "POST") {
      if (c.status === "signed" || c.status === "void") return json({ error: `Contract is ${c.status}` }, 409);
      c.status = "sent"; c.sentAt = new Date().toISOString();
      let emailed = false, emailError = "";
      if (body.email !== false) {
        try {
          await sendMail(env, settings, { to: clientEmails(client), subject: `Your contract: ${c.title}`, heading: c.title,
            paras: [`Hi ${client.name.split(/\s+/)[0]},`, `Here's your contract. Please read it and sign online. It only takes a minute.`], button: { label: "Read & sign contract", url: link } });
          emailed = true;
        } catch (e) { emailError = String(e.message || e); }
      }
      c.audit.push({ t: c.sentAt, e: "sent", ip: ipOf(req), ua: uaOf(req), note: emailed ? `emailed to ${clientEmails(client).join(", ")}` : "link made available" + (emailError ? ` (email failed: ${emailError})` : "") });
      await save(env, "contract", c);
      return json({ ok: true, emailed, emailError, link, item: c });
    }
    if (action === "void" && req.method === "POST") {
      if (c.status === "signed") return json({ error: "Already signed" }, 409);
      c.status = "void"; c.audit.push({ t: new Date().toISOString(), e: "voided", ip: ipOf(req), ua: uaOf(req) });
      await save(env, "contract", c);
      return json({ ok: true, item: c });
    }
    if (action === "reopen" && req.method === "POST") {
      if (c.status !== "void") return json({ error: "Only voided contracts can be reopened" }, 409);
      c.status = "draft"; c.audit.push({ t: new Date().toISOString(), e: "reopened as draft", ip: ipOf(req), ua: uaOf(req) });
      await save(env, "contract", c);
      return json({ ok: true, item: c });
    }
    if (action === "pdf") {
      const o = await env.GALLERIES.get(`studio/pdf/${c.id}.pdf`);
      if (!o) return json({ error: "Not signed yet" }, 404);
      return new Response(o.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${c.title.replace(/[^\w.-]+/g, "-")}-signed.pdf"`, ...NOINDEX } });
    }
    if (action === "audit") return json({ audit: c.audit, signature: c.signature ? { ...c.signature, strokes: undefined } : null, hash: c.hash });
  }

  // Invoice actions
  if (type === "invoice" && id && action) {
    const inv = await load(env, "invoice", id);
    if (!inv) return json({ error: "Not found" }, 404);
    const client = await load(env, "client", inv.clientId);
    const link = `${origin}/i/${inv.token}`;
    if (action === "send" && req.method === "POST") {
      inv.published = true; inv.sentAt = new Date().toISOString();
      let emailed = false, emailError = "";
      try {
        const s = invStatus(inv);
        const next = inv.parts.find((p) => !p.paid);
        await sendMail(env, settings, { to: clientEmails(client), subject: `Invoice ${inv.number}`, heading: `Invoice ${inv.number}`,
          paras: [`Hi ${client.name.split(/\s+/)[0]},`, `Your invoice for ${fmt(s.total, settings.currency)} is ready.${next ? ` Next payment: ${next.label} of ${fmt(next.amount, settings.currency)}${next.due ? ", due " + niceDate(next.due) : ""}.` : ""}`, "You'll find the ways to pay on the invoice page."], button: { label: "View invoice", url: link } });
        emailed = true;
      } catch (e) { emailError = String(e.message || e); }
      await save(env, "invoice", inv);
      return json({ ok: true, emailed, emailError, link, item: { ...inv, ...invStatus(inv) } });
    }
    if (action === "part" && req.method === "POST") {
      const p = inv.parts[+body.index];
      if (!p) return json({ error: "No such payment" }, 400);
      p.paid = !!body.paid; p.paidAt = p.paid ? (isDate(body.paidAt) ? body.paidAt : today()) : "";
      await save(env, "invoice", inv);
      return json({ ok: true, item: { ...inv, ...invStatus(inv) } });
    }
  }

  // Send the portal link
  if (type === "client" && id && action === "portal" && req.method === "POST") {
    const client = await load(env, "client", id);
    if (!client) return json({ error: "Not found" }, 404);
    const link = `${origin}/c/${client.token}`;
    try {
      await sendMail(env, settings, { to: clientEmails(client), subject: `Your page with ${settings.businessName}`, heading: "Your page",
        paras: [`Hi ${client.name.split(/\s+/)[0]},`, "Your contracts, invoices and (later) your photo gallery are all in one place."], button: { label: "Open your page", url: link } });
      return json({ ok: true, emailed: true, link });
    } catch (e) { return json({ ok: true, emailed: false, emailError: String(e.message || e), link }); }
  }
  return json({ error: "Unknown route" }, 404);
}

export async function handleStudio(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;

  let m;
  if ((m = p.match(/^\/sign\/([a-f0-9]{32})(?:\/(pdf|submit))?\/?$/))) return handleSign(req, env, m[1], m[2] || "");
  if ((m = p.match(/^\/i\/([a-f0-9]{32})\/?$/))) return handleInvoicePage(req, env, m[1]);
  if ((m = p.match(/^\/c\/([a-f0-9]{32})\/?$/))) return handlePortal(req, env, m[1]);

  if (p === "/studio/login" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const given = String(form?.get("key") || "");
    if (!given || !env.GALLERY_ADMIN_HASH || !safeEq(await sha256(given), env.GALLERY_ADMIN_HASH)) return loginPage("That key isn't right.");
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
    return new Response(null, { status: 303, headers: { Location: "/studio", "Set-Cookie": `pbs_studio=${exp}.${await hmac(env, `studio|${exp}`)}; Path=/; Max-Age=1209600; HttpOnly; Secure; SameSite=Strict`, "Cache-Control": "no-store" } });
  }
  if (p === "/studio/logout") {
    return new Response(null, { status: 303, headers: { Location: "/studio", "Set-Cookie": "pbs_studio=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" } });
  }
  if (!(await isAdmin(req, env))) {
    if (p.startsWith("/studio/api/")) return json({ error: "Not signed in" }, 401);
    return loginPage();
  }
  if (p.startsWith("/studio/api/")) {
    try { return await handleApi(req, env, decodeURIComponent(p.slice("/studio/api/".length)).replace(/\/$/, "")); }
    catch (e) { console.error("studio api error", e && e.stack); return json({ error: "Server error: " + String(e.message || e) }, 500); }
  }
  if (p === "/studio" || p === "/studio/") return respond(ADMIN);
  return respond("Not found", 404, "text/plain");
}
