# U.19 — Performance Hotspot Analysis

**Date:** 2026-05-07
**Scope:** `apps/web/src` — primarily ProductsWorkspace.tsx (~185KB, 4,524 lines) and BulkOperationsClient.tsx (~155KB, 4,039 lines)
**Method:** Static analysis of memo coverage, dep arrays, listener churn, virtualization, and bundle composition.

## Summary

The two giant client components carry the cost. **Two issue clusters dominate**:
- **String-based dep array thrashing** (#1, #6) — `[arr.join(',')]` rebuilds a fresh string on every render.
- **Missing React.memo on cell-level components** (#2, #9) — 240+ FieldCell instances re-mount on every parent state change.

Combined, these likely add 200–400ms of jank per filter toggle / keystroke. Fixing #1, #2, #5, and #7 would deliver ~60% of the available win with focused work.

Bundle is healthy: lucide-react / @tanstack/* tree-shake correctly; recharts stays in /fulfillment/replenishment.

## Top 12 hotspots

### High impact (>100ms / common interaction)

**1. ProductsWorkspace.tsx:537 — string-join dep array thrashing**
- `useEffect(() => { setSelected(...) }, [page, search, statusFilters.join(','), ...9 more])`
- Joining arrays inside the dep array allocates fresh strings every render; effect fires on each filter toggle even when the logical set didn't change.
- **Fix:** memoize a single stable filter-key string with `useMemo`; pass that as the only dep.

**2. ProductsWorkspace.tsx:2816 — ProductCell list isn't memoised**
- `{visible.map((col) => <ProductCell …/>)}` runs every parent render.
- `onTagEdit`/`onChanged` callbacks aren't memoised, so `React.memo` on ProductCell wouldn't help even if added.
- **Fix:** wrap the .map in `useMemo`, stabilise the callbacks via `useCallback` referencing latest values via refs, then add `React.memo` to ProductCell.

### Medium impact

**3. ProductsWorkspace.tsx:579–581 — keyboard-handler effect deps include `fetchProducts`**
- Listener is rebuilt on every URL change. Cleanup + re-attach on each filter toggle.
- **Fix:** capture `fetchProducts` in a ref; effect dep array shrinks to `[router]`.

**4. ProductsWorkspace.tsx:2503–2526 — full `flatRows` recompute on parent expand**
- `useMemo(() => for (const p of products) …, [products, expandedParents, childrenByParent, loadingChildren])`.
- 1000+ rows × 10+ expanded parents = ~50–100ms per expand.
- **Fix:** differential update — track which parent changed and splice its children in/out instead of rebuilding the full array.

**5. ProductsWorkspace.tsx:328–348 — `productsUrl` rebuilds on every keystroke**
- The URL builder depends on `search` directly (pre-debounce). 8 keystrokes typing "product" = 8 URL builds + 8 polledList invalidations.
- **Fix:** debounce `search` before feeding into the URL builder, or wire URL build to a separate effect that watches the debounced value.

**6. ProductsWorkspace.tsx:537 — same selection-reset dep cluster as #1**
- 9 `.split().filter()` calls in `parseFilters` allocate fresh arrays.
- **Fix:** single `useMemo` returning a stable `{ statusFilters, … }` object; depend on that.

**7. BulkOperationsClient.tsx:423–460 — 16+ separate `useState` hooks**
- Each modal-open / drag-state change re-renders the entire grid.
- **Fix:** consolidate related state via `useReducer` (e.g., `{ modal: { preview, upload, … }, drag: { columnId, overId, … } }`); only the affected slice triggers a re-render via memoised selectors.

### Low impact (micro-optimisations)

**8. BulkOperationsClient.tsx:1170–1176 — `cascadeKeys` rebuilds on every cell edit**
- O(n) over `changes` Map per keystroke.
- **Fix:** maintain `cascade` as a Set updated incrementally on add/remove.

**9. ProductsWorkspace.tsx:3188–3265 — ProductCell edit-state thrashing**
- Functional component with internal `useState`; parent re-render unmounts/remounts → loses edit state mid-typing.
- **Fix:** `React.memo(ProductCell)` after #2's callback memoization lands.

**10. BulkOperationsClient.tsx:371, 629 — `JSON.parse/stringify` on every column resize**
- 30+ resize events per drag; each one parses + writes localStorage.
- **Fix:** debounce localStorage write to 500ms post-last-resize via a ref-cached value.

**11. ProductsWorkspace.tsx:579–581 — keyboard handler deps (duplicate of #3)**

**12. ProductsWorkspace.tsx:2537–2551 — virtualizer overscan hardcoded at 12**
- On a 27" 1440p display this could render 40+ extra rows.
- **Fix:** dynamic `overscan: Math.max(5, Math.ceil(viewportHeight / rowHeight / 2))`.

## Bundle observations

Healthy:
- `lucide-react` — named imports throughout, tree-shakes per icon.
- `@tanstack/react-table`, `@tanstack/react-virtual` — selective imports.
- `recharts` — confined to `/fulfillment/replenishment/ReplenishmentWorkspace.tsx`.

No major bundle blockers identified. Dynamic-import opportunities exist for the heavy modals (BulkOperationModal at 58KB, UploadModal at 17KB) — they only load when the user clicks the trigger, so a `next/dynamic` import would defer ~75KB off the initial /bulk-operations route. Not done in U.19; flagged for follow-up.

## Recommended sequencing

If the team picks up the perf debt, ship in this order:
1. #1 + #6 + #5 (filter dep cluster) — single PR, ~150 LoC.
2. #2 + #9 (ProductCell memoization) — second PR, includes callback stabilization.
3. #4 (flatRows differential rebuild) — bigger refactor; only worth it if profiling shows expand jank.
4. #7 (BulkOperationsClient state consolidation) — multi-day refactor; weigh against churn risk.

Items #3, #8, #10, #11, #12 are file-touch optimisations that can ride along with feature work in those areas.

## Out of scope

- Server-side rendering performance (Next.js App Router defaults are fine).
- Backend latency.
- Image optimisation pipeline.
