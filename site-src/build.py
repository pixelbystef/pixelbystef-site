#!/usr/bin/env python3
"""Static site generator for pixelbystef.com. Run: python3 build.py <assets_dir> <out_dir>"""
import os, re, sys, shutil, html
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'assets')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'public')
PREVIEW = True  # adds noindex until launch

def rd(p): return open(os.path.join(HERE, p), encoding='utf-8').read()

# ---------------------------------------------------------------- CSS
EXTRA_CSS = r"""
/* films: thumbnail cards that turn into the player on click */
.reels{display:grid;grid-template-columns:repeat(2,1fr);gap:clamp(22px,3vw,44px) clamp(18px,3vw,40px)}
.reel{margin:0}
.reel .play{position:relative;display:block;width:100%;aspect-ratio:16/9;background:#0d0b0a;border:0;padding:0;cursor:pointer;overflow:hidden;border-radius:2px}
.reel .play img{width:100%;height:100%;object-fit:cover;transition:transform .6s ease,opacity .3s}
.reel .play:hover img{transform:scale(1.03);opacity:.85}
.reel .play .btn-p{position:absolute;left:50%;top:50%;width:68px;height:68px;margin:-34px 0 0 -34px;border-radius:50%;background:rgba(250,248,245,.92);display:grid;place-items:center;transition:transform .3s}
.reel .play:hover .btn-p{transform:scale(1.08)}
.reel .play .btn-p:after{content:"";margin-left:5px;border-style:solid;border-width:11px 0 11px 18px;border-color:transparent transparent transparent #1c1917}
.reel iframe{width:100%;aspect-ratio:16/9;border:0;display:block;border-radius:2px;background:#0d0b0a}
.reel figcaption{padding-top:14px;margin-top:0;color:var(--ink)}
.reel figcaption b{display:block;font-family:var(--serif);font-weight:400;font-size:clamp(24px,2.6vw,34px);line-height:1.1}
.reel figcaption i{display:block;color:var(--muted);margin-top:6px;font-size:15px}
.reels-more{margin-top:clamp(28px,4vw,48px);text-align:center}
@media (max-width:760px){.reels{grid-template-columns:1fr}}
/* instagram: post cards with real comments */
.igfeed{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(14px,2vw,28px)}
.igpost{background:var(--paper-2);border-radius:2px;display:flex;flex-direction:column;overflow:hidden}
.igpost .ph{display:block;aspect-ratio:4/5;overflow:hidden}
.igpost .ph img{width:100%;height:100%;object-fit:cover;transition:transform .6s ease}
.igpost .ph:hover img{transform:scale(1.03)}
.igpost .body{padding:16px 18px 18px;display:flex;flex-direction:column;gap:10px;flex:1}
.igpost .meta{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:10px}
.igpost .cap{font-size:14px;line-height:1.5;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.igpost .cap b,.igpost .cm b{font-weight:600}
.igpost ul{list-style:none;margin:0;padding:10px 0 0;border-top:1px solid var(--line);display:grid;gap:7px}
.igpost .cm{font-size:13px;line-height:1.45}
.igpost .foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;padding-top:6px;font-size:10px;color:var(--muted)}
.igpost .foot a{color:var(--rose);text-decoration:none}
@media (max-width:900px){.igfeed{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:8px}.igpost{flex:0 0 80%;scroll-snap-align:start}}

/* ---------- shared: nav + mobile menu ---------- */
.nav a.on{color:var(--rose)}
.menu-btn{display:none;background:none;border:1px solid var(--line);border-radius:999px;padding:8px 14px;font:inherit;font-size:14px;color:var(--ink);cursor:pointer}
.drawer{display:none;border-top:1px solid var(--line);background:var(--paper)}
.drawer nav{display:grid;padding-block:12px 20px}
.drawer a{text-decoration:none;font-family:var(--serif);font-size:28px;padding:6px 0}
.drawer.open{display:block}
@media (max-width:820px){.menu-btn{display:inline-block}}
@media (min-width:821px){.drawer{display:none!important}}
footer .cols4{display:grid;grid-template-columns:1.4fr repeat(3,1fr);gap:24px;padding-bottom:28px;margin-bottom:22px;border-bottom:1px solid var(--line)}
footer .cols4 h4{margin:0 0 10px;font-family:var(--serif);font-weight:400;font-size:22px;color:var(--ink)}
footer .cols4 a{display:block;padding:3px 0}
footer .cols4 p{margin:0;max-width:30ch}
@media (max-width:760px){footer .cols4{grid-template-columns:1fr 1fr}}

/* ---------- page hero (inner pages) ---------- */
.phero{padding-block:clamp(36px,5vw,72px) clamp(48px,6vw,88px)}
.phero .wrap{display:grid;grid-template-columns:1fr 1.15fr;gap:clamp(28px,5vw,80px);align-items:center}
.phero .mono{color:var(--muted);margin-bottom:16px}
.phero h1{font-size:clamp(52px,7.4vw,112px)}
.phero p.lead{font-size:clamp(17px,1.5vw,20px);color:var(--muted);max-width:42ch;margin:22px 0 28px}
.phero .cta-row{justify-content:flex-start}
.phero figure{margin:0}
.phero figure img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:2px}
.phero figure.wide img{aspect-ratio:3/2}
@media (max-width:860px){.phero .wrap{grid-template-columns:1fr}.phero figure{order:-1}}

.prose{max-width:62ch}
.prose p{margin:0 0 18px;font-size:18px}
.feel{padding-block:clamp(40px,6vw,80px)}
.feel .wrap{display:grid;grid-template-columns:.9fr 1.1fr;gap:clamp(28px,5vw,80px);align-items:start}
.feel h2{font-size:clamp(38px,4.6vw,64px)}
@media (max-width:860px){.feel .wrap{grid-template-columns:1fr}}

/* ---------- packages ---------- */
.packages{background:var(--paper-2);padding-block:clamp(64px,9vw,120px)}
.pk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:clamp(16px,2.4vw,32px);align-items:start}
.pk{background:var(--paper);border-radius:4px;padding:clamp(24px,3vw,40px);display:flex;flex-direction:column;gap:18px}
.pk .top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.pk h3{font-size:clamp(32px,3vw,44px)}
.pk .price{font-family:var(--serif);font-size:clamp(34px,3.2vw,48px);line-height:1}
.pk .price small{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-right:8px;vertical-align:middle}
.pk ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.pk li{padding:12px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:22px 1fr;gap:8px}
.pk li::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--rose);margin-top:9px}
.pk .note{color:var(--muted);font-size:15px;margin:0}
.pk-foot{margin-top:clamp(24px,3vw,36px);color:var(--muted);display:flex;flex-wrap:wrap;gap:8px 28px}
.pk-foot a{color:var(--ink)}

/* ---------- steps ---------- */
.steps{padding-block:clamp(64px,9vw,120px)}
.steps ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(20px,3vw,44px);counter-reset:s}
.steps li{border-top:1px solid var(--ink);padding-top:18px;counter-increment:s}
.steps li::before{content:"0" counter(s);font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;color:var(--rose)}
.steps h3{font-size:30px;margin:10px 0}
.steps p{margin:0;color:var(--muted)}
@media (max-width:820px){.steps ol{grid-template-columns:1fr}}

/* ---------- cta band ---------- */
.ctaband{background:var(--ink);color:var(--paper);padding-block:clamp(64px,9vw,120px);text-align:center}
.ctaband h2{font-size:clamp(44px,7vw,100px);max-width:14ch;margin-inline:auto}
.ctaband h2 em{color:#d9b3b8}
.ctaband p{max-width:44ch;margin:20px auto 30px;color:#cfc7c2;font-size:18px}

/* ---------- faq ---------- */
.faq{padding-block:clamp(24px,4vw,56px) clamp(64px,9vw,120px)}
.faq details{border-top:1px solid var(--line);padding-block:6px}
.faq details:last-of-type{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:20px;align-items:baseline;padding-block:18px;font-family:var(--serif);font-size:clamp(24px,2.6vw,34px)}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-family:var(--sans);color:var(--rose);font-size:26px;transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{margin:0 0 20px;max-width:64ch;color:var(--muted);font-size:17.5px}

/* ---------- films page ---------- */
.film-list{display:grid;gap:0;border-top:1px solid var(--line)}
.film-list a{display:grid;grid-template-columns:1fr auto;gap:16px;padding:22px 2px;border-bottom:1px solid var(--line);text-decoration:none;align-items:baseline}
.film-list .t{font-family:var(--serif);font-size:clamp(28px,3.4vw,48px)}
.film-list .t i{color:var(--muted);font-size:.6em;margin-left:8px}
.film-list a:hover .t{color:var(--rose)}
.film-list .go{color:var(--rose)}

/* ---------- contact ---------- */
.contact{padding-block:clamp(36px,5vw,72px) clamp(64px,9vw,120px)}
.contact .wrap{display:grid;grid-template-columns:.85fr 1.15fr;gap:clamp(32px,6vw,96px);align-items:start}
.contact h1{font-size:clamp(52px,7vw,104px)}
.contact .side p{color:var(--muted);max-width:40ch}
.contact .side img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:2px;margin-top:28px;max-width:420px}
form.enquiry{display:grid;grid-template-columns:1fr 1fr;gap:18px 20px}
form.enquiry .full{grid-column:1/-1}
form.enquiry label{display:grid;gap:8px;font-size:15px}
form.enquiry label span{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
form.enquiry input,form.enquiry select,form.enquiry textarea{font:inherit;font-size:17px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:3px;padding:13px 14px;width:100%}
form.enquiry input:focus,form.enquiry select:focus,form.enquiry textarea:focus{outline:none;border-color:var(--rose);box-shadow:0 0 0 3px var(--rose-soft)}
form.enquiry textarea{min-height:170px;resize:vertical}
form.enquiry .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
form.enquiry button{justify-self:start;border:0;cursor:pointer;font:inherit}
form.enquiry .status{grid-column:1/-1;margin:0;min-height:1.5em}
form.enquiry .status.err{color:#a3372c}
.sent{background:var(--paper-2);border-radius:4px;padding:clamp(28px,4vw,48px)}
.sent h2{font-size:clamp(40px,5vw,64px);margin-bottom:12px}
@media (max-width:860px){.contact .wrap{grid-template-columns:1fr}form.enquiry{grid-template-columns:1fr}.contact .side img{display:none}}

/* ---------- small page gallery ---------- */
.pgal{padding-block:0 clamp(40px,6vw,80px)}
.pgal .masonry{columns:3}
@media (max-width:860px){.pgal .masonry{columns:2}}
.about-pair{display:grid;grid-template-columns:1fr 1fr;gap:clamp(12px,2vw,20px)}
.about-pair img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:2px}
.about-pair img:last-child{margin-top:18%}
/* ---------- photo grid (no gaps; landscape photos span 2 columns) ---------- */
.gal{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:clamp(240px,31vw,470px);grid-auto-flow:row dense;gap:clamp(8px,1.2vw,16px)}
.gal figure{margin:0;position:relative;overflow:hidden;border-radius:2px;background:var(--paper-2)}
.gal figure.wide{grid-column:span 2}
.gal img{width:100%;height:100%;object-fit:cover;transition:transform .8s cubic-bezier(.2,.7,.2,1)}
.gal figure:hover img{transform:scale(1.03)}
.gal figcaption{position:absolute;left:10px;bottom:10px;margin:0;color:#fff;font-size:10px;opacity:0;transition:opacity .3s;text-shadow:0 1px 3px rgba(0,0,0,.7)}
.gal figure:hover figcaption{opacity:1}
@media (max-width:700px){.gal{grid-template-columns:repeat(2,1fr);grid-auto-rows:clamp(200px,62vw,340px)}}
.stories{padding-bottom:0}
/* ---------- symmetric page hero ---------- */
.phero .wrap{grid-template-columns:1fr 1fr;align-items:stretch}
.phero .ptext{display:flex;flex-direction:column;justify-content:center;padding-block:clamp(8px,2vw,24px)}
.phero figure.pimg{margin:0;min-height:clamp(340px,40vw,600px);position:relative}
.phero figure.pimg img{position:absolute;inset:0;width:100%;height:100%;aspect-ratio:auto;object-fit:cover;border-radius:2px}
.phero h1{font-size:clamp(48px,6.4vw,100px)}
@media (max-width:860px){.phero .wrap{grid-template-columns:1fr}.phero figure.pimg{order:-1;min-height:clamp(260px,70vw,460px)}}

"""


ALT = {
 'ryan-niamh-2':'Bride walking down the church aisle with her father','ryan-niamh-5':'Groom grinning as he places the ring on the bride',
 'ryan-niamh-9':'Groom and groomsmen in kilts cheering with the bride','ryan-niamh-13':'Couple seen from above on a spiral staircase',
 'ryan-niamh-16':'Father of the bride giving a speech','ryan-niamh-21':'Bride laughing on the dance floor',
 'ryan-niamh-22':'First dance under blue lights','randy-sydney-1':'Couple on grand stone steps in Edinburgh Old Town',
 'randy-sydney-10':'Couple kissing under trees','randy-sydney-13':'Couple in front of a yellow Edinburgh building',
 'randy-sydney-14':'Newlyweds walking hand in hand down a cobbled lane','morgan-julia-1':'Bride with her bridesmaids in pink',
 'morgan-julia-2':'Groom in a red suit embracing the bride by a stained-glass window','morgan-julia-6':'Couple in window light, cheek to cheek',
 'shana-daniel-1':'Newlyweds walking out past wooden panels','shana-daniel-3':'Couple seen from above on a staircase',
 'shana-daniel-13':'Bride hugging a guest','shana-daniel-18':'Wedding ceremony under a prayer shawl',
 'neha-raj-2':'Couple kissing under a leafy porch','neha-raj-12':'Couple silhouetted by tall windows',
 'neha-raj-17':'Couple silhouetted at sunset','neha-raj-18':'Couple on a terrace at sunset',
 'lukas-amanda-2':'Couple at the altar framed by flowers','lukas-amanda-3':'Newlyweds under a stone archway in the sun',
 'lukas-amanda-5':'Groom getting ready by a bright window','lola-denis-2':'Bride and groom sitting on a wooden staircase',
 'lola-denis-13':'Newlyweds on the steps of a grand doorway','lola-denis-18':'Looking up a spiral staircase at the couple',
 'pam-david-1':'Couple framed by white flowers','jingnan-nathan-3':'Bride and groom looking up at the sky',
 'jingnan-nathan-7':'Groom lifting the bride, seen from above','nicole-rilan-2':'Tiny couple on a Highland hilltop',
 'nicole-rilan-5':'Vows by a misty loch','nicole-rilan-6':'Bagpiper playing between the couple','nicole-rilan-8':'Groom dipping the bride for a kiss',
 'nicole-rilan-11':'Bride and groom on a clifftop above a loch','nicole-rilan-14':'Couple celebrating by a vintage bus',
 'nicole-rilan-15':'Bride standing at the edge of a loch','nicole-rilan-19':'Couple dancing, silhouetted in a doorway',
 'maxwell-kat-1':'Couple smiling on Calton Hill','maxwell-kat-5':'Bride laughing during the vows','maxwell-kat-9':'Exchanging rings on Calton Hill',
 'maxwell-kat-18':'Groom standing between the columns of the National Monument','hugo-jessica-3':'Man proposing on one knee by a lake',
 'hugo-jessica-8':'Couple twirling in the park after the proposal','joe-kristina-5':'Woman beaming, showing her new ring',
 'joe-kristina-6':'Proposal under a garden pergola','hadar-samiya-2':'Woman laughing in disbelief after the proposal',
 'hadar-samiya-10':'Proposal on Calton Hill overlooking Edinburgh','brandon-chloe-11':'Proposal under glowing trees at night',
 'brandon-chloe-17':'Couple by a lit-up carousel','eric-melody-1':'Proposal by the lake in St James\'s Park',
 'eric-melody-12':'Hand showing an engagement ring against the sky','ryan-eleni-1':'Proposal beside a fountain',
 'justin-christina-1':'Proposal on an Edinburgh street with the castle behind','chloe-owen-9':'Couple seen through the window of a red London bus',
 'chloe-owen-16':'Couple under cherry blossom','chloe-owen-20':'Couple running down a London street in wedding outfits',
 'jimmy-verga-2':'Couple dancing in silhouette on wet cobbles','welton-mindy-1':'Couple under red lanterns in Chinatown',
 'welton-mindy-5':'Couple in a tunnel of lights','joe-juliet-5':'Couple on a white spiral staircase in a glasshouse',
 'nick-melissa-11':'Woman peeking out of a red phone box','nick-melissa-16':'Man lifting his partner, both laughing',
 'johan-kristina-13':'Couple kissing inside a red phone box','hunter-laura-16':'Couple on a Tube platform',
 'ian-shin-13':'Couple on colourful Victoria Street','nevaeh-leslie-11':'Couple on the top deck of a red bus','sid-sruti-3':'Couple in front of a big wheel',
}
def cap(k):
    a,b=k.split('-')[:2]; return f'{a.title()} &amp; {b.title()}'
def g(*keys):
    return [(k+'.jpg', ALT[k], cap(k)) for k in keys]


PHOTOS_FILE = os.path.join(HERE, 'photos.txt')
_PH = None
def auto_cap(fn):
    parts = os.path.splitext(fn)[0].split('-')
    if len(parts) >= 3 and parts[0].isalpha() and parts[1].isalpha():
        return f'{parts[0].title()} &amp; {parts[1].title()}'
    return ''
def P(section):
    """Photos for a section of photos.txt -> list of (file, alt, caption)."""
    global _PH
    if _PH is None:
        _PH, cur = {}, None
        for raw in open(PHOTOS_FILE, encoding='utf-8'):
            line = raw.split('#', 1)[0].strip() if not raw.lstrip().startswith('#') else ''
            if not line: continue
            if line.startswith('[') and line.endswith(']'):
                cur = line[1:-1].strip(); _PH[cur] = []; continue
            f = [x.strip() for x in line.split('|')]
            fn = f[0]
            key = os.path.splitext(fn)[0]
            alt = f[1] if len(f) > 1 and f[1] else ALT.get(key, 'Photo by pixelbystef')
            cp = html.escape(f[2]) if len(f) > 2 and f[2] else auto_cap(fn)
            if cp in ('-', '&#x27;-&#x27;'): cp = ''
            _PH[cur].append((fn, alt, cp))
    if section not in _PH: raise SystemExit(f'photos.txt is missing the section [{section}]')
    return _PH[section]
def P1(section): return P(section)[0]

import re as _re
def yt_id(url):
    m = _re.search(r'(?:v=|youtu\.be/|embed/)([\w-]{11})', url)
    return m.group(1) if m else url.strip()

def films():
    # [films] in photos.txt:  youtube link | couple names | line under the names
    return [(yt_id(fn), alt, cp) for fn, alt, cp in P('films')]

IG_FILE = os.path.join(HERE, 'instagram.txt')
def ig_posts():
    # instagram.txt: blocks starting with [post], then 'key: value' lines; 'comment: handle | text' can repeat
    posts, cur = [], None
    if not os.path.exists(IG_FILE): return posts
    for raw in open(IG_FILE, encoding='utf-8'):
        line = raw.strip()
        if not line or line.startswith('#'): continue
        if line.lower() == '[post]':
            cur = {'comments': []}; posts.append(cur); continue
        if cur is None or ':' not in line: continue
        k, v = line.split(':', 1); k = k.strip().lower(); v = v.strip()
        if k == 'comment':
            h, _, t = v.partition('|'); cur['comments'].append((h.strip().lstrip('@'), t.strip()))
        else:
            cur[k] = v
    return posts

def ig_feed():
    e = html.escape
    cards = []
    for p in ig_posts():
        cms = ''.join(f'<li class="cm"><b>{e(h)}</b> {e(t)}</li>' for h, t in p['comments'][:2])
        link = e(p.get('link', 'https://www.instagram.com/pixelbystef/'))
        cards.append(
            f'<article class="igpost"><a class="ph" href="{link}" target="_blank" rel="noopener">'
            f'{img(p["photo"], p.get("alt", "Instagram post by pixelbystef"))}</a><div class="body">'
            f'<div class="meta mono"><span>{e(p.get("place", ""))}</span><span>{e(p.get("date", ""))}</span></div>'
            f'<p class="cap"><b>pixelbystef</b> {e(p.get("caption", ""))}</p><ul>{cms}</ul>'
            f'<div class="foot mono"><span>&#9829; {e(p.get("likes", ""))} &nbsp;&middot;&nbsp; {e(p.get("comment_count", ""))} comments</span>'
            f'<a href="{link}" target="_blank" rel="noopener">View post &#8599;</a></div></div></article>')
    return ''.join(cards)

# ---------------------------------------------------------------- helpers
def img(src, alt, cls='', lazy=True):
    p = os.path.join(ASSETS, src)
    w, h = Image.open(p).size
    c = f' class="{cls}"' if cls else ''
    l = ' loading="lazy"' if lazy else ''
    return f'<img{c} src="/assets/{src}" width="{w}" height="{h}" alt="{html.escape(alt)}"{l}>'

def fig(src, alt, cap=None, cls=''):
    c = f'<figcaption class="mono">{cap}</figcaption>' if cap else ''
    return f'<figure{" class=%s" % chr(34)+cls+chr(34) if cls else ""}>{img(src, alt)}{c}</figure>'

NAV_L = [('/weddings', 'Weddings'), ('/elopements', 'Elopements'), ('/proposals', 'Proposals'), ('/couples', 'Pre-wedding')]
NAV_R = [('/films', 'Films'), ('/about', 'About'), ('/faq', 'FAQ')]

def header(active):
    def links(items):
        return ''.join(f'<a href="{h}"{" class=%son%s" % (chr(34), chr(34)) if h == active else ""}>{t}</a>' for h, t in items)
    drawer = ''.join(f'<a href="{h}">{t}</a>' for h, t in NAV_L + NAV_R + [('/contact', "Let's chat")])
    return f'''<header class="top">
  <div class="wrap">
    <nav class="nav l" aria-label="Services">{links(NAV_L)}</nav>
    <a class="logo" href="/">pixelby<em>stef</em></a>
    <nav class="nav r" aria-label="More">{links(NAV_R)}<a class="btn" href="/contact">Let's chat</a><button class="menu-btn" type="button" aria-expanded="false" aria-controls="drawer">Menu</button></nav>
  </div>
  <div class="drawer" id="drawer"><nav class="wrap" aria-label="Mobile">{drawer}</nav></div>
</header>'''

FOOTER = '''<footer>
  <div class="wrap" style="display:block">
    <div class="cols4">
      <div><h4>pixelby<em style="color:var(--rose)">stef</em></h4><p>Cinematic photos and films for couples who'd rather laugh than pose. Edinburgh, London and wherever you are.</p></div>
      <div><h4>Work</h4><a href="/weddings">Weddings</a><a href="/elopements">Elopements</a><a href="/proposals">Proposals</a><a href="/couples">Pre-wedding &amp; couples</a></div>
      <div><h4>More</h4><a href="/films">Films</a><a href="/about">About</a><a href="/faq">FAQ</a><a href="/contact">Contact</a></div>
      <div><h4>Say hi</h4><a href="https://www.instagram.com/pixelbystef/" target="_blank" rel="noopener">Instagram</a><a href="https://www.youtube.com/@pixelbystef" target="_blank" rel="noopener">YouTube</a><span class="email">pixelbystef@gmail.com</span></div>
    </div>
    <span class="mono">© 2026 pixelbystef · Stefan Wijaya · Edinburgh · London · wherever</span>
  </div>
</footer>'''

JS = '''<script>
(function(){var b=document.querySelector('.menu-btn'),d=document.getElementById('drawer');if(b&&d){b.addEventListener('click',function(){var o=d.classList.toggle('open');b.setAttribute('aria-expanded',o);b.textContent=o?'Close':'Menu';});}
var f=document.querySelector('form.enquiry');if(!f)return;var s=f.querySelector('.status'),btn=f.querySelector('button');
f.addEventListener('submit',function(e){e.preventDefault();if(!f.reportValidity())return;btn.disabled=true;btn.textContent='Sending…';s.className='status';s.textContent='';
fetch(f.action,{method:'POST',body:new FormData(f),headers:{'Accept':'application/json'}}).then(function(r){return r.json().catch(function(){return{ok:false}})}).then(function(j){
if(j&&j.ok){var w=document.createElement('div');w.className='sent';w.innerHTML='<p class="mono" style="color:var(--rose)">Message sent</p><h2>Got it! I\\u2019m already a little <em>excited.</em></h2><p>I\\u2019ll reply within 48 hours. In the meantime, have a nosy at the <a href="/films">films</a> or say hi on <a href="https://www.instagram.com/pixelbystef/" target="_blank" rel="noopener">Instagram</a>.</p>';f.replaceWith(w);w.scrollIntoView({behavior:'smooth',block:'center'});}
else{throw new Error((j&&j.error)||'fail')}}).catch(function(err){btn.disabled=false;btn.textContent='Send it';s.className='status err';s.textContent=(err&&err.message&&err.message!=='fail'&&err.message.length<140?err.message+' ':'')+'Something went wrong on my side. Please email me at pixelbystef@gmail.com and I\\u2019ll get back to you.';});});})();
</script>'''

def page(path, title, desc, body, active='', og='hero-cliff.jpg'):
    robots = '<meta name="robots" content="noindex">\n' if PREVIEW else ''
    doc = f'''<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{html.escape(desc)}">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="https://pixelbystef.com/assets/{og}">
<meta property="og:type" content="website">
{robots}<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231d1a19'/%3E%3Ctext x='50%25' y='56%25' text-anchor='middle' dominant-baseline='middle' font-family='Georgia,serif' font-style='italic' font-size='40' fill='%23fbf9f6'%3Es%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
{header(active)}
<main id="top">
{body}
</main>
{FOOTER}
{JS}
</body>
</html>
'''
    os.makedirs(os.path.dirname(os.path.join(OUT, path)), exist_ok=True)
    open(os.path.join(OUT, path), 'w', encoding='utf-8').write(doc)

def pk(name, price, items, note='', label='Full day' ):
    lis = ''.join(f'<li>{i}</li>' for i in items)
    n = f'<p class="note">{note}</p>' if note else ''
    return f'''<article class="pk"><div class="top"><h3>{name}</h3><div class="price"><small>{label}</small>£{price}</div></div><ul>{lis}</ul>{n}</article>'''

def steps(items):
    return '<section class="steps wrap"><div class="sec-head"><h2>How it <em>works</em></h2></div><ol>' + ''.join(f'<li><h3>{a}</h3><p>{b}</p></li>' for a, b in items) + '</ol></section>'

def cta(h='Got a date? Let\'s make it a <em>good one.</em>', p="Tell me about you two. Coffee's on me, or a video call if you're far away."):
    return f'<section class="ctaband"><div class="wrap"><h2>{h}</h2><p>{p}</p><a class="btn light" href="/contact">Let\'s chat</a></div></section>'

def gallery(items):
    out = []
    for fn, alt, cp in items:
        w, h = Image.open(os.path.join(ASSETS, fn)).size
        cls = ' class="wide"' if w > h * 1.15 else ''
        c = f'<figcaption class="mono">{cp}</figcaption>' if cp else ''
        out.append(f'<figure{cls}>{img(fn, alt)}{c}</figure>')
    return '<section class="pgal wrap"><div class="gal">' + ''.join(out) + '</div></section>'

def phero(eyebrow, h1, lead, section, cta2=('#packages', 'See packages')):
    fn, alt, cp = P1(section)
    return f'''<section class="phero"><div class="wrap">
  <div class="ptext"><p class="mono">{eyebrow}</p><h1>{h1}</h1><p class="lead">{lead}</p>
  <div class="cta-row"><a class="btn" href="/contact">Let's chat</a><a class="btn ghost" href="{cta2[0]}">{cta2[1]}</a></div></div>
  <figure class="pimg">{img(fn, alt, lazy=False)}</figure>
</div></section>'''

def feel(h2, paras):
    return f'<section class="feel"><div class="wrap"><h2>{h2}</h2><div class="prose">' + ''.join(f'<p>{p}</p>' for p in paras) + '</div></div></section>'

CONSULT = 'Consultation, planning &amp; moodboard'
TRAVEL = 'Based in Edinburgh &amp; London. Travel and accommodation elsewhere are quoted at cost.'

# ---------------------------------------------------------------- build
def build():
    if os.path.exists(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    open(os.path.join(OUT, 'styles.css'), 'w').write(rd('base.css') + EXTRA_CSS)

    # ---------- HOME ----------
    def figs(section, cls=''):
        return ''.join(f'<figure>{img(fn, alt)}' + (f'<figcaption class="mono">{cp}</figcaption>' if cp else '') + '</figure>' for fn, alt, cp in P(section))
    intro = P('home.intro'); tiles = P('home.tiles'); about = P('home.about'); band = P1('home.band')
    tile_meta = [('/weddings', 'Weddings', 'The whole day, the full film. Tears, speeches, dance-floor chaos.'),
                 ('/elopements', 'Elopements', 'Just you two, a view, and a very big "we did it".'),
                 ('/proposals', 'Proposals', 'I hide in the bushes. You get the reaction on camera.'),
                 ('/couples', 'Pre-wedding', 'Dress up, wander somewhere pretty, be a bit ridiculous. Photos and a short film.')]
    tiles_html = ''.join(f'<a class="tile" href="{h}"><div class="img">{img(t[0], t[1])}</div><h3>{n}<span>→</span></h3><p>{d}</p></a>' for (h, n, d), t in zip(tile_meta, tiles))
    film_items = ''.join(f'      <li><a href="https://www.youtube.com/watch?v={vid}" target="_blank" rel="noopener"><span class="t">{html.escape(names)}</span><span class="go mono">Watch &#8599;</span></a></li>\n' for vid, names, line in films())
    day_html = ''.join(f'<figure>{img(fn, alt)}<figcaption><span class="mono">Sc. {i}</span><b>{cp}</b></figcaption></figure>' for i, (fn, alt, cp) in enumerate(P('home.day'), 1))
    q = P1('home.quote'); cl = P1('home.closing')
    m = f"""<section class="hero-film" aria-label="Showreel">
    <div class="slate t mono"><span>Reel 2026</span><span>2.39 : 1</span></div>
    <video src="/assets/reel.mp4" poster="/assets/reel-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="Showreel of couples laughing, confetti, first kisses and golden-hour portraits"></video>
    <div class="sub"><span>[laughing] okay wait, is it already rolling?</span></div>
    <div class="slate b mono"><span>Edinburgh · London · Europe</span><span>00:00:18:00</span></div>
  </section>
  <section class="hero-copy wrap">
    <p class="mono">Cinematic wedding &amp; couples photographer</p>
    <h1>Your love story, but make it a <em>movie.</em></h1>
    <p>Photos and films for couples who'd rather laugh than pose. Based in Edinburgh &amp; London, happy to jump on a plane.</p>
    <div class="cta-row"><a class="btn" href="/contact">Let's chat</a><a class="btn ghost" href="/films">See the films</a></div>
  </section>
  <section class="intro wrap" aria-label="Introduction"><div class="grid">
    <figure class="a">{img(intro[0][0], intro[0][1])}<figcaption class="mono">{intro[0][2]}</figcaption></figure>
    <div class="b"><h2>I photograph people having the time of their <em>lives</em>, and all the tiny moments in between.</h2>
      <p>The nervous laugh before the vows. The ice cream you definitely didn't share. The spin nobody planned.</p></div>
    <figure class="c">{img(intro[1][0], intro[1][1])}<figcaption class="mono">{intro[1][2]}</figcaption></figure>
  </div></section>
  <section class="stories wrap" aria-label="Recent stories">
    <div class="sec-head"><h2>Recent <em>stories</em></h2><p>A few favourites, from the Highlands to the Tube.</p></div>
  </section>
  {gallery(P('home.stories'))}
  <section class="band" aria-label="Featured photo">{img(band[0], band[1])}<span class="credit mono">{band[2]}</span>
    <div class="over"><h2>Somewhere between a film set and a day out with <em>friends.</em></h2></div></section>
  <section class="scenes wrap" id="work"><div class="sec-head"><h2>Pick your <em>scene</em></h2><p>Four ways to work together. Same vibe, same colour, same guy with the camera.</p></div>
    <div class="tiles">{tiles_html}</div></section>
  <section class="about" id="about"><div class="wrap">
    <div><div class="pair">{img(about[0][0], about[0][1], 'p1')}{img(about[1][0], about[1][1], 'p2')}</div></div>
    <div><p class="mono">Hi, I'm Stefan</p><h2>Physicist by training. Hopeless <em>romantic</em> by trade.</h2>
      <p>I spent years measuring light in a lab. Now I chase it at golden hour with couples who'd rather be having fun than holding a pose.</p>
      <p>Expect good vibes, a few bad jokes, easy prompts that actually work, and photos that look like stills from your own film.</p>
      <div class="facts"><span>Photo + film</span><span>Cinema cameras + drone</span><span>Same-day sneak peek</span><span>UK &amp; Europe</span></div>
      <a class="btn ghost" href="/about">Get to know me</a></div>
  </div></section>
  <section class="day" aria-label="A wedding day in scenes">
    <div class="wrap sec-head"><h2>A wedding day, <em>in scenes</em></h2><p>Scroll along →</p></div>
    <div class="rail"><div class="row">{day_html}</div></div>
  </section>
  <section class="why wrap" id="why"><div class="cols">
    <div class="col"><span class="mono">The vibe</span><h3>Zero awkwardness</h3><p>Most couples tell me they're awkward. None of them are by the end. Easy, slightly silly prompts, then I get out of the way.</p></div>
    <div class="col"><span class="mono">The kit</span><h3>Photo + film, one person</h3><p>Cinema cameras, proper audio and a drone. One friendly face at your wedding instead of a whole crew.</p></div>
    <div class="col"><span class="mono">The look</span><h3>Graded like a film still</h3><p>Warm, rich, a little nostalgic. Every frame coloured by hand, never a trendy preset.</p></div>
  </div></section>
  <section class="films" id="films"><div class="wrap">
    <div class="still"><span class="mono">Now showing</span><img src="/assets/reel-poster.jpg" width="1280" height="536" alt="Still frame from the wedding showreel" loading="lazy"></div>
    <div><h2>Now <em>showing</em></h2><ul class="listing">
{film_items}    </ul></div>
  </div></section>
  <section class="quote"><div class="wrap">{img(q[0], q[1])}
    <div><blockquote>“Stefan really has given us the best memories and we are so grateful for him. The most supportive, patient, and lovely <em>photographer.</em>”</blockquote><cite class="mono">Chris &amp; Nia</cite></div>
  </div></section>
  <section class="insta wrap" aria-label="Instagram">
    <div class="sec-head"><h2>Lately on <em>Instagram</em></h2><a class="mono" href="https://www.instagram.com/pixelbystef/" target="_blank" rel="noopener">Follow @pixelbystef &#8599;</a></div>
    <div class="igfeed">{ig_feed()}</div>
  </section>
  <section class="closing" id="chat">{img(cl[0], cl[1])}
    <div class="over"><h2>Got a date? Let's make it a <em>good one.</em></h2><p>Tell me about you two. Coffee's on me, or a video call if you're far away.</p><a class="btn light" href="/contact">Let's chat</a></div>
  </section>"""
    page('index.html', 'pixelbystef · Cinematic wedding & couples photographer, Edinburgh & London',
         "Cinematic wedding and couples photographer and filmmaker based in Edinburgh and London. Photos and films for couples who'd rather laugh than pose.", m, '/')

    # ---------- WEDDINGS ----------
    body = phero('Weddings · photo &amp; film', 'The whole day. The full <em>film.</em>',
                 'From the nervous laughter at prep to the questionable dance moves at midnight, I cover your wedding like a film set, minus the clapperboard.',
                 'weddings.hero')
    body += gallery(P('weddings.gallery'))
    body += feel('Real moments, a bit of <em>direction</em>, lots of colour.', [
        "Most of the day I blend in and let things happen: the hugs, the happy tears, your uncle's speech that runs ten minutes too long. When we need a shot, I jump in, keep it quick, and send you back to your drink.",
        "Everything is shot with cinema cameras and graded by hand, so your photos and your film look like they belong to the same movie.",
        "Tea ceremony in the morning and a ceilidh at night? Two days, two countries? Tell me the plan and I'll shape the coverage around it."])
    body += f'''<section class="packages" id="packages"><div class="wrap">
  <div class="sec-head"><h2>Wedding <em>packages</em></h2><p>Book photo, film, or both. Booking both? Ask for a combined quote.</p></div>
  <div class="pk-grid">
  {pk('Photo', '1,400', [CONSULT, '8 hours of coverage', '500–800 high-res images, formatted for print', '500–800 high-res images, formatted for social media', 'Preview of 20 images within 24 hours', 'Delivered in an online gallery within 4 weeks'])}
  {pk('Film', '1,600', [CONSULT, '8 hours of coverage with 2 cinema cameras, pro audio &amp; drone', '10–12 minute wedding film', '1–2 minute highlight film', 'Full ceremony &amp; speeches recordings', 'Delivered online within 4 weeks'])}
  </div>
  <div class="pk-foot"><span>Shorter day? Half-day coverage is available, just ask.</span><span>{TRAVEL}</span></div>
</div></section>'''
    body += steps([('We chat', 'Coffee in Edinburgh or London, or a video call. You tell me about you two and the day you have in mind.'),
                   ('We plan', 'Moodboard, timeline and locations, built around the best light. I send reminders so you don\'t have to.'),
                   ('You enjoy it', 'On the day you get on with celebrating. A sneak peek lands within 24 hours, the rest within 4 weeks.')])
    body += cta()
    page('weddings.html', 'Wedding photography & films · pixelbystef', 'Cinematic wedding photography and films in Edinburgh, London, the UK and Europe. Photo from £1,400, film from £1,600.', body, '/weddings', P1('weddings.hero')[0])

    # ---------- ELOPEMENTS ----------
    body = phero('Elopements', 'Just you two. And a very big <em>view.</em>',
                 "Skip the seating plan. A Highland loch, Calton Hill at sunrise, a city registry office followed by pints. I'll help you pick the spot, time it for the light, and make it feel like the opening scene of a film.",
                 'elopements.hero')
    body += gallery(P('elopements.gallery'))
    body += feel('Small day. Big <em>feelings.</em>', [
        "Elopements are my favourite kind of adventure. No schedule to keep, no one to entertain, just the two of you and whatever the Scottish weather decides to do.",
        "I know the good spots in and around Edinburgh (and the midge-free ones), and I'm happy to travel for the right view. We start with an engagement shoot so you're comfy with me long before the day itself."])
    body += f'''<section class="packages" id="packages"><div class="wrap">
  <div class="sec-head"><h2>Elopement <em>package</em></h2><p>Everything you need for a small, cinematic day.</p></div>
  <div class="pk-grid">
  {pk('Elopement', '1,400', [CONSULT, '2-hour engagement shoot', '4-hour cinematic elopement coverage', '300–400 high-res images, formatted for print', '300–400 high-res images, formatted for social media', 'Preview of 10 images within 24 hours', 'Delivered in an online gallery within 4 weeks'], label='Package')}
  </div>
  <div class="pk-foot"><span>Want a film too? Ask me about adding one.</span><span>{TRAVEL}</span></div>
</div></section>'''
    body += steps([('We chat', 'Tell me what you\'re dreaming of: mountains, sea, city, or somewhere only you two know.'),
                   ('We plan', 'Location scouting, timings for the light, the paperwork people, and a backup plan for rain.'),
                   ('We go', 'Engagement shoot first, then the big day. A sneak peek arrives within 24 hours.')])
    body += cta('Just the two of you? Let\'s make it <em>epic.</em>')
    page('elopements.html', 'Elopement photography in Scotland & beyond · pixelbystef', 'Cinematic elopement photography in Edinburgh, the Highlands and beyond. Engagement shoot plus 4-hour elopement coverage for £1,400.', body, '/elopements', P1('elopements.hero')[0])

    # ---------- PROPOSALS ----------
    body = phero('Proposals', 'I hide. You ask. We get the <em>reaction.</em>',
                 "Proposals are basically a heist with a happy ending. We plan it together, I play the tourist with a camera, and you get the moment they realise, from start to “YES”.",
                 'proposals.hero')
    body += gallery(P('proposals.gallery'))
    body += feel('The secret <em>mission.</em>', [
        "We'll work out where you'll stand, what the signal is, and how to get them there without suspicion. I'll scout the spot beforehand so I know exactly where the light falls.",
        "After the big moment (and the happy crying), we stay for a relaxed couple shoot nearby, so you get the reaction and the celebration."])
    body += f'''<section class="packages" id="packages"><div class="wrap">
  <div class="sec-head"><h2>Proposal <em>package</em></h2><p>Planning, the moment, and a shoot straight after.</p></div>
  <div class="pk-grid">
  {pk('Proposal', '350', [CONSULT, 'Proposal coverage: photos + behind-the-scenes video', '2-hour cinematic couple shoot nearby, straight after', '80–120 high-res images, formatted for print', '80–120 high-res images, formatted for social media', 'Preview of 10 images within 24 hours', 'Delivered in an online gallery within 1 week'], label='Package')}
  </div>
  <div class="pk-foot"><span>{TRAVEL}</span></div>
</div></section>'''
    body += steps([('Secret call', 'You tell me the plan (or the lack of one). I help fill the gaps.'),
                   ('The recce', 'I scout the spot, work out where to hide, and agree the signal with you.'),
                   ('The YES', 'I capture the moment, then we celebrate with a 2-hour shoot nearby.')])
    body += cta('Planning to pop the <em>question?</em>', "Message me. I'm very good at keeping secrets.")
    page('proposals.html', 'Proposal photography · pixelbystef', 'Secret proposal photography in Edinburgh, London and beyond: planning, the moment, and a 2-hour shoot after. £350.', body, '/proposals', P1('proposals.hero')[0])

    # ---------- PRE-WEDDING / COUPLES ----------
    body = phero('Pre-wedding &amp; couples', 'Main-character energy, on <em>demand.</em>',
                 "Pre-wedding shoots, engagements, anniversaries, or “we just want nice photos of us”. We wander somewhere beautiful, I give you daft prompts, you laugh, I shoot, and I film a short movie of it too.",
                 'couples.hero')
    body += gallery(P('couples.gallery'))
    body += feel('An excuse to be a bit <em>ridiculous.</em>', [
        "Most couples tell me they're awkward in front of the camera. None of them are by the end. I'll give you easy, slightly silly prompts, and you'll forget I'm there.",
        "Getting married soon? A pre-wedding shoot is also the best way to get comfy with me before the big day, and you get a short film to show everyone at the reception."])
    body += f'''<section class="packages" id="packages"><div class="wrap">
  <div class="sec-head"><h2>Pre-wedding <em>package</em></h2><p>Photos and a short film, one relaxed session.</p></div>
  <div class="pk-grid">
  {pk('Photo + film', '550', [CONSULT, '3-hour session, photo + video', '80–120 high-res images, formatted for print', '80–120 high-res images, formatted for social media', '1–2 minute short film', 'Preview of 10 images within 24 hours', 'Delivered in an online gallery within 2 weeks'], label='Package')}
  </div>
  <div class="pk-foot"><span>{TRAVEL}</span></div>
</div></section>'''
    body += steps([('We chat', 'Tell me what you love: city, nature, your favourite café, a place that means something.'),
                   ('We plan', 'Moodboard, outfits, locations and timing for the best light.'),
                   ('We play', 'Three hours of wandering, laughing and a few daft prompts. Sneak peek within 24 hours.')])
    body += cta('Fancy starring in your own <em>film?</em>')
    page('couples.html', 'Pre-wedding & couples photography · pixelbystef', 'Cinematic pre-wedding and couples photo + film sessions in Edinburgh, London and beyond. 3 hours, photos and a short film, £550.', body, '/couples', P1('couples.hero')[0])

    # ---------- FILMS ----------
    body = '''<section class="hero-film" aria-label="Showreel">
    <div class="slate t mono"><span>Reel 2026</span><span>2.39 : 1</span></div>
    <video src="/assets/reel.mp4" poster="/assets/reel-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="Showreel of couples laughing, confetti and first kisses"></video>
    <div class="sub"><span>[music swells]</span></div>
    <div class="slate b mono"><span>Edinburgh · London · Europe</span><span>00:00:18:00</span></div>
  </section>
  <section class="phero" style="padding-bottom:0"><div class="wrap" style="grid-template-columns:1fr">
    <div><p class="mono">Films</p><h1>Now <em>showing</em></h1><p class="lead">Cinema cameras, proper audio and a drone, cut into films you'll actually rewatch. Grab some popcorn.</p></div>
  </div></section>
  <section class="wrap" style="padding-block:24px clamp(64px,9vw,120px)"><div class="reels">'''
    for vid, names, line in films():
        n = html.escape(names)
        body += (f'<figure class="reel"><button class="play" type="button" data-yt="{vid}" aria-label="Play the film: {n}">'
                 f'<img src="https://i.ytimg.com/vi/{vid}/maxresdefault.jpg" onerror="this.onerror=null;this.src=&#39;https://i.ytimg.com/vi/{vid}/hqdefault.jpg&#39;" alt="Still from the wedding film of {n}" loading="lazy" width="1280" height="720">'
                 f'<span class="btn-p"></span></button><figcaption><b>{n}</b>' + (f'<i>{line}</i>' if line else '') + '</figcaption></figure>')
    body += '''</div><p class="reels-more"><a class="btn ghost" href="https://www.youtube.com/@pixelbystef" target="_blank" rel="noopener">More films on YouTube &#8599;</a></p></section>
<script>document.querySelectorAll('.reel .play').forEach(function(b){b.addEventListener('click',function(){var f=document.createElement('iframe');f.src='https://www.youtube-nocookie.com/embed/'+b.dataset.yt+'?autoplay=1&rel=0';f.title=b.getAttribute('aria-label');f.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';f.allowFullscreen=true;b.replaceWith(f);});});</script>'''
    body += cta('Want your own <em>premiere?</em>')
    page('films.html', 'Wedding films · pixelbystef', 'Cinematic wedding films shot on cinema cameras with pro audio and drone, by Stefan of pixelbystef.', body, '/films', 'reel-poster.jpg')

    # ---------- ABOUT ----------
    body = f'''<section class="phero"><div class="wrap">
  <div><p class="mono">About</p><h1>Hi, I'm <em>Stefan.</em></h1>
  <p class="lead">Physicist by training. Hopeless romantic by trade. Based between Edinburgh and London.</p>
  <div class="cta-row"><a class="btn" href="/contact">Let's chat</a><a class="btn ghost" href="/films">See the films</a></div></div>
  <div class="about-pair">{''.join(img(fn, alt, lazy=False) for fn, alt, cp in P('about.photos')[:2])}</div>
</div></section>'''
    body += feel('I was trained to measure light. Now I mostly <em>chase</em> it.', [
        "Across hillsides at golden hour, through confetti, onto dance floors at 11pm. The physics never really left: I get unreasonably excited about backlight, reflections and the way light wraps around a face. That's why my photos look the way they do.",
        "I grew up on cinema and on the Asian wedding photographers and filmmakers who shoot every frame like a movie still. That's the look I bring to weddings across the UK and Europe: warm colour, big frames, real moments, and a bit of drama when the light allows it.",
        "My favourite subject is still people, especially couples who forget I'm there and just have fun with each other. On the day I'll give you simple prompts (“walk, whisper something terrible in their ear, go”), then step back. Your guests will think I'm a friend who brought a nice camera. That's the idea."])
    body += '<section class="why wrap"><div class="cols">'
    body += '<div class="col"><span class="mono">The vibe</span><h3>Chill, with bad jokes</h3><p>Relaxed, friendly, and never stiff. Most of the day I blend in.</p></div>'
    body += '<div class="col"><span class="mono">The kit</span><h3>Photo + film</h3><p>Cinema cameras, pro audio and a drone, all run by one friendly face.</p></div>'
    body += '<div class="col"><span class="mono">The nerd bit</span><h3>Obsessed with light</h3><p>I plan timings around the sun, so golden hour happens on purpose.</p></div>'
    body += '</div></section>'
    body += gallery(P('about.gallery'))
    body += cta()
    page('about.html', 'About Stefan · pixelbystef', 'Stefan Wijaya: physicist by training, cinematic wedding and couples photographer and filmmaker based in Edinburgh and London.', body, '/about', P('about.photos')[0][0])

    # ---------- FAQ ----------
    faqs = [
        ("What's your style?", "Cinematic, candid, and a bit playful. Think film stills rather than school photos: real moments, warm colour, big frames, and the odd dramatic backlight shot because I can't help myself."),
        ("We're awkward in front of the camera. Is that a problem?", "Everyone says this. Literally everyone. I'll give you easy, slightly silly prompts that get you laughing, and the awkwardness disappears in about ten minutes. You don't need to know how to pose. That's my job."),
        ("How involved are you before the day?", "As much as you want. Every package starts with a consultation, planning and a moodboard. I'm happy to help with timelines, locations, and when the light's best. Think sounding board, not drill sergeant."),
        ("What are you like on the day?", "Chill. Mostly I blend in and let the day happen. When we need a shot, I jump in, keep it quick, and send you back to your drink."),
        ("Do you do photo and film?", "Yes, both, and both by me. One person to talk to, a consistent look across photos and film, and one less stranger at your wedding."),
        ("How much do you charge?", "Weddings: photo £1,400, film £1,600 (full day). Elopements £1,400. Proposals £350. Pre-wedding photo + film £550. Half-day and custom options are available. See each page for what's included."),
        ("Do you travel?", "All the time. I'm based in Edinburgh and London and have filmed as far as Germany. Travel and accommodation are quoted at cost, with no surprises."),
        ("When do we get everything?", "A preview within 24 hours for every package. Full galleries arrive within 1 week (proposals), 2 weeks (pre-wedding) or 4 weeks (weddings and elopements)."),
        ("Can we build a custom package?", "Absolutely. Two days, two countries, a tea ceremony in the morning and a ceilidh at night: tell me the plan and I'll shape the coverage around it."),
    ]
    body = '<section class="phero" style="padding-bottom:0"><div class="wrap" style="grid-template-columns:1fr"><div><p class="mono">FAQ</p><h1>Good <em>questions.</em></h1><p class="lead">The things couples usually ask before they get in touch. Anything else, just message me.</p></div></div></section>'
    body += '<section class="faq wrap">' + ''.join(f'<details{" open" if i == 0 else ""}><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for i, (q, a) in enumerate(faqs)) + '</section>'
    body += cta('Still <em>curious?</em>', "Ask me anything. I'm quick to reply and slow to judge.")
    page('faq.html', 'FAQ · pixelbystef', 'Pricing, travel, delivery times and what it is like working with pixelbystef.', body, '/faq', 'laugh.jpg')

    # ---------- CONTACT ----------
    body = f'''<section class="contact"><div class="wrap">
  <div class="side"><p class="mono" style="color:var(--muted);margin-bottom:16px">Contact</p>
    <h1>Let's make something <em>good.</em></h1>
    <p>Tell me a bit about you two. I reply within 48 hours, usually with too many exclamation marks.</p>
    <p>Prefer email? <span class="email">pixelbystef@gmail.com</span></p>
    {img(*P1('contact.photo')[:2])}
  </div>
  <form class="enquiry" action="/api/enquiry" method="post">
    <label class="full"><span>Your names (both of you!)</span><input id="f-names" name="names" required maxlength="120" autocomplete="name"></label>
    <label><span>Email</span><input id="f-email" name="email" type="email" required maxlength="160" autocomplete="email"></label>
    <label><span>Phone (optional)</span><input id="f-phone" name="phone" type="tel" maxlength="40" autocomplete="tel"></label>
    <label><span>What are we shooting?</span><select id="f-type" name="type" required>
      <option value="">Choose one</option><option>Wedding</option><option>Elopement</option><option>Proposal</option><option>Pre-wedding / couples</option><option>Something else</option></select></label>
    <label><span>Photo, film, or both?</span><select id="f-medium" name="medium">
      <option>Photo</option><option>Film</option><option selected>Both</option><option>Not sure yet</option></select></label>
    <label><span>Date (rough is fine)</span><input id="f-date" name="date" maxlength="80" placeholder="e.g. June 2027"></label>
    <label><span>Where?</span><input id="f-place" name="place" maxlength="120" placeholder="Venue, city or 'no idea yet'"></label>
    <label class="full"><span>Tell me your story. How did you meet, and what's the vibe?</span><textarea id="f-msg" name="message" required maxlength="5000"></textarea></label>
    <label class="full"><span>How did you find me? (optional)</span><input id="f-src" name="source" maxlength="120"></label>
    <div class="hp" aria-hidden="true"><label>Company<input id="f-company" name="company" tabindex="-1" autocomplete="off"></label></div>
    <button class="btn" type="submit">Send it</button>
    <p class="status" role="status" aria-live="polite"></p>
  </form>
</div></section>'''
    page('contact.html', "Let's chat · pixelbystef", 'Enquire about wedding, elopement, proposal and pre-wedding photography and films with pixelbystef.', body, '/contact', 'blossom-laugh.jpg')

    # ---------- THANKS (no-JS fallback) + 404 ----------
    body = '<section class="contact"><div class="wrap" style="grid-template-columns:1fr"><div class="sent"><p class="mono" style="color:var(--rose)">Message sent</p><h2>Got it! I\'m already a little <em>excited.</em></h2><p>I\'ll reply within 48 hours. In the meantime, have a nosy at the <a href="/films">films</a>.</p></div></div></section>'
    page('thanks.html', 'Thank you · pixelbystef', 'Thanks for getting in touch.', body)
    body = '<section class="phero"><div class="wrap" style="grid-template-columns:1fr"><div><p class="mono">404</p><h1>This scene got <em>cut.</em></h1><p class="lead">The page you were looking for isn\'t here. Try the homepage instead.</p><div class="cta-row"><a class="btn" href="/">Back to the start</a></div></div></div></section>'
    page('404.html', 'Page not found · pixelbystef', 'Page not found.', body)

    # ---------- copy only referenced assets ----------
    used = set()
    for f in os.listdir(OUT):
        if f.endswith('.html'):
            used |= set(re.findall(r'/assets/([\w.-]+\.(?:jpg|mp4))', open(os.path.join(OUT, f)).read()))
    os.makedirs(os.path.join(OUT, 'assets'))
    missing = []
    for u in sorted(used):
        src = os.path.join(ASSETS, u)
        if os.path.exists(src):
            dst = os.path.join(OUT, 'assets', u)
            if u.lower().endswith('.jpg'):
                im = Image.open(src)
                if max(im.size) > 2200 or os.path.getsize(src) > 900_000:
                    from PIL import ImageOps
                    im = ImageOps.exif_transpose(im).convert('RGB')
                    im.thumbnail((2000, 2000) if im.width > im.height else (1300, 1300), Image.LANCZOS)
                    im.save(dst, quality=78, optimize=True, progressive=True); continue
            shutil.copy(src, dst)
        else: missing.append(u)
    print('pages:', sorted(f for f in os.listdir(OUT) if f.endswith('.html')))
    print('assets:', len(used), 'missing:', missing)

if __name__ == '__main__':
    build()
