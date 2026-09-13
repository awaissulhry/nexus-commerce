/**
 * GDS — the cell library. Every renderer here is memoised, null-safe, and a `ColDef` fragment away
 * from use (`../columns/presets.ts`). A page composes these; it does not write its own money cell.
 *
 * The rule every one of them enforces: an UNMEASURED value (`null`) and a MEASURED zero are
 * different facts and render differently — `formatGridValue` decides which, the cell draws it.
 * `EmptyValue` is the dash: muted, and it carries a `title` ONLY when the zero was measured.
 *
 * Styling: `../theme/grid.css` (`.nds-grid-*`), tokens from `tokens/grid.ts`. No CSS module, so
 * the cell reads the same in a page card, a modal and a drawer.
 */
import { type ReactNode } from 'react';
import type { ICellRendererParams, IRowNode } from 'ag-grid-community';
import { type Tone } from '../../primitives';
import { type MenuItemDef } from '../../components';
import { type FormatOptions, type GridValueKind } from './format';
import { type LongTextCaps } from './longTextState';
import { type RowReadinessState, type ScopeReadinessState } from './readiness';
/**
 * 🔴 A UNION, not two optional fields — a measured zero MUST say what was measured.
 *
 * The old shape was `{ measuredZero?: boolean; title?: string }`, which let `<EmptyValue
 * measuredZero />` compile and render `aria-label={undefined}`: an element whose only content is an
 * em-dash and which has **no accessible name at all**. The unmeasured case, meanwhile, was named
 * "Not measured". So a screen-reader user heard a name for the value we know nothing about and
 * silence for the one we measured — the exact inversion of this component's purpose, in the
 * component that exists to make that distinction audible.
 *
 * Found by FE.1 writing a probe (hub #313), latent not live: all 8 `zero: 'dash'` call sites pass a
 * `zeroTitle` today, so discipline was holding and no operator was affected. The type is what
 * permitted it, so the type is what changed — the incorrect call is now a compile error rather than
 * a silent gap that no sighted review can see.
 */
export type EmptyValueProps = {
    measuredZero: true;
    title: string;
} | {
    measuredZero?: false;
    title?: never;
};
export declare const EmptyValue: import("react").NamedExoticComponent<EmptyValueProps>;
export interface NumericCellParams extends FormatOptions {
    kind?: GridValueKind;
    /** The title a measured zero shows under `zero: 'dash'` — say what was measured. */
    zeroTitle?: string | ((data: unknown) => string);
    muted?: boolean;
}
export declare const NumericCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & NumericCellParams>;
export interface DateCellParams {
    muted?: boolean;
}
export declare const DateCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & DateCellParams>;
export interface BadgeCellParams {
    /** value → pill. A value with no entry renders the fallback tone with the raw value as label. */
    tones: Record<string, {
        tone: Tone;
        label: string;
    }>;
    fallbackTone?: Tone;
    size?: 'sm' | 'md';
}
export declare const BadgeCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & BadgeCellParams>;
export interface LockedCellParams {
    kind?: GridValueKind;
    /** Why it is read-only — the lock's accessible name. */
    reason?: string;
}
export declare const LockedCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & LockedCellParams>;
export interface LinkCellParams {
    href: (data: unknown) => string;
    /** Same-tab title link, plus a hover-revealed "Open" pill that opens a NEW tab (the products page's shape). */
    openPill?: boolean;
}
export declare const LinkCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & LinkCellParams>;
export type StockLevel = 'out' | 'low' | 'ok';
export interface StockCellParams {
    /** The level for a value; default: ≤0 out, ≤ threshold(data) low, else ok. */
    level?: (value: number, data: unknown) => StockLevel;
    threshold?: (data: unknown) => number;
}
export declare const stockLevel: (value: number, threshold: number) => StockLevel;
export declare const StockCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & StockCellParams>;
export declare const DeltaChip: import("react").NamedExoticComponent<{
    delta: number;
}>;
export interface GroupCellProps {
    label: string;
    count: number;
    noun?: [singular: string, plural: string];
}
export declare const GroupCell: import("react").NamedExoticComponent<GroupCellProps>;
export interface GridTag {
    id: string;
    name: string;
    icon?: string | null;
    color?: string | null;
}
export interface TagsCellParams {
    /** Glyphs shown before the "+N" overflow (default 6). */
    max?: number;
}
export declare const TagsCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & TagsCellParams>;
/** `value` is `CoverageChannel[]` — the page's valueGetter computes it from its own data shape. */
export declare const CoverageCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any>>;
export interface ActionsCellParams<T = unknown> {
    /** The one visible button (Edit). A link when `href` is given. */
    primary?: {
        label: ReactNode;
        href?: (data: T) => string;
        onClick?: (data: T) => void;
    };
    /** The ⋯ menu. */
    items?: (data: T) => MenuItemDef[];
    /** Accessible name for the ⋯ trigger. */
    menuLabel?: (data: T) => string;
}
declare function ActionsCellImpl<T>(p: ICellRendererParams<T> & ActionsCellParams<T>): import("react/jsx-runtime").JSX.Element | null;
export declare const ActionsCell: typeof ActionsCellImpl;
export type IdentityChipTone = 'auto' | 'manual' | 'program' | 'neutral' | 'accent';
export interface IdentityChipProps {
    /** One or two characters — `A`, `M`, `SP`. */
    label: ReactNode;
    tone?: IdentityChipTone;
    /** The hover explanation; a chip with no tip is a mark nobody can read. */
    tip?: string;
}
/**
 * A 20×20 square chip that sits BEFORE the title in an identity cell, never in a column of its
 * own: targeting (A/M, filled), programme (SP/SB/SD, outlined), an accent mark (a lightbulb).
 * The Ad Manager drew these in its campaign cell; this is that cell's chip, on the tokens.
 */
export declare const IdentityChip: import("react").NamedExoticComponent<IdentityChipProps>;
export declare const TargetingChip: import("react").NamedExoticComponent<{
    targeting: "A" | "M" | "AUTO" | "MANUAL";
}>;
export declare const ProgramChip: import("react").NamedExoticComponent<{
    program: "SP" | "SB" | "SD" | string;
}>;
/**
 * The cap fields as the WIRE states them — `LongTextCellParams` is re-exported from
 * `longTextState.ts` so the rule and the renderer cannot disagree about their shape.
 *
 * 🔴 The old props were `{ maxLength, countBytes }`: a cap plus a UNIT FLAG. That shape is what let
 * a byte cap be dropped — `product_description` carries `maxBytes: 20000` and reached this cell as
 * `countBytes: true` with `maxLength: undefined`, so it counted bytes against nothing and reported
 * the field as fine. Taking the raw caps removes the shape that made the loss expressible.
 */
export type { LongTextCaps as LongTextCellParams } from './longTextState';
/**
 * The save reason as TEXT inside the cell, visually hidden.
 *
 * 🔴 The tooltip is a HOVER overlay. A screen reader gets nothing from it, a keyboard-only operator
 * gets nothing from it, and — measured the hard way — a DOM probe walking the cell finds nothing
 * either, which is how the reason came to be reported as unrendered when it was merely unhoverable
 * (#662). This node is the second route: same string as the tooltip's first paragraph, because both
 * read the tracker's `reason` rather than each phrasing it.
 *
 * `.nds-vh` is the DS's clip utility (#657) — NOT `display:none`, which would remove it from the
 * accessibility tree and leave this component doing nothing at all while looking like it worked.
 */
export declare function CellSaveReason({ reason }: {
    reason?: string;
}): import("react/jsx-runtime").JSX.Element | null;
/**
 * An EMPTY cell that a channel REQUIRES on this row — the one glyph, the one class, the one name,
 * for every renderer on every scope. Master rendered this span inline and the channel scopes
 * rendered `—` for the same state (measured 2026-09-04); each sheet now decides WHETHER (the shared
 * `columnRequiredByAny`) and this decides HOW it looks.
 */
export declare function RequiredValue(): import("react/jsx-runtime").JSX.Element;
export declare const LongTextCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & LongTextCaps>;
/**
 * Re-exported from `readiness.ts`, which is the ONE tone/label source for both readiness
 * vocabularies (programme §3). The private table that used to live here is gone: it was a second
 * copy, in a `.tsx` the node-environment test suite cannot reach.
 */
export type ReadinessState = RowReadinessState;
export interface ReadinessValue {
    state: ReadinessState;
    /** What is missing or wrong — the tooltip and the count. */
    issues?: string[];
    /** A live listing's channel id (ASIN, eBay item id) when `live`. */
    ref?: string;
}
/**
 * Per channel × market: can this row ship? `value` is a `ReadinessValue` the page computes (from the
 * publish validator / readiness service). A count on the pill, the reasons on hover.
 */
export declare const ReadinessCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any>>;
/**
 * LX.FIN (R-LX-22) — the SCOPE vocabulary's cell, beside the row vocabulary's `ReadinessCell`.
 *
 * 🔴 Two cells, not one with a `vocabulary` prop, for the same reason `readinessMeta` takes the
 * vocabulary explicitly rather than defaulting: a cell that could be pointed at either table would
 * eventually be pointed at the wrong one, and `ready` is the one word both tables share — so the
 * mistake would render correctly on the happy path and print `blocked` as an unrecognised state
 * only on the rows an operator most needs. `ReadinessCell` stays hard-wired to `'row'`.
 *
 * It lives in the ENGINE because the same verdict is already rendered by hand in two page-local
 * places (`products/next/languageColumns.tsx`, `products/listing-readiness/page.tsx`, both a bare
 * `Tag` around `readinessMeta(state,'scope')` in a non-AG table). This is the AG-grid host for it.
 *
 * `value == null` is NOT "ready" and not 0%: it means no `ReadinessIndex` row exists for this
 * coordinate and language, so it renders the vocabulary's own `notComputed` — absent is not empty
 * (R-LX-9).
 */
export interface ScopeReadinessValue {
    state: ScopeReadinessState;
    /** `null` when the scope could not be scored; never coerced to 0. */
    pct?: number | null;
    /** The server's own sentence, verbatim — never re-templated here. */
    note?: string;
}
export declare const ScopeReadinessCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any>>;
export interface FollowsCellParams {
    /** The label of what is followed (default "master"). */
    of?: string;
}
/**
 * The follows-master control beside a per-market value (FFD10): a per-market cell is a PROJECTION,
 * and writing it while the market still follows master is a silent no-op. This cell says which it
 * is — `Follows master` or `Pinned` — and the page flips the flag when the value is edited.
 */
export declare const FollowsCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & FollowsCellParams>;
export interface IdentityCellProps {
    image?: string | null;
    photoCount?: number;
    /** The title line. A string becomes the same-tab link when `href` is given. */
    title: ReactNode;
    href?: string;
    /** Hover-revealed "Open" pill that opens `href` in a NEW tab. */
    openPill?: boolean;
    /** The sub-line: SKU, tags, counts — the caller's own nodes. */
    sub?: ReactNode;
    /** Sits before the thumbnail (an expander, a drag handle). */
    leading?: ReactNode;
    /** `title` attribute on the link — the full name when the visible one truncates. */
    titleAttr?: string;
    /** Hide the image column entirely (SKU-first rows without artwork). */
    noImage?: boolean;
}
/**
 * photo · title / sub-line — the identity cell every catalogue-style grid draws. Geometry is the
 * products page's, measured: 11px gaps, the title a `--nds-primary` semibold ellipsis at 330px max.
 */
export declare const IdentityCell: import("react").NamedExoticComponent<IdentityCellProps>;
/** The monospace SKU in a sub-line. */
export declare const SkuTag: import("react").NamedExoticComponent<{
    children: ReactNode;
}>;
/** The 20px chevron that expands a tree row, and the slot that keeps a leaf aligned. */
export interface ExpandButtonProps {
    expanded: boolean;
    onToggle: () => void;
    labels?: [collapsed: string, expanded: string];
}
/**
 * Whether an AG row node is expanded, as a subscription.
 *
 * 🔴 AG re-renders a cell renderer on expand, but it does NOT re-run it with a fresh `node.expanded`
 * in every path, so a renderer that reads `node.expanded` once draws a chevron that stops matching
 * the tree it controls. The node's own `expandedChanged` event is the only reliable source.
 *
 * In the ENGINE because both sheets' identity band owns the expander now (#719): master had this
 * hook privately and the channel scope was about to need its own copy, which is the fork the
 * shared-component rule exists to prevent — two subscriptions to one AG behaviour, drifting apart
 * the first time AG changes when it fires.
 */
export declare function useExpanded(node: IRowNode): boolean;
export declare const ExpandButton: import("react").NamedExoticComponent<ExpandButtonProps>;
export declare const ExpandSlot: import("react").NamedExoticComponent<object>;
