# U.17 — Component Adoption Audit + Migration Plan

**Date:** 2026-05-07
**Scope:** `apps/web/src` — measure adoption of the design-system primitives shipped in U.2, plan the migration sweep.

## Current adoption (baseline)

| Primitive | Raw uses in app | Primitive imports | Adoption |
|-----------|----------------:|------------------:|---------:|
| Button (vs `<button>`) | 176 | 27 | ~13% |
| Input (vs `<input>`) | 35 | 13 | ~27% |
| Modal (vs inline `fixed inset-0`) | 59 inline overlays | 1 | ~2% |

Across the app:
- **176 raw `<button>` elements** that re-implement focus rings, hover states, disabled treatment, and loading spinners inline.
- **59 inline `fixed inset-0` overlays** that each re-invent backdrop opacity, escape handling, click-outside, focus management, body scroll lock, and z-index.
- **35 raw `<input>` elements** missing the Input primitive's consistent border/focus/error styling.

## Why this matters

1. **Cross-browser quirks compound.** U.18's iOS Safari `fixed inset-0` finding hits every single inline modal separately. Migrating to the Modal primitive in U.12 mitigated three of them; the remaining 56 still carry the bug.
2. **A11y drift.** U.13's focus-visible swap landed on Button. The 176 raw `<button>` calls still have inconsistent `focus:ring` (visible on every click) vs `focus-visible:ring` (only on keyboard).
3. **Dark mode rot.** U.14 shipped dark variants on the primitives. Raw HTML elements with bespoke `bg-white` / `text-slate-700` won't switch to dark backgrounds when the user toggles — they'll look broken.
4. **Animation parity.** U.16 added `animate-fade-in` / `animate-scale-in` / `animate-slide-from-right` to the Modal primitive. Inline overlays render flat, no entrance.

## Migration recipe — Modal primitive

Inline overlay pattern (today, ~59 sites):
```tsx
{open && (
  <div
    className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40"
    onClick={onClose}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      className="bg-white rounded-lg shadow-2xl w-full max-w-2xl"
    >
      <header className="…">…title… <button onClick={onClose}>×</button></header>
      <div className="p-5">…body…</div>
      <div className="px-5 py-3 border-t flex justify-end gap-2">…buttons…</div>
    </div>
  </div>
)}
```

Migrated:
```tsx
<Modal open={open} onClose={onClose} title="…" size="2xl">
  <ModalBody>…body…</ModalBody>
  <ModalFooter>…buttons…</ModalFooter>
</Modal>
```

Wins per migration: ~30 LoC removed, focus management for free, escape + click-outside + scroll lock + dark mode + animation + iOS Safari fix.

### Top migration targets

Ranked by visibility / friction:
1. `apps/web/src/app/products/ProductsWorkspace.tsx` — multiple inline overlays (BulkImageUploadModal, AiBulkGenerateModal already external; in-file ones are smaller).
2. `apps/web/src/app/products/_modals/ManageAlertsModal.tsx` — high-traffic, used from drawer.
3. `apps/web/src/app/products/_modals/BundleEditor.tsx` — high-traffic.
4. `apps/web/src/app/products/_modals/CompareProductsModal.tsx` — large bespoke modal.
5. `apps/web/src/app/settings/terminology/TerminologyClient.tsx` — admin surface, lower priority but bigger LoC win.
6. `apps/web/src/app/bulk-operations/UploadModal.tsx` — already a self-contained modal file.
7. `apps/web/src/app/bulk-operations/PastePreviewModal.tsx` — same.
8. `apps/web/src/app/bulk-operations/PreviewChangesModal.tsx` — same.
9. `apps/web/src/app/bulk-operations/components/CascadeChoiceModal.tsx`.
10. `apps/web/src/app/bulk-operations/components/NewProductModal.tsx`.

## Migration recipe — Button primitive

Inline `<button>` pattern:
```tsx
<button
  type="button"
  onClick={save}
  disabled={busy}
  className="h-8 px-3 text-base bg-blue-600 text-white border border-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
>
  Save
</button>
```

Migrated:
```tsx
<Button variant="primary" onClick={save} disabled={busy} loading={busy}>
  Save
</Button>
```

The 176 raw button sites cluster heavily in toolbars and inline edit cells. Per-cell sites (e.g. inline edit start/cancel buttons) are NOT good migration candidates — they need the dense h-7 / h-6 sizing that doesn't fit Button's sm/md/lg vocabulary.

Realistic Button sweep target: **toolbar buttons**, **CTA buttons**, **modal-footer buttons**. Inline-cell buttons stay raw.

### Button sweep — high-value files

1. PageHeader actions across all surfaces (already partially migrated in U.7-U.10)
2. BulkActionBar in `apps/web/src/app/products/ProductsWorkspace.tsx` (12+ raw buttons)
3. Modal footer actions (lands automatically as part of the Modal sweep above)
4. WizardNav (already migrated in U.10)

## Migration recipe — Input primitive

Inline `<input>` pattern:
```tsx
<input
  type="text"
  value={search}
  onChange={(e) => setSearch(e.target.value)}
  placeholder="Search…"
  className="w-full h-8 pl-8 pr-3 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
/>
```

Migrated:
```tsx
<Input
  value={search}
  onChange={(e) => setSearch(e.target.value)}
  placeholder="Search…"
  leftIcon={<Search />}
/>
```

Lower priority than Modal/Button because the visual debt is smaller; `<input>` is closer to the primitive than a custom-styled `<button>` is.

## Recommended sequencing

If the team picks up the adoption sweep:

**Phase 1 — Modal sweep** (highest impact)
- Migrate the 10 named files above. ~60% of inline overlays.
- ~3-4 hours focused work, ~600-800 LoC removed.
- Solves U.18 iOS Safari finding wholesale.

**Phase 2 — Button sweep** (toolbar surfaces)
- Migrate PageHeader actions, BulkActionBar, WizardNav, ColumnPickerMenu, FilterDropdown.
- ~2 hours, mostly mechanical.
- Inline-cell buttons stay raw (intentional — Button primitive doesn't fit dense h-6/h-7 sizes).

**Phase 3 — Input sweep** (lowest priority)
- Optional. Visual debt is small; defer until consistency complaints surface.

## Out of scope for U.17 phase-1 commit

The phase-1 deliverable is this audit + plan. Actual mechanical migration of the 10 files is a multi-PR engagement that should be sequenced and reviewed per file. Each migration is small-blast-radius but needs a quick eyeball pass to verify the modal contents render identically. Bundling 10 of them in one commit would obscure regressions.

## Verification queries

To re-measure adoption after sweep PRs land:

```bash
cd apps/web/src
echo "raw <button>:    $(grep -rE '<button ' --include='*.tsx' . | wc -l)"
echo "Button imports:  $(grep -rE 'from .@/components/ui/Button.' --include='*.tsx' . | wc -l)"
echo "raw <input>:     $(grep -rE '<input ' --include='*.tsx' . | wc -l)"
echo "Input imports:   $(grep -rE 'from .@/components/ui/Input.' --include='*.tsx' . | wc -l)"
echo "fixed inset-0:   $(grep -rE 'fixed inset-0' --include='*.tsx' . | wc -l)"
echo "Modal imports:   $(grep -rE 'from .@/components/ui/Modal.' --include='*.tsx' . | wc -l)"
```
