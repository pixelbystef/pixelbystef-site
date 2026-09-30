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
const fmt = (n, cur, short) => (cur || "£") + (Number(n) || 0).toLocaleString("en-GB", short && Number.isInteger(+n) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const slashDate = (iso) => (isDate(iso) ? iso.split("-").reverse().join("/") : "");
const lines = (v) => String(v || "").split("\n").map((l) => l.trim()).filter(Boolean);
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
const DEFAULT_METHODS = [
  { id: "wise-bank", name: "Bank transfer (Wise, GBP)", link: "", instructions: `Account name: Stefanus Wijaya
Account number: 99684888
Sort code: 23-08-01 (use when sending from the UK)

IBAN: GB51 TRWI 2308 0199 6848 88
Swift/BIC: TRWIGB2LXXX (use when sending from outside the UK)

Bank: Wise Payments Limited, 1st Floor, Worship Square, 65 Clifton Street, London, EC2A 4JE, United Kingdom` },
  { id: "wise-link", name: "Wise", link: "https://wise.com/pay/me/stefanusr1", instructions: "Pay with the button below.\nNew to Wise? Sign up with https://wise.com/invite/ilpc/stefanusr1 and get your first transfer fee-free (up to 500 GBP)." },
  { id: "revolut", name: "Revolut", link: "https://revolut.me/pixelbystef", instructions: "Send the money with the button below, or open https://revolut.me/pixelbystef" },
];
async function getSettings(env) {
  const o = await env.GALLERIES.get("studio/settings.json");
  const s = o ? await o.json() : {};
  return {
    businessName: "Pixel by Stef", ownerName: "Stefan", email: OWNER_EMAIL, fromEmail: "studio@pixelbystef.com",
    currency: "£", address: "", signerName: "Stefanus Wijaya", signerStrokes: null, nextInvoice: 1, emailFooter: "", ...s,
    methods: s.methods || DEFAULT_METHODS,
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
    session_date: slashDate(project?.date), session_time: project?.time || "", package: project?.package || "",
    deliverables_list: lines(project?.deliverables).map((l) => "- **" + l + "**").join("\n"),
    extras_list: lines(project?.extras).map((l) => "- " + l).join("\n"),
    price: price ? fmt(price, cur, true) : "", deposit: deposit ? fmt(deposit, cur, true) : "",
    balance: price ? fmt(price - deposit, cur, true) : "", balance_due_date: slashDate(project?.balanceDue || project?.date),
    today: niceDate(today()),
    business_name: settings.businessName, owner_name: settings.ownerName, business_email: settings.email,
  };
}
const fill = (tpl, vars) => String(tpl).replace(/^[ \t]*\{\{\s*(\w+)\s*\}\}[ \t]*\n/gm, (m, k) => (k in vars && vars[k] === "" ? "" : m)).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
// Markup: "# Title", "## 1. Section", "- bullet", **bold**, blank line = new paragraph.
function blocks(body) {
  const out = [];
  for (const chunk of String(body).split(/\n{2,}/)) {
    let para = [], items = [];
    const flushP = () => { if (para.length) out.push({ t: "p", text: para.join("\n") }); para = []; };
    const flushB = () => { if (items.length) out.push({ t: "bullets", items }); items = []; };
    for (const ln of chunk.trim().split("\n")) {
      if (/^# /.test(ln)) { flushP(); flushB(); out.push({ t: "title", text: ln.slice(2) }); }
      else if (/^## /.test(ln)) { flushP(); flushB(); out.push({ t: "h", text: ln.slice(3) }); }
      else if (/^- /.test(ln)) { flushP(); items.push(ln.slice(2)); }
      else if (ln.trim()) { flushB(); para.push(ln); }
    }
    flushP(); flushB();
  }
  return out;
}
const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const bodyHtml = (body) => blocks(body).map((b) =>
  b.t === "title" ? `<h2 style="text-align:center;margin-top:8px">${inline(b.text)}</h2>` :
  b.t === "h" ? `<h3 style="font-size:19px;margin-top:26px">${inline(b.text)}</h3>` :
  b.t === "bullets" ? `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>` :
  `<p>${inline(b.text).replace(/\n/g, "<br>")}</p>`).join("\n");

// One layout for every kind of shoot; only the wording of the Session changes.
const CONTRACT_BODY = (what) => `# Photography Services Agreement

**THIS AGREEMENT** is made as of {{today}} (the "**Effective Date**") between **{{client_name}}** ("**Client**") and **{{business_name}}** ("**Photographer**").

## 1. Engagement of Photographer

1.1 **Services.** Subject to the terms set out herein, Client engages Photographer to provide, and Photographer agrees to provide, the photography services described in this Section 1.1 (the "**Services**") in connection with the ${what} of **{{client_name}}** and Client's partner (the "**Session**").

Date of Session: **{{session_date}}**
Time of Session: **{{session_time}}**
Location of Session: **{{location}}**
Description of Services:
{{deliverables_list}}

As part of the Services, the Photographer will produce or take similar action to create materials from Images and provide related deliverables (as set out above) pursuant to the provision of the Services ("**Work Product**"). "**Images**" means photographic material, whether still or moving, created by Photographer pursuant to this Agreement and includes, but is not limited to, transparencies, negatives, prints or digital files, captured, recorded, stored or delivered in any type of analogue, photographic, optical, electronic, magnetic, digital or any other medium.

1.2 **Exclusivity.** Client acknowledges and agrees that Photographer will be the exclusive provider of the Services in coverage of the Session, unless otherwise agreed to by the parties in writing.

## 2. Fees and Deposit

2.1 **Fees.** Client will pay Photographer the fees set out herein in this Section 2.1 ("**Fees**"), including any applicable federal or state/provincial sales or value-added taxes due on such Fees.
- Total Fee for Services: **{{price}}**
{{extras_list}}
- Deposit due upon signing: **{{deposit}}**
- Remaining amount due on **{{balance_due_date}}**: **{{balance}}** + remaining additional pricing

2.2 **Deposit.** Client acknowledges and agrees that the deposit amount set out above is due upon the signing of this Agreement and is not refundable ("**Deposit**"), so as to fairly compensate Photographer for committing his/her time to provide the Services and turning down other potential projects or clients. Both parties agree that the Deposit will be credited towards the total Fees payable by Client. The deposit is due 24 hours after the deposit invoice is sent to the Client. If the deposit is not paid by the due date, this contract is void.

2.3 **Invoice.** Photographer will issue an invoice to Client upon agreement of the Services ("**Invoice**"). Client agrees to pay all Fees outstanding on or prior to the due dates set out in Section 2.1. Any payment after the due date will incur a late fee of 5% per month on the outstanding balance. Client acknowledges that the final amount payable may be subject to change depending on the amount actual expenses incurred. Client confirms and agrees that the final calculations provided in the Invoice, should they be different from the total listed in Section 2.1, will be the final amount payable. No additional charges will be incurred without prior written agreement from the Client, except for overtime billed at the rate specified in Section 2.1 and optional services listed under Additional Pricing that are requested by the Client.

## 3. Client Responsibilities

3.1 **Required Consents.** Client will ensure that all required consents, as applicable, have been obtained prior to performance of the Services, including any consents required for the performance of Services and the delivery of Work Product by Photographer and, as applicable, from venues or locales where the Services are to be performed or from attendees of the Session.

3.2 **Expenses.** Client will provide the means of travel or be responsible for reasonable travel expenses incurred by Photographer that are necessary for the performance of the Services or travel that is otherwise requested by Client where the location of the performance of the Services is not in the city of {{location}}. Client will be responsible for any other expenses incurred by Photographer that are necessary for the performance of the Services as more particularly set out in Article 2.

3.3 **Meals.** When the number of hours that Photographer will be providing the Services is expected to be in excess of 4 hours in duration, Client will provide a meal for Photographer and Photography Staff (employees, assistants or other parties engaged by Photographer to assist with the Services), or be responsible for reasonable meal expenses incurred for which Photographer shall provide an invoice.

3.4 **Waiver.** Client (on behalf of himself/herself and any other participant whose image or recording may be captured by the Services) hereby waives all rights and claims, and releases Photographer from any claim or cause of action, whether now known or unknown, relating to the sale, display, license, use and exploitation of Images pursuant to this Agreement.

## 4. Photographer Responsibilities

4.1 **Equipment.** Client will not be required to supply any photography equipment to Photographer.

4.2 **Manner of Service.** Photographer will ensure that the Services are performed in a good, expedient, workmanlike and safe manner, and in such a manner as to avoid unreasonable interference with Client's activities.

4.3 **Photography Staff.** Photographer will, and will ensure that all Photography Staff (employees, assistants or other parties engaged by Photographer to assist with the Services):
- comply with the reasonable directions of Client from time to time regarding the safety of attendees at the Session and applicable health, safety and security requirements of any locations where the Services are provided;
- ensure that Work Product meets the specifications set out in Section 1.1 in all material respects.
- Photographer will be responsible in every respect for the actions of all Photography Staff.

4.4 **Delivery Timeline.** The Photographer agrees to deliver the final edited photos to the Client within 14 days from the date of the photoshoot. This timeline applies to all deliverables unless otherwise stated in writing by the Photographer. A preview of the photographs/videos will be delivered within 24 hours.

4.5 **Video Revisions and Editing Policy.** The Services include a maximum of one (1) round of minor edits to the delivered video Work Product. For the purposes of this Agreement, minor edits are limited to the removal or replacement of existing scenes and do not include changes to overall structure, pacing, colour grading, or visual style. Music selection is final once the first draft is delivered. No changes to music will be made after the first draft unless a specific request has been agreed upon in writing prior to editing. The Client must submit any revision requests within seven (7) days of delivery of the first draft. Requests submitted after this period may be declined or subject to additional fees at the Photographer's discretion. Any additional edits, revisions beyond the first round, or requests outside the scope of minor edits may be declined or subject to additional fees.

4.6 **Photo Revisions and Editing Policy.** The Client acknowledges and agrees that the Photographer's editing style, colour grading, composition, and artistic approach are subjective and form part of the Photographer's creative discretion. Accordingly, no revisions, re-edits, or alterations to delivered photographic Work Product are included under this Agreement. The Photographer is not required to provide unedited images unless otherwise agreed in writing. Any additional editing requests may be considered at the Photographer's sole discretion and may be subject to additional fees.

4.7 **File Retention and Archiving.** The Photographer will retain the final delivered Work Product and associated project files for a minimum period of six (6) months from the date of final delivery ("**Retention Period**"). After the Retention Period, the Photographer makes no guarantee regarding the availability, storage, or recoverability of any files and shall not be responsible for maintaining copies beyond this period.

4.8 **Unedited Files.** The Client acknowledges and agrees that unedited footage, RAW files, or unprocessed images are not included in the Services and will not be delivered to the Client. Delivery of unedited or RAW files will only occur if explicitly agreed upon in writing prior to the Session and is subject to additional fees.

## 5. Artistic Release

5.1 **Consistency.** Photographer will use reasonable efforts to ensure that the Services are produced in a style consistent with Photographer's current portfolio, and Photographer will use reasonable efforts to consult with Client and incorporate any reasonable suggestions.

5.2 **Style.** Client acknowledges and agrees that:
- Client has reviewed Photographer's previous work and portfolio and has a reasonable expectation that Photographer will perform the Services in a similar style
- Photographer will use its artistic judgement when providing the Services, and shall have final say regarding the aesthetic judgement and artistic quality of the Services; and
- Disagreement with Photographer's aesthetic judgement or artistic ability are not valid reasons for termination of this Agreement or request of any monies returned.

## 6. Term and Termination

6.1 **Term.** This Agreement will begin on the Effective Date and continue until the latter of (i) the date where all outstanding Fees under this Agreement are paid in full; or (ii) the date where all final Work Product has been delivered ("**Term**").

6.2 **Cancellation.** Client may terminate the Agreement ("**Cancellation**") and/or reschedule the Services ("**Rescheduling**") by providing Photographer with written notice no later than 14 days before the original date of the Session (the "**Minimum Notice**"). Client acknowledges and agrees that Client is not relieved of any payment obligations for Cancellations and Rescheduling unless the Minimum Notice in accordance with this Article 6 is duly provided or unless the parties otherwise agree in writing.

6.3 **Rescheduling.** In the event of Rescheduling, Photographer will use commercially reasonable efforts to accommodate Client's change. If Photographer is not able to accommodate Client's change despite using commercially reasonable efforts, the parties agree that such Rescheduling will be deemed as Cancellation by Client and that Photographer will be under no obligation to perform the Services other than on the original date of the Session.

6.4 **No Refund.** Client acknowledges and agrees that Cancellation by Client will not result in a refund of any fees paid on or prior to the date of Cancellation by Client.

6.5 **Replacement.** In the event that Photographer is unable to perform the Services, Photographer, subject to Client's consent, which is not to be reasonably withheld, shall cause a replacement photographer to perform the Services in accordance with the terms of this Agreement. In the event that such consent is not obtained, Photographer shall terminate this Agreement and shall return the Deposit and all fees paid by Client, and thereafter shall have no further liability to Client.

## 7. Ownership of Work Product by Photographer

7.1 **Ownership of Work.** Photographer will own all right, title and interest in all Work Product. Client (on behalf of itself and any attendees at the Session) hereby grants Photographer and any of its service providers an exclusive, royalty-free, worldwide, irrevocable, transferable and sublicensable license to use any materials created by Client or attendees, during the performance of the Services, that may be protected by copyright or any intellectual property rights ("**Session Materials**") as part of any Work Product or in connection with the marketing, advertising or promotion of Photographer's services, including in connection with Photographer's studio, portfolio, website or social media, in any format or medium. Client acknowledges and affirms that no other person or entity has any rights that may prevent or restrict Photographer from using Session Materials as provided herein.

## 8. Limited License to Client

8.1 **Personal Use.** Photographer hereby grants Client an exclusive, limited, irrevocable, royalty-free, non-transferable and non-sublicensable license to use Work Product for Client's Personal Use, provided that Client does not remove any attribution notices or copyright notices included by Photographer in any Work Product. "**Personal Use**" includes, but is not limited to, use (i) of photos on Client's personal social media pages or profiles; (ii) in Client's personal creations, such as scrapbooks, albums or personal gifts; (iii) in non-commercial physical display; and (iv) in personal communications, such as family newsletter, email, or holiday card. Client will not make any other use of the Work Product without Photographer's prior written consent, including but not limited to use of the Work Product for commercial sale.

## 9. Indemnity and Limitation of Liability

9.1 **Indemnification.** Client agrees to indemnify, defend and hold harmless Photographer and its affiliates, employees, agents and independent contractors for any injury, property damage, liability, claim or other cause of action arising out of or related to the Services and or Work Product Photographer provides to Client.

9.2 **Force Majeure.** Neither party shall be held in breach of or liable under this Agreement for any delay or non-performance of any provision of this Agreement caused by illness, emergency, fire, strike, pandemic, earthquake, or any other conditions beyond the reasonable control of the non-performing party (each a "**Force Majeure Event**"), and the time of performance of such provision, if any, shall be deemed to be extended for a period equal to the duration of the conditions preventing performance. If such Force Majeure Event persists for more than 60 days, the party not affected by the Force Majeure Event may terminate the Agreement and any prepaid fees for Services not performed (other than the Deposit) shall be returned within 15 days of the date of termination of the Agreement.

9.3 **Failure to Deliver.** Photographer shall not be held liable for delays in the delivery of such Work Product, or any Work Product undeliverable, due to technological malfunctions, service interruptions that are beyond the control of Photographer (including as a result of delays in receipt of instructions from Client) and for Work Product that fails to meet the specifications set out in Section 1.1 due to the actions of Client or attendees at the Session that are beyond the control of Photographer (e.g., camera flashes).

9.4 **Maximum Liability.** Notwithstanding anything to the contrary, Client agrees that Photographer's maximum liability arising out of or related to the Services or the Work Product shall not exceed the total Fees payable under this Agreement.

## 10. General

10.1 **Notice.** Parties shall provide effective notice ("**Notice**") to each other via either of the following methods of delivery at the date and time which the Notice is sent:
- Photographer's Email: {{business_email}}
- Client's Email: {{client_email}}

10.2 **Survival.** Articles 7, 8, 9 and 10 will survive termination of this Agreement.

10.3 **Governing Law.** This Agreement will be governed by the laws of **Scotland.**

10.4 **Amendment.** This Agreement may only be amended, supplemented or otherwise modified by written agreement signed by each of the parties.

10.5 **Entire Agreement.** This Agreement constitutes the entire agreement between the parties with respect to the Services and supersedes all prior agreements and understandings both formal and informal.

10.6 **Severability.** If any provision of this Agreement is determined to be illegal, invalid or unenforceable, in whole or in part, by an arbitrator or any court of competent jurisdiction, that provision or part thereof will be severed from this Agreement and the remaining part of such provision and all other provisions will continue in full force and effect.`;

const DEFAULT_TEMPLATES = [
  { name: "Proposal", body: CONTRACT_BODY("proposal photoshoot") },
  { name: "Wedding", body: CONTRACT_BODY("wedding") },
  { name: "Pre-wedding", body: CONTRACT_BODY("pre-wedding photoshoot") },
  { name: "Elopement", body: CONTRACT_BODY("elopement") },
  { name: "Couple / engagement session", body: CONTRACT_BODY("photoshoot") },
];

// ---------- sanitisers ----------
function cleanStrokes(v) {
  if (!Array.isArray(v)) return null;
  let pts = 0;
  const out = v.slice(0, 80).map((s) => (Array.isArray(s) ? s : []).slice(0, 2000).map((p) => [Math.min(1, Math.max(0, +p[0] || 0)), Math.min(1, Math.max(0, +p[1] || 0))])).filter((s) => { pts += s.length; return s.length && pts <= 12000; });
  return out.length ? out : null;
}
function cleanClient(b) {
  return { name: line(b.name, 120), email: line(b.email, 160), email2: line(b.email2, 160), phone: line(b.phone, 40), notes: str(b.notes, 3000) };
}
const STATUSES = ["enquiry", "proposal", "booked", "shot", "delivered", "completed", "lost"];
function cleanProject(b) {
  return {
    clientId: line(b.clientId, 40), title: line(b.title, 160), type: line(b.type, 60), date: isDate(b.date) ? b.date : "",
    location: line(b.location, 160), time: line(b.time, 40), package: line(b.package, 160), price: money(b.price), deposit: money(b.deposit),
    deliverables: str(b.deliverables, 2500), extras: str(b.extras, 1200), balanceDue: isDate(b.balanceDue) ? b.balanceDue : "",
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
a{color:var(--rose)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
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

const autolink = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
function paymentBlock(settings, inv) {
  const chosen = settings.methods.filter((m) => !inv.methods.length || inv.methods.includes(m.id));
  if (!chosen.length) return "";
  return `<h2>How to pay</h2><p class="muted">Please use <strong>${esc(inv.number)}</strong> as the payment reference.</p>` +
    chosen.map((m) => `<div class="card"><strong>${esc(m.name)}</strong><p style="white-space:pre-wrap;margin:6px 0 0">${autolink(m.instructions)}</p>${/^https?:\/\//.test(m.link || "") ? `<p style="margin:12px 0 0"><a class="btn" href="${esc(m.link)}" target="_blank" rel="noopener">Pay with ${esc(m.name)}</a></p>` : ""}</div>`).join("");
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
  const long = (iso) => niceDate(iso.slice(0, 10));
  const out = [
    { t: "header", brand: settings.businessName.toUpperCase(), sub: "CONTRACT", meta: [["Issue date", long(c.created)], ["Completion date", long(sig.at)]] },
    { t: "doctitle", text: c.title },
    { t: "fromto", from: settings.businessName, to: client?.name || "" },
    ...blocks(c.body),
    { t: "gap", h: 16 },
    { t: "sigs", cols: [
      ...(settings.signerName ? [{ label: `${settings.signerName}, ${settings.businessName}`, sub: `Signed on ${long(sig.at)}`, typed: settings.signerStrokes ? "" : settings.signerName, strokes: settings.signerStrokes }] : []),
      { label: sig.name, sub: `Signed on ${long(sig.at)}`, typed: sig.mode === "type" ? sig.name : "", strokes: sig.mode === "draw" ? sig.strokes : null },
    ] },
    { t: "h", text: "Audit trail" },
  ];
  out.push({ t: "small", text: `Document ${c.id}  |  signed electronically by ${sig.name} on ${niceStamp(sig.at)}  |  IP ${sig.ip}` });
  for (const a of c.audit) out.push({ t: "small", text: `${niceStamp(a.t)}  |  ${a.e}  |  IP ${a.ip || "-"}${a.note ? "  |  " + a.note : ""}` });
  out.push({ t: "gap", h: 3 }, { t: "small", text: `Document fingerprint (SHA-256 of title and text): ${c.hash}` },
    { t: "small", text: `The signer agreed to sign electronically. Browser: ${sig.ua}` });
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
      strokes = cleanStrokes(b.strokes);
      if (!strokes) return json({ ok: false, error: "Please draw your signature." }, 400);
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
  const o = await env.GALLERIES.head("studio/seeded-v2");
  if (o) return;
  await env.GALLERIES.put("studio/seeded-v2", "1");
  for (const old of await listAll(env, "template")) await env.GALLERIES.delete(key("template", old.id));
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
      address: str(body.address, 500), signerName: line(body.signerName, 80), signerStrokes: cleanStrokes(body.signerStrokes), emailFooter: str(body.emailFooter, 600), nextInvoice: Math.max(1, parseInt(body.nextInvoice) || settings.nextInvoice),
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
    return json({ ok: true, title: `${client.name} Contract`, body: fill(tpl.body, fields(settings, client, project)) });
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

  if (path === "export-info") {
    const url2 = `${origin}/studio/export/payments.csv?t=${await exportToken(env)}`;
    return json({ url: url2, formula: `=IMPORTDATA("${url2}")` });
  }
  if (path === "export-info/regenerate" && req.method === "POST") {
    const url2 = `${origin}/studio/export/payments.csv?t=${await exportToken(env, true)}`;
    return json({ url: url2, formula: `=IMPORTDATA("${url2}")` });
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

// ---------- cashflow export for Google Sheets: =IMPORTDATA("<url>") ----------
async function exportToken(env, regenerate) {
  const o = regenerate ? null : await env.GALLERIES.get("studio/export-token");
  if (o) return (await o.text()).trim();
  const t = rid(32);
  await env.GALLERIES.put("studio/export-token", t);
  return t;
}
const csvCell = (v) => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
async function paymentsCsv(env) {
  const [settings, clients, projects, invoices] = await Promise.all([getSettings(env), listAll(env, "client"), listAll(env, "project"), listAll(env, "invoice")]);
  const cl = Object.fromEntries(clients.map((c) => [c.id, c])), pr = Object.fromEntries(projects.map((p) => [p.id, p]));
  const rows = [["Invoice", "Client", "Project", "Project date", "Payment", "Due date", "Due month", "Amount", "Currency", "Status", "Paid date", "Invoice total", "Issued"]];
  for (const inv of invoices.sort((a, b) => (a.number || "").localeCompare(b.number || ""))) {
    const total = invTotal(inv);
    for (const part of inv.parts) {
      const status = part.paid ? "paid" : !inv.published ? "draft" : part.due && part.due < today() ? "overdue" : "unpaid";
      rows.push([inv.number, cl[inv.clientId]?.name, pr[inv.projectId]?.title, pr[inv.projectId]?.date, part.label, part.due, (part.due || "").slice(0, 7), part.amount, settings.currency, status, part.paidAt, total, inv.issued]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export async function handleStudio(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/studio/export/payments.csv") {
    const t = url.searchParams.get("t") || "";
    if (!t || !safeEq(t, await exportToken(env))) return respond("Not found", 404, "text/plain");
    return respond(await paymentsCsv(env), 200, "text/csv; charset=utf-8");
  }

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
