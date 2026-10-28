/**
 * DS floor kit — the status colours a floor part may carry (gap G5).
 *
 * Colour is never alone on the floor (A2 §3.1 "Low literacy"): a tone always comes with an icon and a word or number.
 * Each tone paints with the status pairs the contrast gate already measures (`--nds-<tone>-text` on `--nds-<tone>-soft`,
 * the accent stripe in `--nds-<tone>`), in light and dark.
 */
export type FloorTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export const FLOOR_TONES: readonly FloorTone[] = ['neutral', 'primary', 'success', 'warning', 'danger', 'info']
