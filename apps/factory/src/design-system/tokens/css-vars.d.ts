export interface CssVar {
    /** when set, a section-comment is emitted before this row */
    section?: string;
    name: string;
    value: string;
}
export declare const cssVars: ReadonlyArray<CssVar>;
/** Dark-mode overrides (the `.dark` block). Provisional inversions; their only home. */
export declare const cssVarsDark: ReadonlyArray<CssVar>;
