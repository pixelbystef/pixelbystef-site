# pixelbystef.com

Static site served by a Cloudflare Worker (`pixelbystef-site`). Pushing to `main` deploys automatically.

- `public/` – the built site (HTML, CSS, images). This is what visitors see.
- `src/index.js` – handles the contact form (`POST /api/enquiry`) and emails it to pixelbystef@gmail.com via Cloudflare Email Routing.
- `site-src/` – page templates. Run `python3 site-src/build.py <assets-folder> public` to rebuild `public/`.

## Studio manager (`/studio`)

Private admin at `pixelbystef.com/studio` (sign in with the gallery admin key): clients, projects, contract templates, e-signed contracts (PDF + audit trail), invoices with deposit/balance and payment instructions, and a private page per client (`/c/<token>`). Code: `src/studio.js`, `src/studio-admin.html`, `src/studio-pdf.js`. Data is stored in the same R2 bucket under `studio/`.

Emailing clients uses the `MAILER` send_email binding, which needs Cloudflare Email Sending enabled for pixelbystef.com. If email fails, the app shows the link so it can be sent by hand.
