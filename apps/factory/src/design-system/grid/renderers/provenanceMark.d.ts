import type { CellProvenance } from './provenance';
export interface ProvenanceMarkProps {
    provenance: CellProvenance;
    /**
     * A host's own sentence, used instead of the member's — for a host whose fact is not a sheet cell's. Absent on the
     * product sheet: there the mark reads `provenanceTooltip(provenance, from)`.
     */
    tooltip?: string;
    /**
     * The ONE meaning on every scope: the layer or source the value follows, came from, or no longer follows —
     * "GALE-JACKET", "the Shared product", "the Primary listing". For `refused`, `pending` and `attention` it is the
     * server's sentence, shown verbatim.
     */
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
 * UNBOXED glyph (Σ mapped, ✎ pinned, 🔗 inherited, ✦ ai), and lucide (0.469.0, hoisted at the repo root and
 * resolved by both apps) has only a BOXED function icon (`FunctionSquare`), which
 * at 11px reads as a checkbox before it reads as a function. The `ƒ` is both the closer match to
 * D16.2's spec and the closer match to its siblings.
 *
 * It carries no colour of its own: `.nds-cell-prov-formula` in `grid.css` reads DS.2's
 * `--nds-prov-formula-fg`, measured in both themes. Only the typography is local, because italic and
 * weight are what make a `ƒ` read as a function rather than an `f`.
 */
export declare const ProvenanceMark: import("react").NamedExoticComponent<ProvenanceMarkProps>;
