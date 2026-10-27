# The Phone-Only Graphic Design Course

**Complete beginner → portfolio-ready in 15 study days.**
2 h 30 m per day, Saturday to Wednesday, with Thursday and Friday off. No laptop, no Adobe subscription — a phone, free apps and a notebook.

---

## What you get

| File | What it is | Use it when |
| --- | --- | --- |
| **`GRAPHIC-DESIGN-COURSE.html`** | The complete course as one self-contained web page with print styling | **Best for reading or making a PDF.** Open it, then use your browser's *Print → Save as PDF* |
| **`GRAPHIC-DESIGN-COURSE.md`** | The same course as one long Markdown document (40,800 words) | Sharing, version control, reading on GitHub, pasting into Notion/Docs |
| **`site/`** | A browsable study app: day-by-day navigation, tickable task lists, saved progress, print support | Studying. Open `site/index.html`, or host it (see below) |
| `days/day-01.md` … `day-15.md` | The source files, one per day | Editing a day, or study a single session at a time |
| `meta.md` / `appendix.md` | Front matter (how to study, the calendar, marking rubric) and the reference appendix | Read `meta.md` first; use `appendix.md` daily |
| `build.py` | Rebuilds all three artefacts from the source files | After any edit: `python3 build.py` |

## Start here

1. Read the front matter — **"Read this page before Day 1"** in `GRAPHIC-DESIGN-COURSE.html` (or `meta.md`). It contains the calendar, the 2 h 30 m session plan, the marking rubric and the toolkit.
2. Set up the phone studio: three galleries, a Design Log, a Pinterest board, a Canva folder (Day 1 walks you through it).
3. Do Day 1. Do not read ahead to the "interesting" days — the sequence is designed so each day uses the one before.
4. Thursdays and Fridays are off. Use Thursday only to catch up if you fell behind.

## The calendar

| Week | Study days | Days | Off |
| --- | --- | --- | --- |
| 1 — Foundations | Sat, Sun, Mon, Tue, Wed | 1 → 5 | Thu, Fri |
| 2 — Craft | Sat, Sun, Mon, Tue, Wed | 6 → 10 | Thu, Fri |
| 3 — Advanced + portfolio | Sat, Sun, Mon, Tue, Wed | 11 → 15 | Thu, Fri |

## The fifteen days

| Day | Focus | Main deliverable |
| --- | --- | --- |
| 1 | What design is; process; phone studio | 5 critiques + studio set up |
| 2 | Elements of design + Gestalt | 3 reverse-engineered breakdowns |
| 3 | Composition, alignment, hierarchy | 5 thumbnails + finished poster |
| 4 | Colour theory in practice | 3 palettes + recolour study |
| 5 | Typography | 6 treatments + a quote poster |
| 6 | Typesetting and editorial layout | 2-page spread + clinic leaflet |
| 7 | Phone photo editing and compositing | Edited photo set + capstone chosen |
| 8 | Logo design | 50 sketches → 1 refined mark |
| 9 | Brand identity systems | One-page brand sheet |
| 10 | Print production | Print-ready flyer + adaptations |
| 11 | Art direction and storytelling | Three-image campaign |
| 12 | Content at scale + motion | Carousel + animated post |
| 13 | UX/UI | Flow, wireframe, hi-fi screen |
| 14 | Client work: briefs, pricing, feedback | Quote, presentation, client reply |
| 15 | Portfolio and launch | Case study + live portfolio page |

Every day follows the same nine-part structure: why it matters · objectives · the 2 h 30 m plan · lesson · guided practice · **practical questions** · **client scenario** · deliverable + self-marking answers · **research for tomorrow**.

## Run the study site

The site is static — no build step, no dependencies, no tracking. Progress is stored in the browser's `localStorage`.

```bash
# from this folder
python3 -m http.server 8100 --bind 0.0.0.0 --directory site
# then open http://localhost:8100
```

Or just open `site/index.html` directly in a browser. To publish it, upload the `site/` folder to any static host (GitHub Pages, Netlify, Vercel) — or copy all four files (`index.html`, `styles.css`, `app.js`, `data.js`) into a folder and drop it on any web space.

Features: day navigation with progress ring, tickable deliverables that persist between sessions, keyboard arrows to move between days, deep links (`#/day/7`), and a print stylesheet that produces clean PDFs.

## Editing the course

Content lives in Markdown, so you can rewrite a day without touching code:

```bash
# edit any file, then rebuild all three artefacts
python3 build.py
```

`build.py` converts a deliberately small Markdown subset — headings, paragraphs, bold/italic, links, bullets, numbered lists, checkbox task lists, blockquotes, pipe tables and fenced code — into HTML. It writes `GRAPHIC-DESIGN-COURSE.md`, `GRAPHIC-DESIGN-COURSE.html` and `site/data.js`. Python 3.8+, standard library only.

## How marking works

Each day's deliverable is scored out of 12 on four criteria: **purpose, hierarchy, craft, fitness**. 9–12 move on; 6–8 redo the weakest criterion; 0–5 redo the deliverable before building on it. The full rubric, the design-log template, the brief template, print specs, export settings, font pairings and a glossary are all in `appendix.md`.

## Honest limits

This course is designed around a phone, so it is explicit about what a phone cannot do well: precise vector drawing, multi-page layout, and true CMYK print production (you can *specify* a print job correctly, but not run it end to end). Each day flags when a task is phone-ideal and when it needs a borrowed laptop hour. Days 10, 13 and 15 tell you exactly what to do when you get one.
