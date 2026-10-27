# Day 13 — UX/UI: designing screens that make sense

**Phase:** Advanced · **Week 3, day 13** · **Study slot:** Monday
**Time:** 2 h 30 m · **Tools today:** Figma (browser + mobile app), Canva
**You need:** your capstone brand assets, and one app you use every day

## Why this matters

The highest-paid design work available to a self-taught designer right now is product work — apps, websites, booking flows, dashboards. And the barrier is lower than people think: the core skill is not software, it's **thinking in flows, states and constraints** rather than in single images.

Today you'll design one screen properly: a wireframe first, then a high-fidelity version, with real content, correct touch targets, empty and error states, and a prototype someone can tap. That's enough to get a first paid job fixing someone's booking screen. It's also the day that makes all your poster skills suddenly seem small — screens have to *work*, not just look right.

## By the end of today you can

- Explain UX vs UI and identify which problem you're actually solving.
- Map a short user flow with decisions and dead ends.
- Build a low-fidelity wireframe before any colour or type.
- Design a screen with a spacing system, a type scale and correct touch targets.
- Cover the states most beginners forget: empty, loading, error, success, long-content.

## Today's plan

| Minutes | Block | Today's activity | Output |
| --- | --- | --- | --- |
| 0–10 | Recall | Carousel structure, three motion principles | Log entry |
| 10–20 | Frame | Read objectives; write your goal | Goal line |
| 20–70 | Lesson + try-its | Read; test three apps for affordances | Three notes |
| 70–85 | Break | Screen off | — |
| 85–130 | Guided practice | Flow, wireframe, hi-fi screen | One screen + states |
| 130–145 | Scenario | The salon booking screen | Flow + screen + prototype |
| 145–150 | Log and save | Export frames, link prototype | `03-Final` |

## Lesson

### 1. UX and UI are different jobs

**UX** is the structure: what the user is trying to do, in what order, with what information, and what happens when things go wrong. **UI** is the surface: type, colour, spacing, components, iconography.

A beautiful screen that hides the "confirm" button behind a scroll is a UI success and a UX failure. Most local "app design" work is UI work sitting on top of unexamined UX — which is why it looks modern and still frustrates people. Learn to ask the UX questions first:

1. What is the one thing the user came here to do?
2. What do they need to know *at this moment* to do it?
3. What happens if they make a mistake?
4. What if there's no data yet? No connection? Too much data?

### 2. Flows before screens

Draw the flow as boxes and arrows — on paper, in your notes app, anywhere:

```
Entry (notification) → Home → [Service list] → Choose time → Confirm → Success
                                     ↓
                              Empty state (no slots)
                                     ↓
                              Alternative times / call us
```

Every decision point needs both outcomes drawn. Every failure needs a route out. A flow with no dead-end handling is a flow that confuses real users. Five minutes of boxes saves an hour of redesigning a screen that can't hold the content.

### 3. Wireframes: grey boxes, no opinions

A wireframe is grey rectangles, placeholder text, and real structure. Its purpose is to settle *layout and priority* before aesthetics can distract anyone — including you.

Rules:
- **Grey only.** No brand colour. Colour makes people discuss taste instead of structure.
- **Real content lengths.** Use the actual longest service name, the real price format, the real number of items. Fake short text hides the problems.
- **Label the components**, not the copy: "primary button", "list item", "price". You're designing a system.
- **One screen at a time**, at 390 × 844 px (a common phone frame). Design mobile-first; a desktop layout is a re-arrangement, not a starting point.

### 4. The four numbers of a usable screen

1. **Touch target:** minimum 44 × 44 px (Apple) / 48 × 48 dp (Android). If it's tappable, it's at least that big — including icon buttons and close crosses.
2. **Spacing system:** pick a base unit (8 px) and use multiples: 8, 16, 24, 32, 48. No arbitrary 13 px gaps. Consistency in spacing is what makes a screen feel "designed" more than any colour choice.
3. **Type scale for screens:** e.g. 28/22/17/15/13 px with line heights 1.2/1.3/1.4/1.5/1.4. Body never below 15 px on mobile; supporting text never below 13 px.
4. **Safe areas:** 16–20 px side margins on a 390 px screen; respect the notch and the home indicator; keep primary actions within thumb reach (the bottom third for one-handed use).

### 5. States: where amateur screens collapse

Design these five for any interactive element, and your screen will look more professional than 90% of dribbble shots:

| State | What it is | Why it matters |
| --- | --- | --- |
| **Default** | The normal state | The one everyone designs |
| **Empty** | No data yet (no bookings, no results) | The first thing a new user sees; usually missing |
| **Loading** | Waiting, with feedback | Without it, people tap again and double-book |
| **Error** | Something failed, and what to do next | Should say what happened and offer the next action |
| **Success** | Confirmation | The moment trust is built |

Also design for: long text (a service name twice as long as expected), no connection, and a returning user (what's different).

### 6. Components, not screens

A screen is made of a small set of components: header, card, list item, button (primary/secondary/disabled), input, chip, tab bar, modal, empty-state block. Design each one properly *once* — with all its states — then assemble screens from them. This is what makes a design look like a product rather than a picture, and it's what a developer needs from you.

In Figma, use **Components** and **Auto layout** if you can; on a phone browser it's fiddly but workable if you keep the screen small and zoom in. Canva is a legitimate fallback for a single hi-fi screen — just build the components as separate grouped elements so they stay consistent.

### 7. Accessibility is not optional

- Contrast 4.5:1 for body text, 3:1 for large text and icons.
- Never convey meaning by colour alone (a red dot for "closed" needs a word or icon too).
- Labels above inputs, not placeholder-only — placeholders vanish as soon as someone types.
- Tap targets at least 44 px, with 8 px between adjacent targets.
- Support larger text: if your layout breaks when the font grows 30%, it's too tight.

> **Try it (5 min):** open your most-used app and find one screen where you have to think before tapping. Write down what the screen should have told you. That sentence is the beginning of a UX career.

## Guided practice

1. **(10 min) Flow on paper.** One user goal, five or six boxes, every decision with two arrows, every failure with a route out. Photograph it.
2. **(10 min) Wireframe.** 390 × 844 grey boxes in Figma (or Canva). Real content lengths, labelled components, nothing decorative. This should look boring; that's correct.
3. **(10 min) Spacing system.** Define your base unit and list the values you'll use. Set the side margins. Then check every element sits on the grid.
4. **(15 min) Hi-fi screen.** Apply your brand: colour, type scale, one accent, one image. Keep the structure from the wireframe — if the layout changed, ask why.
5. **(15 min) States.** Design the empty state, the loading state, and one error state for the same screen. Group them as a set.
6. **(10 min) Audit.** Check touch targets, contrast, and the longest text. Fix and note what you changed.

## Practical questions

1. Give an example of a UI success that is a UX failure, and explain the difference in one sentence.
2. Why do wireframes avoid colour and brand type?
3. What is a touch target, and what's the minimum size — and why does that number exist?
4. Name the five states every interactive screen needs, and explain why the empty state is usually the most important.
5. Why is an 8-point spacing system better than choosing each gap by eye?
6. A client asks you to "make the app look nicer". What do you ask before touching colour?

## Scenario

**The salon booking screen.** A salon takes bookings by phone. They want an app screen where a client can book a service. Real constraints from the owner:

- Six services, one of which ("Bridal package — hair, makeup and nails") has a very long name and a price range, not a price.
- Three stylists, but only two work on Sundays.
- Some slots are unavailable, and the owner wants to show *why* ("fully booked" vs "stylist off").
- Deposits are paid by mobile money, which sometimes fails.
- Many clients are first-timers and won't know which service they need.

Produce:

- The **flow**, including the failure routes (no slots, deposit failed, service not available that day).
- A **wireframe** at 390 × 844.
- A **hi-fi screen** for "choose a service", including the long service name and the price range handled honestly.
- **Three states**: no availability for the chosen day, payment failed, booking confirmed.
- A short note on how a first-timer is helped to choose (the "not sure?" route) — this is the UX the owner actually needs and didn't ask for.

If you can, link the screens into a tappable prototype in Figma and record a 20-second screen capture of yourself using it.

## Deliverable

- [ ] Flow diagram (photographed)
- [ ] Wireframe with labelled components
- [ ] Written spacing system and type scale
- [ ] Hi-fi screen for your capstone (or the salon)
- [ ] Empty, loading and error states
- [ ] Audit notes: touch targets, contrast, longest text
- [ ] Salon flow + wireframe + hi-fi + three states + first-timer note
- [ ] Prototype link or screen recording, if Figma allowed it

## Answers and self-marking

1. Example: a checkout screen with a gorgeous gradient, elegant type, and a "Place order" button that sits below the fold, so users scroll past it. UI: the surface is well crafted. UX: the single most important action isn't visible at the moment of decision. One sentence: UI is how it looks, UX is whether the person can accomplish what they came for.
2. Because colour and type invite aesthetic opinions before structure is agreed, and they hide layout problems (a busy background can disguise weak grouping). Grey boxes force the conversation onto hierarchy, grouping and flow — the decisions that are expensive to change later. Style is cheap to apply afterwards; structure is not.
3. The physical area a finger must hit to activate something. Minimum 44 × 44 px on iOS, 48 × 48 dp on Android. The number exists because a fingertip's contact patch is roughly 9–10 mm, and a smaller target produces mis-taps — especially for people with larger fingers, tremor, or using the phone one-handed while walking.
4. Default, empty, loading, error, success. The empty state matters most because every new user meets it first: with no bookings, no results, no history, the screen is at its least informative — and that's the moment a person decides whether the product is any good. A blank screen with no explanation reads as broken.
5. Because consistency in spacing is what the eye reads as quality, and because an arbitrary value creates near-misses (13 px next to 16 px looks wrong but is hard to name). A base unit plus multiples produces rhythm, makes handoff to a developer unambiguous, and speeds up decisions — you choose from a small set instead of inventing a number each time.
6. Before colour: what is the user trying to do on this screen, and what isn't working now? Then: what content must be visible at the moment of decision, what happens on error, what the empty state says, and what the primary action is. "Nicer" is usually a symptom of unclear hierarchy or too many competing elements, not a palette problem.

## Research for tomorrow

- **Client work fundamentals:** writing a proposal, scoping, milestones, revision limits, and what a contract must contain.
- **Pricing models:** hourly, fixed project, value-based, and retainers — and when each is appropriate.
- **Giving and receiving feedback:** how to run a design review, and how to respond to "I don't like it" without losing the client or your position.
- **Presentations:** how to present three concepts, and why you should always recommend one.
- **Handover packages:** what files, formats and documentation a client should receive.
- **Invoicing and deposits:** standard practice for deposits, late payment, and kill fees.
- Look up what designers charge in your city (ask three, or search local groups). You'll price your capstone tomorrow.

## Short on time

Do exercises 1, 2, 4 and the salon's three states (about 65 min). Skip the audit and the prototype. Flow, wireframe, one hi-fi screen and one empty state is a complete day.

## Extra resources

- Figma's own "Figma basics" playlist (watch at 1.5×).
- Search: "mobile UI spacing system", "empty state examples", "mobile touch target size".
- Refactoring UI (refactoringui.com) — the best practical UI book; the free articles alone are worth the day.
- Book: *Don't Make Me Think*, Steve Krug — short, and the whole discipline in one evening.
