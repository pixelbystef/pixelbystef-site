# pixelbystef.com

Static site served by a Cloudflare Worker (`pixelbystef-site`). Pushing to `main` deploys automatically.

- `public/` – the built site (HTML, CSS, images). This is what visitors see.
- `src/index.js` – handles the contact form (`POST /api/enquiry`) and emails it to pixelbystef@gmail.com via Cloudflare Email Routing.
- `site-src/` – page templates. Run `python3 site-src/build.py <assets-folder> public` to rebuild `public/`.
