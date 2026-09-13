/**
 * The tag glyph set — a closed vocabulary, for the same reason the colour palette is closed.
 *
 * WHY A GLYPH AT ALL. A tag renders as a 9px dot beside its name. Past about eight hues, dots at
 * that size stop being distinguishable for anyone, and WCAG 1.4.1 forbids colour as the ONLY
 * visual carrier of meaning — roughly 1 in 12 men have a colour vision deficiency. A glyph is
 * distinguishable across dozens of values at 13px and is exactly the redundant encoding the
 * criterion asks for. Trello solves the same problem with pattern overlays; a pattern needs a
 * filled pill to sit in, and our chip is a dot plus a name, so an icon is the fit here.
 *
 * WHY CLOSED. Twenty-four silhouettes chosen to be distinct at 13px — no near-pairs (no circle
 * beside circle-dot). An open icon picker earns a vocabulary of forty glyphs nobody can tell
 * apart, which is the same failure as an open colour picker.
 */
import { type LucideIcon } from 'lucide-react';
export interface TagIconSpec {
    /** Stored on `Tag.icon`. Stable — renaming one orphans every tag that chose it. */
    id: string;
    label: string;
    Icon: LucideIcon;
}
export declare const TAG_ICONS: readonly TagIconSpec[];
export declare const tagIconSpec: (id: string | null | undefined) => TagIconSpec | undefined;
export interface TagGlyphProps {
    /** The tag's stored icon id. Unknown or absent falls back to the dot. */
    icon?: string | null;
    color?: string | null;
    size?: number;
    className?: string;
}
/**
 * What a tag shows before its name: its glyph, or the dot every tag had before glyphs existed.
 * ONE renderer, so the grid cell, the tag dialog and any picker cannot drift apart.
 */
export declare function TagGlyph({ icon, color, size, className }: TagGlyphProps): import("react/jsx-runtime").JSX.Element;
