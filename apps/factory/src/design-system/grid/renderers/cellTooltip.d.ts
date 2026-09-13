/**
 * GDS — ONE tooltip per cell, composed in one place.
 *
 * 🔴 Why this exists (hub #662, measured 2026-09-02). A cell had TWO tooltips: AG's overlay, driven
 * by the column's `tooltipValueGetter`, and a native browser one from a `title` the long-text
 * renderer put on its own inner span. Two mechanisms, two hover behaviours, and neither knew about
 * the other — so while a write was refused the getter returned the refusal INSTEAD of the length
 * figures (an early return, not a composition), and the figures survived only through the rival
 * `title`. Whichever the pointer happened to rest on decided what the operator was told.
 *
 * The rule: **a renderer never claims `title`.** It contributes a LINE, the column composes, and
 * the reason goes FIRST because it is the urgent fact — what happened to the value you just typed,
 * before what the field's limits are.
 *
 * (The retraction that produced this file is worth keeping: I first reported that the reason was
 * not rendered anywhere. It was — in AG's tooltip, which renders into a popup OUTSIDE the cell, so
 * a DOM walk of the cell's own subtree could not have found it however well it worked. The defect
 * was never absence; it was two homes and an early return.)
 */
import { type LongTextCaps } from './longTextState';
/**
 * Join a cell's tooltip lines into one string, most urgent first, blank line between.
 *
 * Empty parts are dropped rather than rendered as gaps, and an exact repeat is dropped too: when a
 * refusal reason and the column's own line say the same thing, saying it twice reads as two
 * separate problems.
 */
export declare function composeCellTooltip(...parts: (string | null | undefined)[]): string;
/**
 * The long-text column's contribution: the length reading, phrased for a tooltip.
 *
 * `undefined` for an empty cell — there are no figures to give about nothing, and the cell already
 * says "empty" or "required" in its own glyph.
 */
export declare function longTextTooltipLine(value: unknown, caps: LongTextCaps): string | undefined;
