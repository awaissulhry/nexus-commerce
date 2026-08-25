# DS gaps from Session 5 — a spec, not a list

Written 2026-08-25 by the Budget / Suggestions / AI session, for the DS session.

`.claude/DS-GAPS.md` is append-only capture: one line, written at the moment a conversion
stopped. That is the right shape for recording and the wrong shape for building from — it says
what was missing, not what to add. This file is the other half for the eight gaps that session
filed: the measurement, the call sites, the proposed API, and why each one cannot be worked
around from inside a route.

Ordered by leverage — sites affected × severity — not by the order they were found.

---

## 1. `--nds-text-disabled` is 2.04:1, and it is every `Input`'s placeholder

**One token. 59 fields. Below the 3:1 floor.**

```css
/* tokens/css-vars.ts */
--nds-text-disabled: var(--nds-grey-400);   /* #aeb6c2 → 2.04:1 on white */
```

`.nds-field > input::placeholder` uses it. Measured across the app: **440 `<Input>` call sites,
59 of which carry a `placeholder`.** A raw `<input>` with no declared placeholder colour inherits
the UA's `#757575` at **4.61:1**, so every conversion in this programme *lowers* it — the
alignment is actively making placeholders less legible, one field at a time.

**Why it cannot be fixed at a call site:** it is a token consumed by a DS selector. A route can
only beat it by re-declaring `::placeholder`, which is the hand-rolling the programme exists to
remove.

**Proposed:** separate the two meanings. `--nds-text-disabled` legitimately describes a
*disabled control's* text, where WCAG exempts it. A placeholder is not disabled text — it is the
field's only in-field hint. Add `--nds-text-placeholder` at **`--nds-grey-500` (#8a93a1, 3.10:1)
or darker**, and point `.nds-field > input::placeholder`, `.nds-textarea::placeholder` and
`.nds-taginput-field > input::placeholder` at it. `--nds-grey-600` would give 5.91:1 and match
what the console's own search fields used before conversion.

**Sibling, same shape:** `.nds-field .lead` is `--nds-text-3` (#8a93a1, **3.10:1**). Amazon's own
search glyph is `#565959` at 7.07:1, so converting a console search field halves its icon
contrast. Same fix, one tier darker.

---

## 2. `ToolbarButton` has exactly one engaged colour

**16 sites blocked. The 3 in `suggestions/` are the ones that matter.**

`.h10-sug-iconbtn` maps onto `variant="boxed"` perfectly — I converted six of them. The other
eight carry a *persistent staged state*, and the three states are three colours:

| state | measured | means |
|---|---|---|
| `.ok.on` | `#1f6fde` fill, 4.79:1 | staged to **apply** |
| `.no.on` | `#8a5316` fill, 6.31:1 | staged to **remove** |
| `.pz.on` | `#5b6573` fill, 5.91:1 | staged to **mute** |

`ToolbarButton`'s only engaged look is `aria-pressed`, which is blue for all three. An operator
scanning a staged queue before pressing Apply would lose the distinction between "about to
apply" and "about to remove" — on the screen where that distinction is the whole point.

`.rec-iconbtn.apply` is the same gap from the other side: a 28px round icon button with a
**primary fill** that performs a one-shot action. The only way to get a fill today is `active`,
which emits `aria-pressed` and would announce an apply as a toggle.

**Proposed:** `tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'` on
`ToolbarButton`, applying to the engaged state for a toggle and to the resting state when
`aria-pressed` is absent. That covers both shapes with one prop and reuses the tone vocabulary
`Button` already grew in `9caf08146`.

**Note on scope:** converting *some* of a control pair is worse than converting none —
`.rec-iconbtn.apply` sits directly beside a grey `.rec-iconbtn`, so a partial conversion leaves
one pair rendering in two shapes. That is why all three of those sites are still hand-rolled.

---

## 3. `SegmentedControl` cannot name its own radiogroup

**Blocks the best-behaved `-seg` spellings, which is the perverse part.**

```ts
export interface SegmentedControlProps {
  options; value; onChange; size?; disabled?; className?     // no aria-label, no rest spread
}
```

The component renders `<div role="radiogroup">` with no accessible name and no way to give it
one. There are **19 distinct `-seg` spellings** left in the app and **21 `<SegmentedControl>`
call sites** already converted — every one of those 21 is an unnamed radiogroup today.

The two sites I could not convert are `.bp-strat` ×2, which are among the very few hand-rolled
groups that already carry `aria-label="Allocation strategy"` **and** a per-option `title` blurb.
Converting them would trade an accessible name and three descriptions for arrow-key roving. So
the primitive is currently adoptable everywhere *except* where the markup was already correct.

**Proposed:** spread rest props onto the wrapper (which also gives `aria-labelledby`,
`data-*`, `id`), and add `description?: ReactNode` to `SegmentedOption` for the per-option
blurb — rendered as `title` at minimum, ideally as the tooltip `ToolbarButton` already has.

---

## 4. `SegmentedControl` drops out of the tab order when nothing is selected

**A real keyboard trap, and it is one line.**

```tsx
tabIndex={active ? 0 : -1}
```

Roving tabindex assumes exactly one option is always active. When `value` matches no option,
**every** segment is `-1` and the whole control is unreachable by Tab — clickable, but not
keyboard-operable.

This is not hypothetical. `.cp-statusbtns` (Strategy) binds
`staged?.biddingStrategy ?? settings?.biddingStrategy`, which is legitimately `undefined` for a
campaign with no recorded bidding strategy. As three plain `<button>`s it is reachable today, so
converting it would be a keyboard regression.

**Proposed:** when no option matches `value`, give the **first** option `tabIndex={0}` — the
standard roving-tabindex fallback. Two characters of logic, and it makes the primitive safe for
every optional-value group, which is most filter groups in the console.

---

## 5. `Input` has no invalid state

**1 site here; the pattern is everywhere.**

`.nds-field` has three size modifiers (`sm`, `xs` — both new today — and the default) and
exactly one *state* modifier: `disabled`. There is no `invalid` prop, no `aria-invalid` styling,
no error-border token hook.

`.h10-aig-money.err` turns its border red when a per-product budget falls below Amazon's
€1.00/day floor — the single condition that blocks a launch. Four money fields beside it
converted; that one could not, so one field in a row of five is still hand-rolled.

**Proposed:** `invalid?: boolean` on `Input`, `Textarea` and `Select`, emitting `aria-invalid`
and a `.nds-field.invalid` border from `--nds-danger-*`. The a11y half matters more than the
colour: today a converted field cannot tell a screen reader it is wrong.

---

## 6. `Input` has no trailing-action slot

**Filed independently by two sessions (`.pf-search`, `.h10-sug-buf`) — that is the signal.**

`suffix` renders a *shaded adornment*, not a control. A field that needs a clear `×`, a revert
`↺`, or a unit toggle has to hand-roll the whole wrapper, which is exactly what blocks adoption:
you cannot take the primitive for 90% of a field and hand-roll the last 10%.

`.h10-sug-buf` is a money cell with a `€` prefix **and** an inline revert button that appears
only when the staged value has been edited.

**Proposed:** `action?: ReactNode` rendered inside the field after the input, before `suffix`,
with the padding compensation `.lead` already does on the other side.

---

## 7. No soft tone for `success` / `danger`

**2 sites, one of which starts live Amazon writes.**

`9caf08146` added `success`, `warning`, `tonal`, `danger-outline` — which closed my
`.bp-btn.warn` gap outright, and I converted it the same day at 5.66:1 → 5.69:1. Thank you.

It does not cover `.bp-toggle`, which needs the **soft** form of three tones simultaneously:

| state | measured | |
|---|---|---|
| `on` | `#067d62` on `#e6f4ef` | pool active |
| `dry` | amber soft | dry-run |
| `live` | `#b42318` on `#fdeaea` | **writes to Amazon** |

`success` and `danger` are solid fills; `danger-outline` is white; `tonal` is a single fixed
tone. Three states, and no variant expresses any of them softly.

**Proposed:** `tone` + `emphasis: 'solid' | 'soft' | 'outline'`, rather than continuing to add
one variant name per combination. `ButtonVariant` is already at **ten** — `primary`,
`secondary`, `ghost`, `danger`, `link`, `quiet`, `success`, `warning`, `tonal`,
`danger-outline` — and `danger` / `danger-outline` is the combinatorial explosion showing its
first seam. Adding `success-soft` and `danger-soft` makes twelve; the axes make six.

---

## 8. No inline link that inherits its colour

**1 site here, but `useToast` appears in 416 files.**

`inline` (from `fb06a565f`) closed the padding half of the `.lnk` gap — good. The colour half is
open: `link` is `--nds-text-link`, which is fine on white and wrong on an inverted surface.

`.rec-undo` sits inside a `Toast`, whose ground is `--nds-text`. Measured:

- `Button variant="link" inline` → **3.22:1**
- the `color: inherit` the class uses today → **15.48:1**

**Proposed:** either a `tone="inherit"` on `Button`, or — better — have `.nds-toast` set a
`--nds-text-link` override for its own subtree, so every DS link inside any inverted surface
adapts without the call site knowing. The second is more in keeping with how this DS handles
dark mode already (pure token substitution).

---

## What I would do first

If only one of these lands, **make it #1.** It is a single token, it is below the accessibility
floor, it affects 59 live fields today, and every further conversion in this programme makes it
worse. #4 is second: two characters, and it removes a keyboard trap from a primitive that 21
call sites already use.

---

## Measurement method, so these numbers can be re-checked

Every figure above came from an isolated probe: the five root-layout stylesheets loaded in the
root layout's order, then the page's own sheet, with the git-HEAD markup selector-scoped
alongside the converted markup, measured with `getComputedStyle` and a WCAG contrast function in
the page. Contrast on an `opacity`-based disabled state was computed by compositing, because
`getComputedStyle` reports the pre-opacity colour and will tell you 4.79:1 where the eye sees
2.06:1.

Specificity claims were tested, not asserted: each probe carried a control bay rendering the
DS-classed control inside the suspect ancestor, beside the same control outside it. That is what
proved `.az-pager .nav button` renders a `nds-tbtn boxed` byte-identically to a plain `<button>`.
