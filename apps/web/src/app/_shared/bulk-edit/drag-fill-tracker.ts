'use client'

/**
 * W1.5 — drag-fill cursor tracker extracted from BulkOperationsClient.
 *
 * The cursor-tracking side effects (mousemove + mouseup + Escape +
 * right-click cancel + the rAF coalescer that elementFromPoint runs
 * inside) are independent of the grid's React state. Pulling them into
 * a standalone function shrinks the monolith without changing semantics:
 *
 *   - mousemove → rAF-coalesced elementFromPoint → cell coords → onTarget
 *   - mouseup   → tear down + onCommit (with the latest target)
 *   - Escape    → tear down + onCancel (no commit)
 *   - rightclick → tear down + onCancel (no commit)  (TECH_DEBT #26)
 *
 * The grid's data-row-idx / data-col-idx attributes (set by GridRow's
 * cell renderer) are the contract — the tracker reads them off the
 * element under the cursor.
 */

export interface DragFillTrackerOptions {
  /**
   * Called on every cursor movement after the rAF flush, with the
   * (rowIdx, colIdx) of the cell currently under the pointer. The
   * caller normally updates `fillState.target` here.
   */
  onTarget: (target: { rowIdx: number; colIdx: number }) => void
  /**
   * Called once on mouseup. The caller commits the fill against the
   * latest tracked target.
   */
  onCommit: () => void
  /**
   * Called when the user cancels (Escape or right-click). The caller
   * normally clears `fillState`. Distinct from onCommit so the caller
   * doesn't have to flag "did we cancel" before deciding what to write.
   */
  onCancel: () => void
}

/**
 * Wire the document-level listeners for one drag-fill gesture. Returns
 * a teardown function in case the caller wants to abort early (e.g. the
 * grid unmounts mid-drag). The returned teardown is also called
 * automatically on every terminal event — calling it twice is safe.
 */
export function startDragFillTracker(opts: DragFillTrackerOptions): () => void {
  const { onTarget, onCommit, onCancel } = opts
  const local = { rafId: null as number | null, x: 0, y: 0, done: false }

  const flush = () => {
    local.rafId = null
    const el = document.elementFromPoint(local.x, local.y) as
      | HTMLElement
      | null
    if (!el) return
    const cellEl = el.closest('[data-row-idx]') as HTMLElement | null
    if (!cellEl) return
    const r = parseInt(cellEl.getAttribute('data-row-idx') ?? '', 10)
    const c = parseInt(cellEl.getAttribute('data-col-idx') ?? '', 10)
    if (Number.isNaN(r) || Number.isNaN(c)) return
    onTarget({ rowIdx: r, colIdx: c })
  }

  const onMove = (e: MouseEvent) => {
    local.x = e.clientX
    local.y = e.clientY
    if (local.rafId === null) {
      local.rafId = requestAnimationFrame(flush)
    }
  }

  const teardown = () => {
    if (local.done) return
    local.done = true
    if (local.rafId !== null) cancelAnimationFrame(local.rafId)
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('contextmenu', onContext)
  }

  const onUp = () => {
    teardown()
    onCommit()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      teardown()
      onCancel()
    }
  }
  // TECH_DEBT #26 — right-click cancels mid-drag. Same effect as Esc;
  // mouse-driven users get an affordance that doesn't require their
  // other hand on the keyboard. preventDefault suppresses the browser
  // context menu so the cancel feels intentional.
  const onContext = (e: MouseEvent) => {
    e.preventDefault()
    teardown()
    onCancel()
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('keydown', onKey)
  document.addEventListener('contextmenu', onContext)

  return teardown
}
