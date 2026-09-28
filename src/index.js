// pixelbystef.com — static site + enquiry form handler.
// Static files in ./public are served directly by Cloudflare; this Worker only
// runs for paths that aren't files (e.g. POST /api/enquiry).

const TO = "pixelbystef@gmail.com";
const FROM = { email: "website@pixelbystef.com", name: "pixelbystef website" };

const clean = (v, max = 200) =>
  String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function reply(request, status, body) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  if (wantsJson) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // No-JS fallback: go to the thank-you page, or back to the form on error.
  return Response.redirect(new URL(body.ok ? "/thanks" : "/contact", request.url), 303);
}

async function handleEnquiry(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let data;
  try {
    data = await request.formData();
  } catch {
    return reply(request, 400, { ok: false, error: "Couldn't read the form." });
  }
  const get = (k) => data.get(k);

  // Honeypot: real people never fill this hidden field. Pretend success.
  if (clean(get("company"))) return reply(request, 200, { ok: true });

  const f = {
    names: clean(get("names"), 120),
    email: clean(get("email"), 160),
    phone: clean(get("phone"), 40),
    type: clean(get("type"), 60),
    medium: clean(get("medium"), 40),
    date: clean(get("date"), 80),
    place: clean(get("place"), 120),
    source: clean(get("source"), 120),
    message: String(get("message") ?? "").trim().slice(0, 5000),
  };

  if (!f.names || !f.message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
    return reply(request, 400, { ok: false, error: "Please add your names, a valid email and a short message." });
  }

  const rows = [
    ["Names", f.names],
    ["Email", f.email],
    ["Phone", f.phone],
    ["Shooting", f.type],
    ["Photo / film", f.medium],
    ["Date", f.date],
    ["Where", f.place],
    ["Found me via", f.source],
  ].filter(([, v]) => v);

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nTheir story:\n${f.message}\n\n— Sent from the contact form on pixelbystef.com. Hit reply to answer them directly.`;

  const htmlBody = `<div style="font-family:Georgia,serif;max-width:600px">
<h2 style="font-weight:normal">New enquiry: ${esc(f.type || "enquiry")}</h2>
<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#6f6863">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("\n")}
</table>
<h3 style="font-weight:normal;margin-top:24px">Their story</h3>
<p style="font-family:Arial,sans-serif;font-size:15px;white-space:pre-wrap">${esc(f.message)}</p>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#6f6863">Sent from the contact form on pixelbystef.com. Hit reply to answer them directly.</p>
</div>`;

  try {
    await env.EMAIL.send({
      to: TO,
      from: FROM,
      replyTo: { email: f.email, name: f.names },
      subject: `New enquiry: ${f.type || "enquiry"} · ${f.names}${f.date ? " · " + f.date : ""}`,
      text,
      html: htmlBody,
    });
  } catch (err) {
    console.error("enquiry email failed", err && err.code, err && err.message);
    return reply(request, 500, { ok: false });
  }
  return reply(request, 200, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/enquiry") return handleEnquiry(request, env);
    return env.ASSETS.fetch(request);
  },
};
