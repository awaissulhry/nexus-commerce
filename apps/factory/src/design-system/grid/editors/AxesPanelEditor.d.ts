/**
 * GDS / VT.2 — `AxesPanelEditor`: the variation-theme editor. ONE component, TWO hosts.
 *
 * Design `docs/2026-09-13-variation-theme-column-design.md` §3.5; canvas artboards 2–4 (master,
 * Amazon·DE, eBay·IT) are the screen truth; contract `docs/vt1-contracts.md` §1 and §3.
 *
 * ## The two hosts
 *
 * `AxesPanelEditor` is the AG cell editor: a popup (`cellEditorPopup: true` on the ColDef, because
 * `isPopup` cannot be supplied by a ref — see `SelectPanelEditor`'s header), sized by the shared
 * `editorBox` at kind `axes`, reporting through `onValueChange` and discarding an untouched edit
 * through `useGridCellEditor({ isCancelAfterEnd })`.
 *
 * `AxesPanel` is the same panel with no AG hooks at all, for the Variants dock (design §3.5's last
 * clause, D-VT4). The split exists ONLY because `useGridCellEditor` reads a context AG provides and
 * a hook cannot be called conditionally — the panel, its state machine and every string are one
 * definition (`feedback_shared_components_no_copy_props`). One test file covers both.
 *
 * ## The AG facts this is designed around, all measured (memory)
 *
 * 1. `props.onValueChange` on EVERY change. A ref `getValue` is never read by AG 36's React proxy
 *    (`reference_ag36_react_editor_onvaluechange`), so a panel that held its draft for AG to collect
 *    would commit nothing and issue no request — the exact defect measured on `SelectPanelEditor`.
 * 2. **Report nothing until the operator changes something.** Reporting on mount ARMS a write: AG
 *    fires `cellValueChanged` for the reported value, the SheetWriter queues it, and opening a cell
 *    to look at it would save it. `touched` is that gate, and `isCancelAfterEnd` is its second half.
 * 3. **Enter, Tab and Esc are AG's** inside a popup (`reference_ag_popup_editor_owns_keys`). Nothing
 *    here listens for them: Enter commits the LAST REPORTED value and Esc discards, which is exactly
 *    the contract the footer advertises. `,` and `/` (D-VT7) are not AG's and are handled where they
 *    are typed — in the candidate filter's own input. No `suppressKeyboardEvent` is declared because
 *    none was needed on screen; adding one unmeasured would take a key from AG for no reason.
 * 4. The FILL HANDLE is disabled on this column in `shapeColumn.ts`
 *    (`reference_ag_fill_handle_swallows_dblclick`): its double-click handler swallows the open
 *    gesture AND fills the column down, and a projection filled down 20 rows is 20 silent writes.
 * 5. `cellEditorParams` is a STABLE object built once per column build
 *    (`reference_ag_react_inline_options_rerun_column_model`).
 */
import { type CSSProperties, type ReactNode } from 'react';
import { variationThemeText, type VariationThemeAxis, type VariationThemeCell } from '../renderers/variationTheme';
export declare const AXES_EDITOR_COPY: {
    readonly title: "Variation theme";
    readonly keys: "Esc discards · ⏎ saves";
    readonly override: "Override";
    readonly resetToRule: "Use inherited axes";
    readonly theme: "Theme";
    readonly coversAll: "Covers every axis";
    readonly dropsAn: "Drops an axis";
    readonly deprecated: "Deprecated";
    readonly axesOnChannel: "Axes on this channel";
    readonly orderFromTheme: "order from the theme";
    /**
     * VT.2c — the SHORT phrase for the one-line section hint when a LIVE coordinate refuses a
     * reorder. The full sentence is the server's `locked.reason` and it is on the element's `title`
     * and in the lock Banner; this line only has room for the fact. `ASSUMED:` — Appendix A has no
     * sentence for it, recorded in the ledger rather than invented silently.
     */
    readonly orderLockedShort: "order fixed while live";
    readonly droppedHere: "dropped on this channel";
    readonly addAxis: "+ Add axis";
    readonly addSpecific: "+ Add a specific";
    readonly addOption: "+ Add an option";
    readonly addsHint: ", or / adds the highlighted one";
    /** Canvas artboard 2's master strapline — master has no `source.label` to show (contract §1.2). */
    readonly masterStrap: "The family's axes — every channel projects these. Drag to order.";
    readonly masterFooter: "children keep their values";
    /**
     * VT.2c — the two held-`+ Add` sentences and the two target-control aria sentences, VERBATIM from
     * VP.4's `SpecificsSection` (spec §4.4.1 / §4.4.4). They travel WITH the control into the shared
     * panel: copy that stays behind in the host is how two hosts of one control start disagreeing
     * (`feedback_shared_components_no_copy_props`).
     */
    readonly atLimit: (channel: string, limit: number, plural: string) => string;
    readonly everyAxisMapped: (noun: string) => string;
    readonly targetAria: (channel: string, noun: string, axis: string) => string;
    readonly targetLockedAria: (channel: string, noun: string, axis: string, target: string, reason: string) => string;
};
/** `Variation theme · Amazon · DE` / `Variation theme · Shared product`, from the WIRE. */
export declare function axesEditorScopeLabel(cell: VariationThemeCell): string;
/** The section heading over the axis rows. Amazon says `Axes on this channel`; everyone else uses their own noun. */
export declare function axesSectionTitle(cell: VariationThemeCell): string;
/** `+ Add axis` · `+ Add a specific` · `+ Add an option` — the channel's own noun (Appendix A). */
export declare function axesAddLabel(cell: VariationThemeCell): string;
export type ThemeGroup = 'coversAll' | 'drops' | 'deprecated';
/**
 * The theme list's three groups (design §3.5, Appendix A headings).
 *
 * Grouped by the WIRE's own flags, in this order, and `deprecated` WINS over `coversAll`: a
 * deprecated spelling that happens to cover every axis is still the one an operator must be warned
 * about, and VT.0 measured that this is the common case rather than a corner (32 canonical keys on
 * this catalogue carry two spellings, and on OUTERWEAR the `_NAME` twin is the deprecated one).
 */
export declare function themeGroupOf(item: {
    coversAll: boolean;
    deprecated: boolean;
}): ThemeGroup;
export declare const THEME_GROUP_ORDER: readonly ThemeGroup[];
export declare const THEME_GROUP_LABEL: Record<ThemeGroup, string>;
/** Case-insensitive substring over the code AND the printed label — a filter that saw only one would hide half the list. */
export declare function axesFilterMatch(query: string, item: {
    code: string;
    label: string;
}): boolean;
/**
 * Move the highlight, clamped. Returns the same index at either end rather than wrapping: a list an
 * operator is filtering has no stable length, and a wrap turns "I am at the bottom" into a jump to a
 * row they cannot see.
 */
export declare function moveHighlight(current: number, delta: number, length: number): number;
/** Keys that ADD the highlighted candidate (D-VT7). `+` is deliberately absent — it is a value character. */
export declare const AXES_ADD_KEYS: readonly string[];
/** Reorder, shared by master's chips and the channel's rows so there is ONE reorder rule. */
export declare function reorderAxes(axes: VariationThemeAxis[], order: string[]): VariationThemeAxis[];
/**
 * The CHANNEL's own word for the coordinate (`eBay`), for the sentences that name it. One source:
 * the DS's `channelDisplayName`, never a local map — a second map is how one surface says `Ebay`.
 */
export declare function axesChannelWord(cell: VariationThemeCell): string;
/**
 * Why THIS axis cannot be re-pointed or dropped — the server's own sentence — or `null` when it can.
 *
 * 🔴 `locked.lockedAxisKeys` ABSENT is not an empty list. It means this producer does not state
 * per-axis locks (the sheet cell's does not; the projection read does), so the panel renders the
 * unlocked arm rather than asserting a measurement nobody took.
 */
/**
 * Is THIS axis one the coordinate has already published? Then it keeps its row and loses its control.
 *
 * 🔴 VT.F item A5 — the match is over THREE spellings of the same axis, not one, and a literal
 * `includes(axisKey)` is a silent false negative on one of the two hosts. Measured on GALE eBay·IT the
 * moment the sheet cell started serving the field: `locked.lockedAxisKeys` is `["Colore","Taglia"]` —
 * the eBay aspect NAMES, which is what `__lastPublishedAxes` stores because that is what went out — while
 * the cell's `axes[].axisKey` is CANONICAL (`color`, `size`). The dock never saw it, because there the
 * mapping's axisKey IS the family spelling (`Colore`), so one compare worked on one host and failed on
 * the other for the same live listing. That is the shape of
 * `reference_combination_value_is_not_the_inherited_value`: one identity, three vocabularies.
 *
 * So the axis is matched on its canonical key, its FAMILY key and its delivered TARGET, case-insensitively
 * (the casing in `__lastPublishedAxes` is the channel's, not ours). A locked axis missed here would render
 * a live control over a frozen axis, which is the dangerous direction.
 */
export declare function axisLockReason(cell: VariationThemeCell, axisKey: string): string | null;
export interface AxesOrderState {
    writable: boolean;
    /** The FULL sentence — the tooltip, the aria text and the dock's own note. `null` when writable. */
    reason: string | null;
    /** The SHORT phrase for the cell editor's one-line section hint. `null` when writable. */
    hint: string | null;
}
/**
 * Is a REORDER a permitted commit on this coordinate, and if not, why not?
 *
 * FOUR rules, in this order, and the order is the measurement — every one of them was read off the
 * running local API on 2026-09-13 (`GET …/studio/projection`, three coordinates):
 *
 * 1. **Amazon's THEME fixes the segment order** (`candidates.kind === 'theme-enum'`, which after the
 *    dock adapter is the CELL host only). The rows are informational there, and the hint has said
 *    `order from the theme` since VT.2 — canvas artboard 3, measured at Δ0. It sits FIRST because it
 *    is the more specific mechanism AND the shorter line: the 11px `nowrap` hint slot cannot hold a
 *    lock sentence that names an ASIN and a child count, and that sentence is already on screen in
 *    the lock Banner two blocks below.
 * 2. **A LIVE coordinate that cannot revise its order** — `locked.orderChangeAllowed === false`.
 *    Measured: GALE `Amazon·IT` answers `locked { lockedAxisKeys: [], orderChangeAllowed: false,
 *    setChangeIs: 'new-parent' }` (VT.1b unified this with the cell's rule), while `eBay·IT` answers
 *    `orderChangeAllowed: true` on the SAME family — reordering a live eBay listing is a revise,
 *    which is the one change design §3.5 lets through a lock. A rule that read only the `order` block
 *    would have made the Amazon grips live on a live ASIN.
 * 3. **The endpoint's own statement**, `cell.order` (`docs/vp2-contracts.md` §4.1). Measured on
 *    GALE eBay·IT: `writableHere: true` with a `token` — so the dock's grips are LIVE there and its
 *    save carries `presentationOrder`. The adapter only relays this block when the server actually
 *    stated something; see `axesCellFromProjection`.
 * 4. Otherwise writable.
 */
export declare function axesOrderState(cell: VariationThemeCell): AxesOrderState;
/** Permitted → the next cell; refused → the sentence that refused it. Never a silent no-op. */
export type AxesEdit = {
    ok: true;
    next: VariationThemeCell;
} | {
    ok: false;
    refused: string;
};
/**
 * A SET change on one axis — its target, or whether it is delivered here.
 *
 * 🔴 The gate is here and not only on the control's `disabled`, because a disabled control is one
 * door: `onValueChange` must report only a PERMITTED change, and a report is what arms the write.
 */
export declare function axesSetAxis(cell: VariationThemeCell, axisKey: string, patch: Partial<VariationThemeAxis>): AxesEdit;
/** A reorder — permitted whenever `axesOrderState` says the order is writable here. */
export declare function axesReorder(cell: VariationThemeCell, order: string[]): AxesEdit;
export type AxesEditorHost = 'cell' | 'dock';
export interface AxesPanelProps {
    cell: VariationThemeCell;
    host: AxesEditorHost;
    /** Called on EVERY change with the whole edited cell. The cell host wires this to `onValueChange`. */
    onChange: (next: VariationThemeCell) => void;
    /**
     * A locked coordinate whose axis SET (or theme) moved. VT.4 supplies the dry-run plan; until it
     * does, the panel HOLDS with the server's own reason on screen and writes nothing — never a silent
     * write and never a silent no-op.
     */
    onPlanRequired?: (info: {
        cell: VariationThemeCell;
        draft: VariationThemeCell;
        reason: string;
    }) => void;
    /** The dock's own footer (`Save mapping`) — it stays, so the panel renders whatever it is given. */
    footer?: ReactNode;
    width?: number;
    maxHeight?: number;
    style?: CSSProperties;
}
export declare function AxesPanel({ cell, host, onChange, onPlanRequired, footer, width, maxHeight, style }: AxesPanelProps): import("react/jsx-runtime").JSX.Element;
/**
 * The Variants dock speaks VP.2's `ProjectionPage` / `ProjectionDraft`; this panel speaks VT.1's
 * `VariationThemeCell`. ONE adapter, here, so the dock renders the SAME component (design §3.5's
 * last clause, D-VT4) without a second editor and without the design system importing an app type.
 *
 * 🔴 Structurally typed, like `VariationThemeWriteFacts`: the DS must not reach into
 * `_studio/variants/channel/types.ts`, and a structural parameter also means the dock can hand it a
 * page shape that has grown a field without this file caring.
 *
 * 🔴 It does NOT invent a `write` block. The dock owns its own save (`Save mapping`, its footer,
 * which stays), so `write: null` is the honest answer here and the panel simply reports drafts —
 * `writable` stays true because the dock's own control is what decides whether saving is offered.
 */
export interface ProjectionPageLike {
    variation?: VariationThemeCell;
    version: number;
    coordinate: {
        channel: string;
        marketplace?: string;
        market?: string;
        accountId?: string | null;
        channelLabel?: string | null;
        label?: string;
    };
    vocabulary: {
        axisNoun: string;
        axisNounPlural: string;
        sectionTitle: string;
    };
    limits: {
        axes: number | null;
    };
    targetOptions: Array<{
        value?: string;
        code?: string;
        label: string;
        required?: boolean;
    }>;
    /** R-VT-7 — why the list is what it is. `'ok'` never accompanies an empty list. */
    targetOptionsState?: 'ok' | 'freeform' | 'unavailable' | 'no-theme';
    targetOptionsReason?: string | null;
    freeform: boolean;
    theme?: {
        value: string | null;
        options: Array<{
            code: string;
            label: string;
            deprecated?: boolean;
            coversAll?: boolean;
            drops?: string[];
            adds?: string[];
        }>;
    } | null;
    locked: {
        reason: string;
        externalId?: string | null;
        setChangeIs?: 'relist' | 'new-parent' | 'in-place';
        orderChangeAllowed?: boolean;
        /** VP.2 §4.1 — the axes this coordinate has already published. */
        lockedAxisKeys?: string[];
    } | null;
    axes?: Array<{
        key: string;
        label: string;
    }>;
    /** VP.2 §4.1 — the presentation order, relayed read-only by this endpoint. */
    order?: {
        writableHere: boolean;
        reason: string;
    };
}
export interface ProjectionDraftLike {
    mapping: Array<{
        axisKey: string;
        axisLabel?: string;
        target: string | null;
        order: number;
    }>;
    /**
     * R-VT-9 — AMAZON only: the theme the dock's picker chose, carried back so `saveMapping` can put it
     * in the PATCH body. `undefined` = this draft never touched a theme (every non-Amazon coordinate, and
     * an Amazon one the operator only reordered), and the save omits the field entirely rather than
     * sending `null`, which the route reads as "clear the theme".
     */
    theme?: string | null;
}
/**
 * R-VT-8 — the AG popup element a portalled panel must live inside, or `null` when there is none.
 *
 * Pure and exported so the node-only suite can pin the SELECTOR (`apps/web` vitest has no DOM, so the
 * element is injected). Two class names because AG uses `ag-popup-editor` for an editor popup and
 * `ag-popup` for the wrapper it sits in, and which one is the ancestor depends on `cellEditorPopup` and
 * the `popupParent`. Returning the nearest of either is correct for both.
 */
export declare function agPopupHostOf(el: {
    closest(selector: string): Element | null;
} | null | undefined): Element | null;
export declare const AG_POPUP_SELECTOR = ".ag-popup-editor, .ag-popup";
/** `ProjectionPage` + the dock's live draft → the cell this panel renders. */
export declare function axesCellFromProjection(page: ProjectionPageLike, draft: ProjectionDraftLike): VariationThemeCell;
/** The panel's edited cell → the dock's draft, PRESERVING every field the dock owns. */
export declare function projectionDraftFromAxesCell<D extends ProjectionDraftLike>(cell: VariationThemeCell, previous: D): D;
export interface AxesPanelEditorParams {
    value?: unknown;
    column?: {
        getActualWidth(): number;
    };
    stopEditing?: (cancel?: boolean) => void;
    /** AG 36's ONLY route from an editor to the grid. */
    onValueChange?: (value: unknown) => void;
    eGridCell?: HTMLElement;
    onPlanRequired?: AxesPanelProps['onPlanRequired'];
}
export declare function AxesPanelEditor(props: AxesPanelEditorParams): import("react/jsx-runtime").JSX.Element | null;
/** The text the grid shows for this cell — re-exported so a host never re-derives it. */
export { variationThemeText };
