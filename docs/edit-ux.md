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

---

## EH-series — Open-in-new-tab pattern (added 2026-05-24)

The `/products/[id]/edit` header exposes three secondary surfaces that
are now opened in a **new browser tab** rather than via `router.push`:

| Surface | URL | Reason for new tab |
|---------|-----|---------------------|
| Datasheet | `/products/[id]/datasheet` | 9-tab printable spec sheet; operator usually wants it open alongside the editor. |
| Flat File | `/products/amazon-flat-file?familyId=…&productType=…&marketplace=IT` | Workbench-style editor; in-place navigation would blow away unsaved /edit state. |
| Recover | `/products/[id]/recover` | Destructive recovery flow; reduces accidental data loss in the editor. |

Matrix is **not** included — the canonical Matrix surface is the
in-page tab on `/edit`. The dedicated `/products/[id]/matrix` route
still exists for direct links (Cmd+K, deep links from other apps) but
is not exposed from the editor header.

### Anchor markup contract (canonical)

```tsx
<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  title={t('products.edit.<surface>Tooltip')}
  onMouseEnter={headerPrefetch.onHover<Surface>}
  onFocus={headerPrefetch.onHover<Surface>}
  onClick={() => markNewTabClick('<surface>', productId)}
  onAuxClick={() => markNewTabClick('<surface>', productId)}
  className={headerOpenInNewTabClass}
>
  <SurfaceIcon className="w-3.5 h-3.5 mr-1.5" aria-hidden />
  {t('products.edit.<surface>')}
  <ExternalLink className="w-3 h-3 ml-1 opacity-60 group-hover:opacity-100 transition-opacity" aria-hidden />
  <span className="sr-only">{t('products.edit.opensInNewTab')}</span>
</a>
```

Required attributes:
- Real `<a>` element with `href` so Cmd+Click, middle-click, right-click "Open Link in New Tab" all work natively.
- `target="_blank"` + `rel="noopener noreferrer"` — opens new tab + strips `window.opener` + drops referrer.
- `<span className="sr-only">{opensInNewTab}</span>` — screen-reader hint, concatenated by accessible-name algorithm. Preferred over `aria-label` which would replace the visible text.
- `aria-hidden` on icon glyphs.
- `<ExternalLink className="w-3 h-3 ml-1 opacity-60 group-hover:opacity-100">` glyph signals new-tab intent visually. Requires `group` class on the parent anchor.
- `onMouseEnter` + `onFocus` both fire prefetch (covers mouse hover AND keyboard tab navigation).
- `onClick` + `onAuxClick` both mark for perf telemetry (covers left-click AND middle-click).

### Cache pre-warming (EH.4 + EH.7)

The new tab is a **fresh document** — no Next.js client-side route
prefetch applies. The only way to make it feel instant is to populate
the *backend* API caches before the click lands.

- **Mount-warm**: on `/edit` mount, `useHeaderPrefetch` fires `fetch(..., { priority: 'low' })` for the two slowest endpoints (`/health` for Recover, `/flat-file/template` for Flat File). Datasheet uses Prisma directly so there's no API surface to warm; Suspense streaming (EH.6) is what makes it feel fast.
- **Hover-warm**: on `onMouseEnter`/`onFocus`, the same endpoints are re-fired at normal priority — by the time the click lands the backend cache is hot.
- **Server-side cache**:
  - `/api/products/:id/health` — 30 s TTL, keyed by `${id}::${etag}` (auto-invalidates on any product mutation).
  - `/api/amazon/flat-file/template` — 5 min TTL keyed by `${marketplace}:${productType}`. `force=1` bypasses.

### Skeleton + Suspense (EH.2 + EH.6)

Each target route has a `loading.tsx` skeleton matching its real layout.
Datasheet additionally wraps the active-tab dispatch in `<Suspense key={tab} fallback={<TabSkeleton />}>` so the page shell streams first
and the tab body fills in second.

### Bundle code-splitting (EH.5)

Heavy client modals/panels in `AmazonFlatFileClient.tsx` are wrapped in
`next/dynamic` + `ssr: false` and gated with the `useOpenOnce` hook so:
- The chunk doesn't load until the operator first opens it (saves ~300-500 kB on initial Flat File load).
- Once opened, the component stays mounted on close so in-modal state survives.

Components currently split: `FindReplaceBar`, `ConditionalFormatBar`,
`FFFilterPanel`, `AIBulkModal`, `FFReplicateModal`, `PullDiffModal`,
`PullHistoryDrawer`, `KeyboardShortcutsModal`, `CascadeModal`,
`FlatFileAiPanel`.

### Observability (EH.8)

- API: `Server-Timing` headers on `/health`, `/inventory/:id`, `/flat-file/template` show `listEtag;dur=…`, `prisma;dur=…`, `cacheHit`/`cacheMiss` flags. Visible in DevTools → Network → Timing.
- Client: `markNewTabClick` writes a `localStorage` mark on click; `<NewTabClickPerf>` reads it on target-page mount, observes `first-contentful-paint`, computes the wall-clock delta, and logs `[EH] <surface> click→FCP: <N>ms` in development.

### Anti-patterns (do not introduce)

1. **`router.push` for secondary editor surfaces.** Use a new-tab anchor instead — preserves `/edit` context, allows side-by-side workflows.
2. **`onClick={() => window.open(url)}` on a `<button>`.** Pop-up blockers can intercept; loses Cmd+Click semantics. Always use a real `<a href target="_blank">`.
3. **`aria-label` overriding visible label for "new tab" hint.** Use `<span className="sr-only">` instead so the visible label is preserved in the accessible name.
4. **Server-Timing without a `description` for boolean flags.** `cacheHit` / `cacheMiss` are dur-less markers — that's fine, but if you add a per-request flag, make sure its name is self-explanatory or include a `desc`.

### Acceptance targets

| Path | Cold (no warm) | Warm (after mount-warm or hover-warm) |
|------|----------------|----------------------------------------|
| Skeleton paint | ≤ 50 ms | ≤ 50 ms |
| Content paint  | ≤ 500 ms | ≤ 200 ms |

The skeleton paint is bounded by Next.js streaming + the operator's
network; the content paint is bounded by the slowest of: backend
cache hit (~5 ms), Prisma queries (~50 ms), or SP-API schema fetch
(only on cache miss — mount-warm makes this rare).

---

## TC-series — Tab Consolidation + Customize Tabs (added 2026-05-24)

Two distinct improvements bundled under the **TC-** ("Tab
Consolidation") prefix:

1. **Merged Global into Master** — the legacy `Global` tab is gone;
   its Locales / Physical / Technical sections now live as
   collapsible cards inside `MasterDataTab`. Operators see one
   "Master" tab instead of two near-duplicates (Global + Master Data).
2. **Customize Tabs modal** — the binary `+ More tabs / Show less`
   toggle is replaced with a per-user visibility + drag-drop reorder
   modal. Defaults pin 8 tabs (Master, Images, Matrix, Analytics,
   Ads, Amazon, eBay, Shopify). Everything else is opt-in via the
   modal's checkboxes.

### Canonical tab catalog

Source of truth: `apps/web/src/app/products/[id]/edit/_shared/useTabPrefs.ts`'s
`CANONICAL_TABS` constant.

| Key | Label | Default visible | Notes |
|-----|-------|-----------------|-------|
| `master` | Master | ✓ | Identity + Content (Locales) + Physical + Status + Technical + Market Availability |
| `images` | Images | ✓ | |
| `matrix` | Matrix | ✓ | Renders body only when `product.isParent` |
| `analytics` | Analytics | ✓ | |
| `ads` | Ads | ✓ | |
| `AMAZON` | Amazon | ✓ | Only renders in strip when product has an Amazon listing |
| `EBAY` | eBay | ✓ | Same — only when product has an eBay listing |
| `SHOPIFY` | Shopify | ✓ | Same |
| `locales` | Locales | — | i18n key `products.edit.tab.locales` |
| `seo` | SEO | — | |
| `compliance` | Compliance | — | |
| `workflow` | Workflow | — | |
| `relations` | Relations | — | |
| `activity` | Timeline | — | Hardcoded label, no i18n key today |
| `WOOCOMMERCE` | WooCommerce | — | Channel — only renders in strip when listing exists |
| `ETSY` | Etsy | — | Same |

Channel tabs always carry their channel code as the key (uppercase).
Adding a new top-tab is a single-line addition to `CANONICAL_TABS`;
the reconciliation logic in `useTabPrefs` ensures returning operators
get the new tab at the end of their saved order as hidden, so
nobody's customisation is destroyed by the introduction.

### Storage key schema

```ts
// apps/web/src/app/products/[id]/edit/_shared/useTabPrefs.ts
localStorage['product-edit:tab-prefs:v1'] = {
  v: 1,
  items: [
    { key: 'master',   visible: true },
    { key: 'images',   visible: true },
    { key: 'workflow', visible: false },
    …
  ]
}
```

- `v` field reserved for future migration (bump to `v2` when the
  shape changes and add a `migrateFromV1` parallel to TC.8's
  `migrateFromLegacy`).
- `items` is the entire ordered catalog. Reconciliation drops stale
  keys + appends new canonical keys as hidden on read.
- **Legacy key `product-edit:show-all-tabs`** is read once via
  `migrateFromLegacy()` then deleted. `"1"` → all-visible v1 entry
  + eager write (preserves the operator's explicit "show all"
  preference). `"0"` / absent → no-op, falls through to defaults.

### Active-tab session safety

If the URL points to a hidden tab (e.g. deep link to `?tab=workflow`
when Workflow isn't pinned), the strip renders it anyway at its
prefs-position with a dashed bottom border + faded text +
`title="Not in your pinned tabs — open Customize Tabs to pin"`. The
operator never lands on a missing tab; they can pin it via the
modal if they want it permanent. Channel tabs that don't exist on
the product stay excluded (the body wouldn't render anyway).

### Modal anatomy

`apps/web/src/app/products/[id]/edit/_shared/TabPreferencesModal.tsx`

- `@dnd-kit/sortable` with `PointerSensor` (8 px activation distance
  — single clicks don't accidentally drag) + `KeyboardSensor` with
  `sortableKeyboardCoordinates` (Tab to handle → Space → Arrow → Space).
- Per-row 3 interaction zones: **drag handle**, **checkbox**, **row body**.
- Row body click navigates to that tab + auto-pins it + closes modal.
- Footer: **Reset to defaults** (left), **Cancel** + **Save** (right).
- Min-visible guard: Save disabled when draft has zero visible.
- Localised drag announcements via `DndContext accessibility={{ announcements }}`.
- Draft state — Save persists via `setOrderedPrefs`; Cancel discards.

### URL backward compat

`?tab=global` (the old key for the now-merged Master content) is
silently mapped to `?tab=master` both at initial-state seed and at
URL-sync time. The latter rewrites the address bar via
`goToTab('master')` so old bookmarks canonicalise on first visit.

### Anti-patterns (do not introduce)

1. **Hardcoded tab visibility in components.** Visibility decisions
   must go through `useTabPrefs`. A future "show this tab only for
   admin users" should layer ACL on top of `useTabPrefs`, not hide
   tabs at JSX level.
2. **Bypassing the storage key.** Anything that reads/writes
   `product-edit:tab-prefs:v1` outside `useTabPrefs.ts` will skip
   reconciliation + min-visible guard + migration.
3. **Tab keys not in `CANONICAL_TABS`.** Adding a `<TopTabButton
   tabKey="newthing">` without a matching `CANONICAL_TABS` entry
   means the tab can't be hidden or reordered — `visiblePrefs` will
   never include it.
4. **Eager writes to localStorage.** TC.7's first-time-user contract:
   a fresh operator sees defaults from memory only; the v1 entry is
   written only on explicit Save (or one-time on migration). Don't
   write on mount, on tab change, etc.
5. **Two save buttons in one tab.** When a tab composes multiple
   sub-components with different APIs (like Master + the embedded
   GlobalSections from TC.1), the parent tab owns the registry
   entry and coordinates the children via composed flush/discard.
   Never let two sub-components fight over the same registry key.
