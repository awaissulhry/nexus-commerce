# U.18 — Cross-Browser Compatibility Audit

**Date:** 2026-05-07
**Scope:** `apps/web/src` (Next.js 16 app router, Tailwind v3)
**Method:** Static analysis of CSS utilities, JS APIs, and DOM event uses against known engine quirks (Safari, Firefox, Chrome, Edge).

## Triage summary

| Severity | Count | Action |
|----------|-------|--------|
| HIGH | 3 | Fixed in U.12 (viewport units) or carry-over to follow-up |
| MEDIUM | 6 | Document; fix when touched |
| LOW | 6 | Acknowledge; no action unless reported |

## High severity

### 1. iOS Safari `100vh` clipping — **FIXED in U.12**
- `apps/web/src/app/bulk-operations/page.tsx:20` — `h-[calc(100vh-1.5rem)]`
- `apps/web/src/app/layout.tsx:25` — `h-screen`
- `apps/web/src/app/products/[id]/list-wizard/ListWizardClient.tsx:310` — `h-screen`
- **Fix shipped:** swapped to `100dvh` / `[100dvh]` arbitrary value. Modal max-h also moved to `max-h-[85dvh]` for centered placement.

### 2. Modal `fixed inset-0` quirks on iOS Safari
- 40+ instances; primary primitive at `apps/web/src/components/ui/Modal.tsx`
- Centered modals can have unexpected scroll-jail behaviour when nested scroll containers exist.
- **Status:** the `Modal` primitive sets `body { overflow: hidden }` while open which mitigates most cases. Verify on iOS Safari for bulk-operations modals (PreviewChangesModal, UploadModal) and the wizard's Step10Submit polling overlay.

### 3. HTML5 drag-drop API quirks
- `apps/web/src/app/products/ProductsWorkspace.tsx:1662, 3640–3686` — drag-drop column reorder + bulk image upload
- Firefox: `DataTransferItems` and folder (`webkitdirectory`) handling differs.
- Safari: stricter dataTransfer restrictions; folder drop unsupported pre-15.
- **Action:** add feature detection for `webkitdirectory`; fallback to file-picker when the folder API is unavailable. Defer to a focused follow-up — drag-drop column reorder works fine in Firefox/Safari, only the bulk-image folder drop is sketchy.

## Medium severity

### 4. BroadcastChannel missing in Safari < 15.1
- `apps/web/src/lib/sync/invalidation-channel.ts:14–95`
- Already guarded with `typeof BroadcastChannel === 'undefined'` check; cross-tab invalidation just no-ops on old Safari instead of crashing.
- **Action:** none required; could add localStorage-event-based fallback if Safari < 15 ever becomes a target.

### 5. Sticky positioning + virtualised tables in Safari
- 50+ `sticky left-0` / `sticky top-0` uses; key sites: `ProductsWorkspace.tsx:2573, 3861`.
- Safari has long-standing issues with `position: sticky` inside scroll containers that have horizontal AND vertical scrolling.
- **Action:** test the products grid + bulk-operations grid in Safari. If sticky SKU column flickers, fall back to a JS-based sticky shim or wrap in a separate scroll container.

### 6. Pointer events vs mouse events on hybrid input
- `apps/web/src/app/bulk-operations/BulkOperationsClient.tsx:720–755` — drag selection
- Currently mouse-only; touch/pen ignored.
- **Action:** add `pointerdown`/`pointermove`/`pointerup` listeners alongside mouse events for iPad / touch laptop support.

### 7. `navigator.clipboard.writeText` error handling
- 4 sites: `ApiKeysClient.tsx:62`, `ReturnsWorkspace.tsx:653`, `PayloadPreview.tsx:74`, `ReplenishmentWorkspace.tsx:3897`
- Requires HTTPS; throws in sandboxed iframes; Firefox CSP-strict.
- **Action:** wrap remaining sites in try/catch and fall back to `document.execCommand('copy')` for older Safari. ReturnsWorkspace already has the guard.

### 8. Modal `max-h-[Xvh]` viewport jitter
- 15+ instances with `max-h-[80vh]`, `max-h-[85vh]`, `max-h-[90vh]`.
- iOS Safari URL-bar resize moves the floor.
- **Status:** primary `Modal` primitive moved to `dvh` in U.12. Inline modals scattered across the app still use `vh`.
- **Action:** sweep remaining sites in U.17 (component adoption) when migrating to the primitive.

### 9. `document.elementFromPoint` in virtualised grids
- `BulkOperationsClient.tsx:703` — drag-fill cell hit-testing
- Firefox: stricter hit-test; can return null during rapid scrolling.
- Already null-guarded; no action.

## Low severity

### 10. `focus:ring` clipping in Firefox under `overflow:hidden`
- Most sites use `focus:ring-2 focus:ring-blue-500` inside `overflow-hidden` containers.
- Firefox clips the ring; Chrome doesn't.
- **Action:** swap `focus:ring` for `focus-visible:ring` and ensure containers use `overflow-visible` where focus matters. Defer to U.13 (a11y).

### 11. Sub-12px arbitrary text sizes (`text-[9px]`)
- ~20 instances of `text-[Npx]` smaller than 12px.
- Safari has a minimum font-size enforcement for some contexts.
- **Action:** sweep in U.13 (a11y) — sub-12px also fails WCAG readability.

### 12. `requestAnimationFrame` + `elementFromPoint` timing
- Already mitigated; rAF flush is in place. No action.

### 13. `backdrop-blur` on transparent backgrounds
- 25+ uses; Tailwind already prefixes `-webkit-backdrop-filter`.
- Firefox added support in v125+ (Mar 2024).
- **Action:** none.

### 14. `FormData` API
- Modern Next.js targets ES2020+; not a practical concern.

### 15. `beforeunload` event
- Safari ignores custom messages; event timing unpredictable.
- 3 sites already coded defensively (`e.preventDefault + returnValue`).
- **Action:** none.

## Test priorities

When validating in real browsers (manual):
1. **iOS Safari 17+** — viewport units (validate U.12 fixes), modal scroll-jail, drag-drop column reorder.
2. **Firefox latest** — focus-ring rendering, drag-drop folder upload, BroadcastChannel cross-tab refresh.
3. **Edge (Chromium)** — should match Chrome; spot-check.

Codebase is otherwise well-aligned with modern engine behaviour. No fundamental architectural rewrites needed.
