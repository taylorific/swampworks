---
name: slide-fit
description: >
  Run a slide fit pass on a Slidev deck with the @taylor/slidev extension:
  find slides whose content runs off the bottom or right edge, bumps against
  the bottom, or scrolls inside a code block or table, then fix them without
  shrinking text and re-check until every slide fits. Use when asked to do a
  "slide fit" or "fit pass", when a slide "doesn't fit on one slide",
  "overflows", "is too big", "bumps against the bottom", or to "check the
  rendering of the slides" or "spin through the deck".
---

# Slide fit pass

Measures every slide in the deck's own container (no Node on the host) and fixes
what doesn't fit. Run commands from the swamp repository that has a
`@taylor/slidev/deck` model for the deck; if there is none, create one:

```sh
swamp model create @taylor/slidev/deck <name> --global-arg dir=/path/to/deck
# Apple's container CLI instead of Docker: --global-arg runtime=container
```

## 1. Measure

```sh
swamp model method run <name> fit --input shotsDir=<scratchpad>/fit-shots --json
swamp data query 'modelName == "<name>" && name == "fit"' --select content --json
```

Each flagged slide has `no`, `title`, `file` and `line` (where its source
starts, relative to the deck), `problems` and measurements in slide pixels:

- `bottom`: the content reaches within `bottomMargin` (40) of `height` (552 for
  16:9). `bottomEl` names the lowest element. Content close to the bottom
  counts: the user treats "bumping against the bottom" as not fitting.
- `right`: the content reaches past 960 of 980. `rightEl` names it.
- `scroll`: a code block or table scrolls inside itself, hiding content.

Open each flagged slide's screenshot (`<shotsDir>/slide-NNN.png`) before
editing: the numbers say where, the picture says why. If fit fails because the
deck has no playwright-chromium, say so and offer
`swamp model method run <name> upgrade --input playwright=true` (it changes
package.json; ask first).

## 2. Fix

Rules the user has set:

- **Never shrink text to make it fit.** No `text-sm`/`text-xs` classes, `zoom`,
  `transform: scale` or smaller code fonts. "Shrinking it makes it worse - less
  readable." Instead, in this order: cut words, tighten tables (shorter cells,
  fewer columns), wrap long code lines, move detail to speaker notes
  (`<!-- ... -->`), or **split the slide in two** with titles that say what each
  half covers.
- Keep `<v-click>` reveals and speaker notes. When splitting, keep the
  `routeAlias` on the slide that `<Link to="...">` references expect, and check
  for links to the moved content.
- A `<Link ... />` at the start of a line renders as its own paragraph; keep it
  on the same line as the text before it.
- No em-dashes in slide text. Don't leave a bare "it"/"this" without a clear
  referent, especially in titles and table headers.
- Fix every flagged slide, not only the worst one, and fix the same problem on
  neighbouring slides when you see it.

## 3. Re-check

Re-run `fit` with `--input slides=<the ones you changed>` until they pass. If
any slide was split, the numbers after it shift: finish with a full `fit` run
and confirm no slide is flagged.

## 4. Report

Tell the user which slides were flagged and what you did to each (cut, split,
moved to notes), show `git diff --stat`, and leave committing to them.
