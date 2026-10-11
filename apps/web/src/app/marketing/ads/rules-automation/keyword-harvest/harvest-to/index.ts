/**
 * "Harvest to…" — the window the Keyword Harvest page opens from a term, a row or the bulk bar (lane HTO, 2026-10-11).
 *
 *   <HarvestToWindow open source={{ rows }} mode="suggested" | "choose" market productId? returnFocusTo? onClose() onDone() />
 *
 * `onDone` fires once, when the window closes after a change set was asked (by Done, Esc, ✕ or "Open campaign"), then
 * `onClose`.
 */
export { HarvestToWindow } from './HarvestToWindow'
