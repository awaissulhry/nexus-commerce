import type { CellProvenance } from './provenance';
export interface ProvenanceMarkProps {
    provenance: CellProvenance;
    /** The canonical describeCellSource sentence, including the addressed tier when available. */
    tooltip?: string;
    /** Names the layer the value came from — "GALE-JACKET", "Amazon · IT", "master". */
    from?: string | null;
}
/**
 * The mark itself. Renders NOTHING for `own`, which is most cells — a sheet where every cell
 * carries an icon has told the operator nothing.
 *
 * Each non-own mark has an accessible name. A role and label create no tab stop; hiding
 * these marks from assistive technology would hide the value’s provenance.
 */
/**
 * 🔴 `formula` is a CHARACTER, not a lucide icon, and that is measured rather than stylistic.
 *
 * `/design/formula-lab` drew it and recorded why: every other member of this vocabulary is an
 * UNBOXED glyph (Σ mapped, ✎ pinned, 🔗 inherited, ✦ ai), and lucide 0.263.1 — the version
 * `apps/web` actually resolves, not the 0.469 hoisted at the root — has only `FunctionSquare`, which
 * at 11px reads as a checkbox before it reads as a function. The `ƒ` is both the closer match to
 * D16.2's spec and the closer match to its siblings.
 *
 * It carries no colour of its own: `.nds-cell-prov-formula` in `grid.css` reads DS.2's
 * `--nds-prov-formula-fg`, measured in both themes. Only the typography is local, because italic and
 * weight are what make a `ƒ` read as a function rather than an `f`.
 */
export declare const ProvenanceMark: import("react").NamedExoticComponent<ProvenanceMarkProps>;
