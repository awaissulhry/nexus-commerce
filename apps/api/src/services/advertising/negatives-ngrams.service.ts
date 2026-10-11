/**
 * Size words in a search term: a catalogue gap, not waste — labelled, never ranked as waste. ONE BRAIN AB-10 reads it
 * (brain/negatives.ts n-grams).
 *
 * Wave 4 (2026-10-11): this file held the old Negatives page's wasteful-words read and its negate-a-gram write (NEG.6);
 * that page and its routes are gone, and this pattern is what is left.
 */
export const SIZE_RE = /^(\d+(xl|xs)|x{2,}l|taglia|talla|size|grande|grosse|große)$/i
