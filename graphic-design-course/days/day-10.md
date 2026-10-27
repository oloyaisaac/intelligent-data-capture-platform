# Day 10 — Layout at scale and print production

**Phase:** Craft · **Week 2, day 10** · **Study slot:** Wednesday
**Time:** 2 h 30 m · **Tools today:** Canva (print sizes + PDF export), your brand sheet
**You need:** your capstone identity from Day 9, and one print shop you can call or visit

## Why this matters

Print is where design gets judged in the real world. A screen design can be a little off and nobody notices; a printed flyer with text 2 mm from the edge, soft photos and a bleedy background comes back from the printer looking cheap — and you paid for 500 of them. Knowing print specs is the difference between a designer a print shop respects and one they quietly correct.

Today is also the last "craft" day. Tomorrow you move from making single pieces to directing a campaign, which is a different job.

## By the end of today you can

- Set up a print document with the correct trim, bleed, safe area and resolution.
- Explain CMYK, spot colour and why screen colour and print colour differ.
- Choose paper weight and finish for a given job, and justify the cost.
- Produce a genuinely print-ready PDF and describe it to a printer without mumbling.
- Adapt one design across print and social without just scaling it.

## Today's plan

| Minutes | Block | Today's activity | Output |
| --- | --- | --- | --- |
| 0–10 | Recall | Clear space, minimum size, colour roles | Log entry |
| 10–20 | Frame | Read objectives; write your goal | Goal line |
| 20–70 | Lesson + try-its | Read; set up one print file correctly | Correct A4 setup |
| 70–85 | Break | Screen off | — |
| 85–130 | Guided practice | Six exercises toward a print-ready flyer | Flyer 90% |
| 130–145 | Scenario | The 2-metre banner on a phone | Banner + spec note |
| 145–150 | Log and save | Export PDF Print + social versions | `03-Final` |

## Lesson

### 1. The six numbers of a print file

| Term | What it means | Set it to |
| --- | --- | --- |
| **Trim size** | The final cut size | A4 = 210 × 297 mm, A5 = 148 × 210 mm, business card = 85 × 55 mm |
| **Bleed** | Artwork that extends past the trim so mis-cuts don't show white edges | 3 mm on all four sides |
| **Safe area** | Keep text and logos away from the cut | 5 mm inside the trim (10 mm for comfort) |
| **Resolution** | Detail at final size | 300 dpi for photos at 100% scale |
| **Colour mode** | How ink is described | CMYK for print; RGB for screen |
| **Marks** | Crop marks and registration | Included in a "PDF Print" export |

If you remember nothing else: **backgrounds must bleed, text must not.**

In Canva: turn on **File → Show print bleed** and **Show rulers and guides**. The bleed area appears as a hatched border — every background colour, photo or shape must extend into it. Then export **PDF Print**, which includes crop marks and bleed, rather than PNG, which does not.

### 2. Resolution, in plain arithmetic

Printed image quality depends on pixels *per inch at final size*. You can work it out:

```
required pixels = physical size in inches × 300
A4 full bleed (216 × 303 mm) at 300 dpi ≈ 2551 × 3579 px
A5 (154 × 216 mm) at 300 dpi          ≈ 1819 × 2551 px
2 m banner at 1:10 scale, 300 dpi      ≈ 2362 × 709 px  (i.e. 200 × 60 mm file)
```

For large formats, no one prints 2 metres at 300 dpi — it's viewed from metres away, so 100–150 dpi at full size is normal, and working at 1:10 scale at 300 dpi gives you that automatically. Practically: **flyers at 300 dpi, posters at 150 dpi, banners at 1:10 scale.**

If the client's photo is too small, don't silently upscale. Either use it small, ask for the original, or shoot a new one. Say which, in writing.

### 3. Colour: why the screen lies

- Screens emit light (RGB, additive). Paper reflects light off ink (CMYK, subtractive). They cannot match exactly.
- Saturated RGB blues, greens and neons are outside the CMYK gamut — they will print duller or shift.
- **Rich blacks:** pure black (C0 M0 Y0 K100) can look grey and thin on large areas. For big black areas, printers often use a rich black (e.g. C60 M40 Y40 K100) — ask your printer what they prefer.
- **Spot colour (Pantone)** is a pre-mixed ink. It's the only way to guarantee a brand colour, and it costs extra. Use it for brand-critical work at volume; skip it for a 100-piece flyer run.
- **Proofing:** for any run you're paying for, ask for a physical proof of one copy. It's cheap; a wrong run is not.

### 4. Paper: the cheapest quality upgrade

| Weight | Feels like | Use for |
| --- | --- | --- |
| 80–100 gsm | Photocopy paper, flimsy | Inserts, internal documents, cheap handouts |
| 130–170 gsm | Decent leaflet, holds a fold | Flyers, menus, leaflets (the sensible default) |
| 250–300 gsm | Card, substantial | Business cards, invitations, postcards, covers |
| 350 gsm+ | Board, premium | Luxury cards, packaging, covers |

Finish matters as much as weight: **matte/uncoated** feels warmer and takes writing, but colours look flatter; **gloss** makes photos pop but shows fingerprints and can look cheap if overused; **silk/satin** is the safe middle. If a client's budget allows one upgrade, it's paper weight, not more colours.

### 5. Designing for print on a phone, honestly

Do these and a phone file will pass at almost any print shop:

- Create the document at the **exact physical size** in Canva (A4, A5, banner at 1:10), never "resize later".
- Turn on bleed and guides **before** you place anything.
- Keep a **10 mm safe margin** for text instead of the minimum 5 mm — phone editing makes it easy to drift close to the edge.
- Check every photo's resolution by looking at its pixel dimensions, not by trusting the preview.
- View the design at **50% zoom** to see the whole page; phone zoom flatters everything.
- Export **PDF Print**, then reopen it and zoom to 100% to check for stray text and clipping.

> **Try it (5 min):** make an A4 document, set a background colour, turn on bleed, and see whether the colour actually fills the hatched area. Nine times out of ten it doesn't on the first attempt. Fix it now, not at the printer's counter.

### 6. Adapting, not scaling

The same message in three formats is three designs that share a system, not one design shrunk:

- **A4 poster (portrait):** vertical hierarchy, big type, image occupies the top or the background.
- **Square social (1:1):** tighter crop, larger type relative to the frame, fewer words.
- **Story (9:16):** one idea, huge type, text inside the central band, everything else pushed out.

Rebuild the layout on a new canvas using the same grid logic, palette and type scale. If you merely scale, the type becomes too small and the margins become wrong.

## Guided practice

1. **(10 min) Set up correctly.** New A4 print document. Guides at 3 mm bleed, 10 mm safe margin. Background fills the bleed. Screenshot the guides as proof.
2. **(10 min) Resolution audit.** Find the pixel dimensions of every photo you plan to use. Calculate the maximum print size at 300 dpi for each (pixels ÷ 300 = inches). Note which are unusable at A4.
3. **(15 min) Build the flyer.** Capstone brand: logo (correct lockup), headline, one supporting line, three pieces of information, a call to action, and one image or colour block. Use your three-size type scale.
4. **(10 min) The print proof check.** Export PDF Print. Reopen. Zoom to 100% and check: no text in the bleed, nothing closer than 5 mm to trim, no low-res images, no missing font substitution.
5. **(10 min) Adapt to social.** Rebuild the same content at 1080×1350 (4:5). Do not scale — re-lay it out. Screenshot both side by side and note three specific changes you made.
6. **(10 min) Spec sheet for the printer.** Write a five-line spec: size, quantity, paper weight and finish, colour (CMYK or 1-colour), and file format. This is what you'd send with the file.

## Practical questions

1. Why must a background bleed but text must not?
2. A client supplies a 1200 × 800 px photo for a full-bleed A4 poster. Show the arithmetic and give your recommendation.
3. What is the difference between CMYK and spot colour, and when is spot worth the cost?
4. The printer says your black "looks washed out" on a large area. What are the two likely causes?
5. Why is paper weight often a better investment than a fourth colour?
6. Why is a PDF Print export preferable to a PNG for a print job?

## Scenario

**The 2-metre banner on a phone.** A supermarket wants a banner for the front of the shop: 2 m wide × 0.6 m tall, printed on flex by a local sign-writer, viewed from 8–15 metres and in sunlight. The content: shop name, "FRESH PRODUCE DAILY", opening hours, and one phone number. They also want the same design as a Facebook cover and an A4 poster for the door.

Constraints: your phone, Canva, and a sign-writer who will print whatever you send him.

Produce:

- The banner at **1:10 scale (200 × 60 mm, 300 dpi)** with a note explaining why that's the correct approach and what the effective full-size resolution is.
- Type sized for **8–15 m viewing distance** — work it out: a rough rule is 2.5 cm of cap height per 3 m of viewing distance, so at 10 m you need roughly 8 cm letters, which at 1:10 scale is 8 mm on your file.
- A note on colour: why you chose high-contrast values rather than your brand's accent, and what happens to subtle mid-tones in direct sun.
- The A4 poster adaptation, and the Facebook cover (1640 × 624), re-laid out, not scaled.

Then write the **spec line you'd send the sign-writer** in one message: size, file, resolution, bleed allowance, colour, and the material.

## Deliverable

- [ ] Correct A4 print setup with visible guides and bleed (screenshot)
- [ ] Resolution audit with the arithmetic
- [ ] Print-ready A4 flyer for your capstone
- [ ] 4:5 social adaptation, re-laid out, with three changes noted
- [ ] Five-line printer spec sheet
- [ ] Banner at 1:10 + poster + cover adaptations with notes
- [ ] PDF Print exported and checked at 100%

## Answers and self-marking

1. Because of what the cut does. The guillotine is not perfectly accurate, so a background that ends exactly at the trim can leave a 1 mm white sliver — extending it 3 mm past the trim guarantees full coverage after cutting. Text, by contrast, must stay *inside* the safe area because anything near the edge risks being sliced through or feeling cramped. Backgrounds bleed; text retreats.
2. 1200 ÷ 300 = 4 inches ≈ 102 mm; 800 ÷ 300 = 2.7 inches ≈ 68 mm. So at 300 dpi it covers only about 102 × 68 mm — less than a quarter of A4. Options: request the original file (best); use it at a small size within the layout rather than full bleed; photograph a replacement; or, as a last resort, upscale and accept softness, but do not print it full-bleed at A4 and expect quality. State the arithmetic to the client — it ends the argument politely.
3. CMYK builds colour from four inks in tiny dots; spot colour is a single pre-mixed ink printed from its own plate. Spot guarantees an exact brand colour (e.g. a logo's red) and can include metallics or fluorescents that CMYK cannot reproduce. It's worth the cost when a brand colour is critical and the run is large enough to absorb setup cost, or when the colour is simply outside CMYK's range. For small runs, CMYK plus a proof is usually the right call.
4. (a) It's pure K100 on a large area, which reads thin and grey next to rich photographic blacks; printers often want a rich black (mixed CMYK) for large solids. (b) It's being viewed against a bright background, or the paper is uncoated and absorbing ink, flattening the density. Ask the printer their preferred rich-black build for the stock — they will have one.
5. Because paper is the thing the customer physically touches, and it signals quality before any design decision is noticed. A well-designed flyer on 170 gsm uncoated feels considered; the same design on 80 gsm photocopy paper feels like a handout. A fourth colour, by contrast, is often used to add noise, not clarity.
6. Because a PDF embeds fonts, preserves vector shapes and type as crisp edges rather than pixels, carries the correct physical dimensions and bleed box, and includes crop marks. A PNG is a fixed pixel grid: it can't tell the printer the trim size, it can't scale, and small text becomes soft at print resolution.

## Research for tomorrow

- **Art direction:** what a concept is, and how a mood board differs from a reference pile.
- **Campaign structure:** single-minded proposition, hero image, supporting images, and how three images tell one story.
- **Visual consistency:** how light, colour, framing, styling and props create a family of images.
- **Casting and props on a zero budget:** using real people, real places, and one strong prop instead of five.
- **Photographic storytelling:** sequencing, the establishing/detail/portrait trio, and how to direct a non-model.
- Watch one "art direction breakdown" video or read one case study of a small campaign. Note how many decisions were made *before* the shoot.

## Short on time

Do exercises 1, 3, 4 and the banner note (about 60 min). Skip the social adaptation and the spec sheet; the bleed, the resolution arithmetic and the print-ready export are the day's core.

## Extra resources

- Canva Design School: "Bleed, trim and safe area", "Print vs screen colour".
- Search: "PDF/X vs PDF print", "rich black vs 300% black", "gsm paper explained".
- Visit a print shop and ask to see offcuts of 130, 170 and 300 gsm stock. Ten minutes there is worth an hour of reading.
