# Edit UX Reference (DSP series)

Canonical model for the **Discard / Save / Publish** triplet across every
product-edit surface in Nexus. Locks in label semantics, scope rules,
dirty-state visibility, and navigation-guard behavior so an operator who
learns one surface (e.g. the multi-tab product editor) instantly knows
how to work in another (flat-files, datasheet, list wizard).

Written 2026-05-23 as the design freeze for the DSP-series engagement
(DSP.0–DSP.9). If any surface diverges from this spec, the spec is the
canonical source — fix the surface, not the doc.

## The three buttons

| Button | Verb | What it does | When it appears |
|--------|------|--------------|-----------------|
| **Save** | persist | Writes ALL dirty changes across ALL tabs in one atomic call. Does NOT publish. | Page header, sticky. Disabled when no dirty state anywhere on page. |
| **Discard** | undo | Drops ALL dirty changes across the scopes the operator confirms in a modal. Reloads server state. | Page header, sticky. Disabled when no dirty state. Modal confirms scope. |
| **Publish** | broadcast | First runs Save (if dirty), then pushes the persisted state to one or more channels. Atomic: never publishes stale data. | Per-tab or sticky action bar, depending on surface. |

No synonyms allowed:
- ❌ Save Changes, Update, Apply, Submit, Push → ✅ **Save**
- ❌ Cancel, Revert, Reset, Undo → ✅ **Discard**
- ❌ Publish to X, Sync, Push to X → ✅ **Publish to X** (channel name is the only allowed variant)

The only surface allowed to use **Submit** instead of **Save** is the
list-wizard's final step (where the wizard's entire payload submits a
job, distinct from saving wizard progress).

## Scope rules

Every dirty change belongs to exactly one of these scopes:

- **field** — a single input on a single tab
- **tab** — all fields on one tab (a tab is dirty when ≥1 field is dirty)
- **page** — all tabs on the page (a page is dirty when ≥1 tab is dirty)
- **row** — a single grid row (flat-files only)

Buttons declare their scope in their label when the scope is anything
other than "page":
- Header Save → "Save" (page scope is implicit; the only buttons in
  the page header)
- Header Discard → "Discard" (same; modal then enumerates which tabs
  will lose changes)
- Per-tab buttons (Images tab's local action bar) → "Discard image
  changes", "Save & Publish images to Amazon"
- Per-row buttons (flat-file grid) → "Discard row", "Save row"

## Dirty-state visibility

The operator MUST be able to tell what's dirty at a glance, from any
scope:

| Level | Indicator |
|-------|-----------|
| Field | Border/background color shift (orange-tinted) + tooltip |
| Tab | Dot (•) appended to the tab label in the tab strip |
| Page | Header Save/Discard buttons enabled + count badge ("Save (3 changes)") |
| Row (flat-file) | Row background tinted + per-row "dirty" pill |

Hidden auto-save is forbidden. If a value persists automatically (e.g.
the Channel Listing auto-publish toggle), it MUST show a brief inline
"Saved" flash + a tooltip explaining the immediate-save behavior. This
is the only exception to the explicit-Save rule, and only allowed for
single-checkbox-or-toggle controls — never multi-field forms.

## Publish always pre-saves

This is the single most important rule. **No Publish button may push
stale data to a channel.** Implementation:

```
async function publish(channels: ChannelId[]) {
  if (dirtyRegistry.hasAny()) {
    await saveAll() // throws on failure, blocks publish
  }
  await publishToChannels(channels)
}
```

Failure modes:
- `saveAll()` throws → surface the error, do NOT publish
- `publishToChannels()` throws → server-side data is saved; publish
  retry is the operator's next click

Confirmation modal before publish, listing what will go where:

> Publish to: Amazon IT, DE, FR
> Includes 4 image changes, 2 title edits, 1 price update.
> [Cancel] [Publish]

Skipped only when scope is unambiguous (single channel + zero
cross-tab dirty state) and the action is reversible at the channel
side (e.g. a content-only update to a draft listing).

## Discard always asks scope

Discard is destructive. Single-scope discards (e.g. one tab) skip the
modal IF the dirty registry has only that scope. When multiple scopes
are dirty, the modal lists them:

> Discard changes to:
>   • Master Data (3 fields)
>   • Images (2 channel sets)
>   • Channel Listing — Amazon IT (1 field)
> [Cancel] [Discard all]

Never silently discard a scope the operator didn't see in the modal.

## Navigation guard

The operator may navigate via:
- Browser tab close / refresh / back → `beforeunload`
- In-app link click (Next.js client routing) → router event
- Tab switch within the same page → no guard (in-page state preserved)

Guard fires ONLY when `dirtyRegistry.hasAny() === true`. Auto-saved
state never triggers (because nothing auto-saves under this spec —
exception: the explicit toggle controls, which save instantly so
there's nothing dirty by definition).

Guard message: "You have unsaved changes on N tab(s). Leave anyway?"

## Keyboard shortcuts (DSP.9)

Globally registered on any page that exposes the header Save:

| Shortcut | Action |
|----------|--------|
| `Cmd+S` / `Ctrl+S` | Save All (page scope) |
| `Cmd+Shift+S` / `Ctrl+Shift+S` | Save & Publish (uses default channel; opens chooser if no default) |
| `Esc` | Discard (with scope-aware confirm) |

Browser default `Cmd+S` (save page) is suppressed via
`event.preventDefault()`.

## Per-surface checklist

Each surface in scope must satisfy:

- [ ] Header has Save + Discard buttons matching this spec
- [ ] Every dirty change registers with the page-wide dirty registry
- [ ] Tab labels show dirty dots
- [ ] Publish buttons pre-save the full dirty set
- [ ] Discard prompts scope when >1 scope is dirty
- [ ] Navigation guard fires only on real unsaved state
- [ ] Auto-saved single-toggle controls show inline "Saved" feedback
- [ ] Keyboard shortcuts work
- [ ] i18n catalog has en + it entries for every label
- [ ] All buttons have aria-labels matching their semantic action
- [ ] WCAG AA contrast on dirty-state indicators

Surfaces in scope (DSP.1–DSP.9 will sweep these):

| Surface | DSP phase |
|---------|-----------|
| /products/[id]/edit (12-tab editor) | DSP.1–.6 |
| /products/amazon-flat-file | DSP.7 |
| /products/ebay-flat-file | DSP.7 |
| /products/[id]/datasheet | DSP.9 |
| /products/[id]/list-wizard | DSP.9 (rename "Save & Exit") |

## Anti-patterns (do not introduce)

1. **Implicit auto-save on multi-field forms.** Auto-save anywhere
   other than single-toggle controls violates the dirty-registry +
   navigation-guard invariants.
2. **Publish-without-save shortcut.** No "skip save" option, ever.
   The atomic guarantee is the contract.
3. **Discard that touches one scope without naming it.** Single-tab
   discard buttons must say "Discard X changes" (not just "Discard")
   when other scopes might also be dirty.
4. **Per-tab Save buttons that race with header Save.** Either the
   header owns Save (preferred) or the tab does — not both.
5. **Channel selection persisted in `localStorage` globally.** Channel
   choice on the Images split-button must be per-product (DSP.6 fix).
6. **Submit/Push without auto-save.** Amazon flat-file Submit
   currently submits the last-saved version, ignoring in-memory
   edits. DSP.7 closes this.
7. **Synonym sprawl.** Save Changes, Update, Apply, etc. — pick Save
   and stay there. Same for Discard / Publish.

## Implementation order (already approved)

DSP.0 (this doc) → DSP.1 (registry + per-tab dots) → DSP.2 (Master
Data conversion) → DSP.3 (Discard modal) → DSP.4 (Publish pre-save)
→ DSP.5 (Channel Listing cleanup) → DSP.6 (Images split-button) →
DSP.7 (flat-file harmonization) → DSP.8 (nav guard refinement) →
DSP.9 (polish: labels, i18n, a11y, datasheet, wizard, shortcuts).
