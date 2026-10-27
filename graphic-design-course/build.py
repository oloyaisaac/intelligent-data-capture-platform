#!/usr/bin/env python3
"""Build script for the Phone-Only Graphic Design Course.

Single source of truth: meta.md, days/day-NN.md, appendix.md
Outputs:
  * GRAPHIC-DESIGN-COURSE.md  -- the full printable document
  * site/data.js              -- the same content as structured, pre-rendered HTML

Run:  python3 build.py
"""

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAYS_DIR = ROOT / "days"

PHASES = {
    range(1, 6): ("Foundations", "Get the vocabulary and the habits right"),
    range(6, 11): ("Craft", "Do the real work: type, photo, logo, brand, print"),
    range(11, 16): ("Advanced", "Systems, art direction, clients, portfolio"),
}


def phase_for(n: int) -> tuple[str, str]:
    for rng, val in PHASES.items():
        if n in rng:
            return val
    return ("Course", "")


# ---------------------------------------------------------------- inline marks
CODE_TOKEN = "\x00CODE{}\x00"


def inline(text: str) -> str:
    text = html.escape(text, quote=False)
    codes: list[str] = []

    def keep_code(m: re.Match) -> str:
        codes.append(f"<code>{m.group(1)}</code>")
        return CODE_TOKEN.format(len(codes) - 1)

    text = re.sub(r"`([^`]+)`", keep_code, text)
    text = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        r'<a href="\2" target="_blank" rel="noopener">\1</a>',
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\*\w])\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)

    for i, code in enumerate(codes):
        text = text.replace(CODE_TOKEN.format(i), code)
    return text


# ---------------------------------------------------------------- block parser
def render_blocks(lines: list[str], id_prefix: str = "") -> str:
    out: list[str] = []
    i = 0
    n = len(lines)
    counter = {"i": 0}

    def next_id() -> str:
        counter["i"] += 1
        return f"{id_prefix}i{counter['i']}" if id_prefix else ""

    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # sub-heading (### and deeper)
        mh = re.match(r"^(#{3,6})\s+(.*)$", stripped)
        if mh:
            tag = "h" + str(len(mh.group(1)))
            out.append(f"<{tag}>{inline(mh.group(2))}</{tag}>")
            i += 1
            continue

        # fenced code
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append(f"<pre><code>{html.escape(chr(10).join(buf))}</code></pre>")
            continue

        # table
        if stripped.startswith("|") and i + 1 < n and re.match(r"^\s*\|[\s:\-|]+\|\s*$", lines[i + 1]):
            header = [c.strip() for c in stripped.strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            thead = "".join(f"<th>{inline(c)}</th>" for c in header)
            tbody = "".join(
                "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows
            )
            out.append(
                f'<div class="table-wrap"><table><thead><tr>{thead}</tr></thead>'
                f"<tbody>{tbody}</tbody></table></div>"
            )
            continue

        # checkbox task list
        if re.match(r"^\s*-\s\[[ xX]\]\s", line):
            items = []
            while i < n and re.match(r"^\s*-\s\[[ xX]\]\s", lines[i]):
                body = re.sub(r"^\s*-\s\[[ xX]\]\s*", "", lines[i]).strip()
                items.append(
                    f'<li class="task"><label><input type="checkbox" data-key="{next_id()}">'
                    f"<span>{inline(body)}</span></label></li>"
                )
                i += 1
            out.append(f'<ul class="tasks">{"".join(items)}</ul>')
            continue

        # unordered list
        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while i < n and re.match(r"^\s*[-*]\s+", lines[i]):
                body = re.sub(r"^\s*[-*]\s+", "", lines[i]).strip()
                items.append(f"<li>{inline(body)}</li>")
                i += 1
            out.append(f"<ul>{''.join(items)}</ul>")
            continue

        # ordered list
        if re.match(r"^\s*\d+[.)]\s+", line):
            items = []
            while i < n and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                body = re.sub(r"^\s*\d+[.)]\s+", "", lines[i]).strip()
                items.append(f"<li>{inline(body)}</li>")
                i += 1
            out.append(f"<ol>{''.join(items)}</ol>")
            continue

        # blockquote
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]).strip())
                i += 1
            out.append(f'<blockquote>{render_blocks(buf, id_prefix)}</blockquote>')
            continue

        # paragraph
        buf = []
        start = i
        while i < n and lines[i].strip() and not re.match(
            r"^\s*(#{2,6}\s|[-*]\s|\d+[.)]\s|>\s|\||```)", lines[i]
        ):
            buf.append(lines[i].strip())
            i += 1
        if not buf:  # unrecognised construct: consume one line so we can't loop
            buf = [lines[i].strip()]
            i += 1
        out.append(f"<p>{inline(' '.join(buf))}</p>")

    return "\n".join(out)


# ---------------------------------------------------------------- md -> sections
def split_sections(text: str) -> tuple[str, list[dict]]:
    """Return (h1 title, sections)."""
    lines = text.splitlines()
    title = ""
    if lines and lines[0].startswith("# "):
        title = lines[0][2:].strip()
        lines = lines[1:]

    # metadata block (before first ##)
    meta_lines: list[str] = []
    while lines and not lines[0].startswith("## "):
        if lines[0].strip():
            meta_lines.append(lines[0].strip())
        lines = lines[1:]

    sections: list[dict] = []
    current = None
    for line in lines:
        if line.startswith("## "):
            if current:
                sections.append(current)
            current = {"title": line[3:].strip(), "lines": []}
        elif current is not None:
            current["lines"].append(line)
    if current:
        sections.append(current)

    clean = []
    for s in sections:
        sid = re.sub(r"[^a-z0-9]+", "-", s["title"].lower()).strip("-")
        clean.append({"id": sid, "title": s["title"], "lines": s["lines"]})
    return title, meta_lines, clean


def parse_day(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    title, meta_lines, sections = split_sections(text)
    m = re.match(r"Day\s+(\d+)\s*[—–-]\s*(.+)", title)
    num = int(m.group(1)) if m else int(re.search(r"(\d+)", path.stem).group(1))
    day_title = m.group(2).strip() if m else title
    phase, phase_desc = phase_for(num)

    # badges from the metadata block: "Phase: ... · Week 1, day 3 · Study slot: Monday"
    badges: list[str] = []
    if meta_lines:
        for part in meta_lines[0].split("·"):
            part = part.strip()
            if part:
                badges.append(re.sub(r"\*\*", "", part))

    slot = ""
    for b in badges:
        if "Study slot" in b:
            slot = b.split(":", 1)[-1].strip()

    rendered = []
    for idx, s in enumerate(sections):
        rendered.append(
            {
                "id": s["id"],
                "title": s["title"],
                "html": render_blocks(s["lines"], id_prefix=f"d{num:02d}-s{idx}-"),
            }
        )

    return {
        "n": num,
        "title": day_title,
        "phase": phase,
        "phaseDesc": phase_desc,
        "slot": slot,
        "badges": badges,
        "metaHtml": render_blocks([item for line in meta_lines[1:] for item in (line, "")]),
        "sections": rendered,
    }


def parse_doc(path: Path) -> dict:
    title, _meta, sections = split_sections(path.read_text(encoding="utf-8"))
    rendered = []
    for idx, s in enumerate(sections):
        rendered.append(
            {
                "id": s["id"],
                "title": s["title"],
                "html": render_blocks(s["lines"], id_prefix=f"doc{idx}-"),
            }
        )
    return {"title": title, "sections": rendered}


# ---------------------------------------------------------------- markdown doc
def build_document(meta_text: str, days: list[dict], appendix_text: str) -> str:
    parts = [meta_text.rstrip(), "", "---", "", "## Contents", ""]
    for d in days:
        parts.append(f"- [Day {d['n']} — {d['title']}](#day-{d['n']}--{slug(d['title'])})")
    parts += ["- [Appendix](#appendix)", "", "---", ""]

    for d in days:
        body = re.sub(r"^#\s+.*\n", "", d["_raw"].strip(), count=1)
        parts += [f'<a id="day-{d["n"]}"></a>', "", f"# Day {d['n']} — {d['title']}", ""]
        parts += [body.strip(), "", "---", ""]

    parts += ['<a id="appendix"></a>', "", appendix_text.strip(), ""]
    return "\n".join(parts) + "\n"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")



# ---------------------------------------------------------------- single-file HTML
HTML_COVER = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>The Phone-Only Graphic Design Course · 15 days</title>
<style>
{css}
:root {{ --maxw: 820px; }}
.cover {{ padding: 12vh 0 6vh; border-bottom: 1px solid var(--line); margin-bottom: 10px; }}
.cover h1 {{ font-size: clamp(34px, 7vw, 56px); }}
.cover .sub {{ font-size: 18px; color: var(--ink-soft); max-width: 34em; }}
.cover dl {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 14px; margin: 28px 0 0; }}
.cover dt {{ font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }}
.cover dd {{ margin: 2px 0 0; font-family: var(--serif); font-size: 22px; }}
.toc {{ columns: 2; column-gap: 28px; font-size: 14.5px; padding-left: 0; list-style: none; }}
.toc li {{ margin: 0 0 7px; break-inside: avoid; }}
.toc a {{ text-decoration: none; color: var(--ink-soft); }}
.day-block {{ page-break-before: always; break-before: page; }}
@media print {{
  .cover {{ padding: 0 0 24px; }}
  .toc {{ columns: 2; }}
  .day-block h1 {{ page-break-before: avoid; }}
  .day-block {{ page-break-before: always; }}
}}
@media (max-width: 560px) {{ .toc {{ columns: 1; }} }}
</style>
</head>
<body>
<main class="content">
<section class="cover">
<p class="eyebrow">A fifteen-day, phone-only course</p>
<h1>Graphic design, from zero to portfolio</h1>
<p class="sub">From complete beginner to portfolio-ready in 15 study days — 2 h 30 m a day, Saturday to Wednesday, with Thursday and Friday off. Every day has practice, questions, a client scenario and research to carry into the next day.</p>
<dl>
<dt>Study days</dt><dd>15</dd>
<dt>Daily session</dt><dd>2 h 30 m</dd>
<dt>Equipment</dt><dd>Phone only</dd>
<dt>Cost</dt><dd>Free tools</dd>
</dl>
</section>
<section id="contents">
<h2>Contents</h2>
<ol class="toc">
{toc}
</ol>
</section>
{meta}
{days}
{appendix}
</main>
</body>
</html>
"""


def build_html(days: list[dict], meta: dict, appendix: dict) -> str:
    css = (ROOT / "site" / "styles.css").read_text(encoding="utf-8")

    def section_html(s: dict) -> str:
        return f'<section id="{s["id"]}"><h2>{s["title"]}</h2>{s["html"]}</section>'

    toc = "".join(
        f'<li><a href="#day-{d["n"]}">Day {d["n"]} — {html.escape(d["title"])}</a></li>' for d in days
    )
    toc += '<li><a href="#appendix">Appendix — templates, specs and reference</a></li>'

    meta_html = "".join(section_html(s) for s in meta.get("sections", []))
    day_html = "".join(
        f'<article class="day-block" id="day-{d["n"]}">'
        f'<p class="eyebrow">Day {d["n"]} of {len(days)} · {html.escape(d["phase"])}</p>'
        f'<h1>{html.escape(d["title"])}</h1>{d["metaHtml"]}'
        + "".join(section_html(s) for s in d["sections"])
        + "</article>"
        for d in days
    )
    appendix_html = (
        f'<article class="day-block" id="appendix"><p class="eyebrow">Reference</p>'
        f'<h1>{html.escape(appendix.get("title", "Appendix"))}</h1>'
        + "".join(section_html(s) for s in appendix.get("sections", []))
        + "</article>"
    )

    return HTML_COVER.format(
        css=css, toc=toc, meta=meta_html, days=day_html, appendix=appendix_html
    )


def main() -> int:
    day_files = sorted(DAYS_DIR.glob("day-*.md"))
    if not day_files:
        print("No day files found in", DAYS_DIR, file=sys.stderr)
        return 1

    days = []
    for path in day_files:
        d = parse_day(path)
        d["_raw"] = path.read_text(encoding="utf-8")
        days.append(d)
    days.sort(key=lambda x: x["n"])

    missing = sorted(set(range(1, 16)) - {d["n"] for d in days})
    if missing:
        print(f"NOTE: days not written yet: {missing}")

    meta_path = ROOT / "meta.md"
    appendix_path = ROOT / "appendix.md"
    meta_text = meta_path.read_text(encoding="utf-8") if meta_path.exists() else ""
    appendix_text = appendix_path.read_text(encoding="utf-8") if appendix_path.exists() else ""

    doc = build_document(meta_text, days, appendix_text)
    (ROOT / "GRAPHIC-DESIGN-COURSE.md").write_text(doc, encoding="utf-8")

    payload = {
        "meta": parse_doc(meta_path) if meta_path.exists() else {"title": "", "sections": []},
        "days": [{k: v for k, v in d.items() if not k.startswith("_")} for d in days],
        "appendix": parse_doc(appendix_path)
        if appendix_path.exists()
        else {"title": "Appendix", "sections": []},
        "generated": True,
    }

    site = ROOT / "site"
    site.mkdir(exist_ok=True)
    js = "window.COURSE = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    (site / "data.js").write_text(js, encoding="utf-8")

    html_doc = build_html(
        days,
        parse_doc(meta_path) if meta_path.exists() else {"sections": []},
        parse_doc(appendix_path) if appendix_path.exists() else {"sections": []},
    )
    (ROOT / "GRAPHIC-DESIGN-COURSE.html").write_text(html_doc, encoding="utf-8")

    words = len(re.sub(r"```.*?```", "", doc, flags=re.S).split())
    print(f"Built {len(days)} days · {words:,} words · document + site/data.js")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
