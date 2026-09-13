import { type ReactNode } from 'react';
/**
 * PreferencesModal — the two-panel grid "Customise" dialog (ported to the DS
 * from the live /products workspace). Left panel: optional page-size · sticky
 * first/last column · optional sort · a `workspaceSlot` escape hatch. Right
 * panel: the column list. Edits are held in a local draft and committed
 * atomically on Save; Cancel discards; Reset reverts to defaults.
 *
 * CHOOSING and ORDERING are split across the two panels: a grouped tick-list on
 * the left picks which columns are in the view; the right panel holds only the
 * chosen ones, in order, each with a drag handle, a padlock and a ✕. This
 * replaced a single list of switches — there is no second shape.
 *
 * Pure DS — no app i18n / utils. Optional sections collapse when their option
 * list is empty (pass `pageSizeChoices={[]}` / `sortFieldOptions={[]}`).
 */
export interface PreferencesColumnSpec {
    key: string;
    /**
     * What the operator reads. Falls back to `key` where a caller leaves it empty — measured
     * 2026-09-02 while retiring the grid-lens fork: `/fulfillment/purchase-orders` ships
     * `label: ''` on its `select` and `actions` columns and leaned on the fork's own
     * `label || key`, so rendering `label` alone put two blank rows in the list. A row with no
     * name is not a column the operator can reason about — and the same is true of the aria-label
     * on its lock and remove buttons, which is why the fallback is applied through `nameOf` rather
     * than at one call site.
     */
    label: string;
    /**
     * IMMUTABLE lock: the column is pinned to an edge of the grid and the dialog offers no lock
     * control for it. Distinct from `defaultLocked`, which the operator can undo.
     */
    locked?: boolean;
    /**
     * Where this column's OPERATOR lock starts out. A column can be unlocked from the dialog and
     * then reordered or removed like any other — that is the whole point of the lock control.
     */
    defaultLocked?: boolean;
    /**
     * Which EDGE an operator lock freezes this column to. Default `left` — the frozen block after the
     * grid's own leading columns. `right` is for a trailing bookend (an actions column) that the
     * caller pins right when locked: the dialog lists it at the END of "In view", in screen order, and
     * a drag between the two edges is refused. The grid's pin itself is the caller's to state.
     */
    lockSide?: 'left' | 'right';
    /**
     * Heading this column sits under in the dialog.
     *
     * Columns without one collect under `listLabel`, so a grid that declares no
     * groups renders exactly ONE section and looks identical to a grouped-unaware
     * build. That is the whole migration story: grouping is opt-in per caller and
     * costs the other callers nothing.
     */
    group?: string;
    /** Stable schema-owned group identity; labels are for display only. */
    groupKey?: string;
}
export interface PreferencesValue {
    visibleColumns: string[];
    /**
     * Columns the OPERATOR has locked: not removable, not draggable, until they unlock it.
     *
     * Optional so every caller that predates the lock keeps compiling and keeps its behaviour —
     * absent falls back to each column's `defaultLocked`.
     */
    lockedColumns?: string[];
    /** Complete attribute order, including hidden fields. */
    columnOrder?: string[];
    groupOrder?: string[];
    /** View-local column key → schema group key. Does not change product mappings. */
    groupOverrides?: Record<string, string>;
    stickyFirstColumn: boolean;
    stickyLastColumn: boolean;
    pageSize: number;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    /**
     * Row grouping, outermost first, by column key. Present only for a grid that offers
     * `groupByOptions`; the grid engine turns it into its own group state.
     */
    rowGroups?: string[];
    /** The aggregate shown on a group row per column key, for a grid that offers `aggregationOptions`. */
    aggregations?: Record<string, PreferencesAggFunc>;
}
export type PreferencesAggFunc = 'sum' | 'avg' | 'min' | 'max' | 'count';
/**
 * A QUICK PICK — a set of columns derived from a column FACT ("Required here", "Axes", "Has
 * data"), offered as a toggle above the tick-list. Pressed when every column it names is in the
 * view; click adds the set or removes it. Sets compose: Required + Axes is their union. The
 * caller derives them from its own contract; the dialog never guesses what a column IS.
 */
export interface PreferencesQuickPick {
    id: string;
    label: string;
    columns: readonly string[];
    /** One line on hover — what the fact is. */
    hint?: string;
}
/**
 * The dialog as a VIEW BUILDER: save the draft as a named view from the footer (design V.4c).
 * `activeName` names the saved view the grid is currently on, which enables "Update". Both
 * callbacks may throw — the reason is shown in the footer and the dialog stays open.
 */
export interface PreferencesViewSave {
    activeName: string | null;
    /** Apply the draft AND write it under `name`. The dialog closes on success; `onConfirm` is NOT called. */
    onSaveAs: (name: string, value: PreferencesValue) => Promise<unknown>;
    /** Apply the draft AND overwrite the active view with it. Same contract. */
    onUpdate?: (value: PreferencesValue) => Promise<unknown>;
}
export interface PreferencesModalProps {
    open: boolean;
    onClose: () => void;
    value: PreferencesValue;
    onConfirm: (next: PreferencesValue) => void | Promise<void>;
    /** Full column registry (visible + hidden + locked), in canonical order. */
    allColumns: readonly PreferencesColumnSpec[];
    /** The "Reset" target visible-columns list. */
    defaultVisible: readonly string[];
    /** Sort field options. Empty ⇒ the Sort section is hidden. */
    sortFieldOptions?: ReadonlyArray<{
        value: string;
        label: string;
    }>;
    /** Page-size choices. Empty ⇒ the Page-size section is hidden. */
    pageSizeChoices?: number[];
    /** Show the sticky first/last column toggles (default true). */
    showSticky?: boolean;
    /** Columns rows can be grouped by. Empty/absent ⇒ the Group section is hidden. */
    groupByOptions?: ReadonlyArray<{
        key: string;
        label: string;
    }>;
    /** Columns a group row can aggregate, with the functions each allows. Empty/absent ⇒ hidden. */
    aggregationOptions?: ReadonlyArray<{
        key: string;
        label: string;
        funcs: readonly PreferencesAggFunc[];
    }>;
    /** Modal title (default "Customise"). */
    title?: string;
    className?: string;
    /**
     * What the list is called. Default "Columns" — every grid keeps its wording unchanged.
     *
     * GX.7 opened this dialog for a page's SECTIONS, where a legend reading "Columns" describes
     * something the reader is not looking at. Forking the dialog to fix a noun would give the
     * platform two Customize dialogs, which is the thing it decided not to have.
     *
     * Doubles as the fallback heading for any column that declares no `group`.
     */
    listLabel?: string;
    /** The hint under the tick-list legend. */
    listHint?: string;
    /** Extra left-panel content (workspace-specific preferences). */
    workspaceSlot?: ReactNode;
    /** Quick picks above the tick-list. Absent ⇒ nothing renders; every existing caller is unchanged. */
    quickPicks?: readonly PreferencesQuickPick[];
    /** "All / Clear" on every group heading. Default off. */
    groupToggles?: boolean;
    /** "· n of N" beside the In-view legend. Default off. */
    inViewCount?: boolean;
    /** Save-as-view in the footer. Absent ⇒ the footer is byte-identical to before. */
    viewSave?: PreferencesViewSave;
    /** Organize both panes by editable attribute groups. Hosts must persist the layout fields. */
    attributeGroups?: boolean;
    /** Explicit recovery after a rejected save, without replacing an in-progress draft automatically. */
    onReloadSaved?: () => Promise<PreferencesValue>;
}
/** Everything the panes need; the modal and the popover both supply it. */
export interface PreferencesPanesOptions {
    value: PreferencesValue;
    onChange: (next: PreferencesValue) => void;
    allColumns: readonly PreferencesColumnSpec[];
    defaultVisible: readonly string[];
    sortFieldOptions?: ReadonlyArray<{
        value: string;
        label: string;
    }>;
    pageSizeChoices?: number[];
    showSticky?: boolean;
    groupByOptions?: ReadonlyArray<{
        key: string;
        label: string;
    }>;
    aggregationOptions?: ReadonlyArray<{
        key: string;
        label: string;
        funcs: readonly PreferencesAggFunc[];
    }>;
    listLabel?: string;
    listHint?: ReactNode;
    workspaceSlot?: ReactNode;
    quickPicks?: readonly PreferencesQuickPick[];
    groupToggles?: boolean;
    inViewCount?: boolean;
    attributeGroups?: boolean;
}
export declare function usePreferencesPanes({ value, onChange, allColumns, defaultVisible, sortFieldOptions, pageSizeChoices, showSticky, groupByOptions, aggregationOptions, listLabel, listHint, workspaceSlot, quickPicks, groupToggles, inViewCount: showInViewCount, attributeGroups, }: PreferencesPanesOptions): {
    pickList: import("react/jsx-runtime").JSX.Element;
    inView: import("react/jsx-runtime").JSX.Element;
    groupingTab: import("react/jsx-runtime").JSX.Element;
    displaySections: import("react/jsx-runtime").JSX.Element;
    resetValue: () => PreferencesValue;
    resetInteraction: () => void;
    tabbed: boolean;
    hasDisplay: boolean;
    hasLeftPanel: boolean;
    groupingCount: number;
};
export declare function PreferencesModal({ open, onClose, value, onConfirm, allColumns, defaultVisible, sortFieldOptions, pageSizeChoices, showSticky, groupByOptions, aggregationOptions, title, listLabel, listHint, workspaceSlot, quickPicks, groupToggles, inViewCount, viewSave, attributeGroups, onReloadSaved, className, }: PreferencesModalProps): import("react/jsx-runtime").JSX.Element;
export declare const PREFERENCES_DEFAULTS: Omit<PreferencesValue, "lockedColumns" | "visibleColumns">;
