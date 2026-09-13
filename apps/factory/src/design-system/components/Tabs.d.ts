import { type ReactNode } from 'react';
export interface TabItem {
    id: string;
    label: ReactNode;
    /** SG.1 — optional count pill after the label (H10's tab-count treatment). `null` renders
     *  nothing (unknown ≠ zero); `0` renders a pill reading 0, which is a real answer. */
    count?: number | null;
    /** SG.1 — optional small promo/context badge between label and count (H10's "New" pill). */
    badge?: string;
    /** SG.1 — optional leading icon (H10 marks its A.I. tab). Sized by the caller (≤16px). */
    icon?: ReactNode;
    /** 9.3 — a tab that cannot be entered yet. Carries `disabled` + `aria-disabled` so the
     *  reason is reachable; never the only signal (the label should say why). */
    disabled?: boolean;
}
/**
 * Ids for the `tab` ↔ `tabpanel` pairing, so a caller can label its panel with the same base.
 *
 * ARIA wants the relationship stated from BOTH ends: the tab points at its panel with
 * `aria-controls`, and the panel points back with `aria-labelledby`. A tablist with neither — which
 * is what this component emitted until now — announces the tabs but never tells a screen-reader
 * user which region they govern.
 */
export declare function tabIds(base: string, tabId: string): {
    tab: string;
    panel: string;
};
/**
 * Spread onto the element rendering the active tab's content:
 * `<div {...tabPanelProps(base, active)}>`.
 */
export declare function tabPanelProps(base: string, activeTabId: string): {
    id: string;
    role: "tabpanel";
    'aria-labelledby': string;
    tabIndex: number;
};
export interface TabsProps {
    /**
     * Accessible name for the `tablist`. Same shape as `SegmentedControl`: a tablist with no name
     * is announced unlabelled, so the reader hears the tabs but not what they belong to.
     */
    ariaLabel?: string;
    tabs: TabItem[];
    active: string;
    onChange: (id: string) => void;
    className?: string;
    /**
     * SG.1 — 'lg' is the PAGE-level tab bar (H10's Suggestions/Analytics tabs: larger bolder
     * labels, 3px indicator, count pills at full weight). Default 'md' is byte-identical to the
     * original underline bar, so the existing consumers are untouched.
     *
     * CT.1 — 'sm' is a tab strip INSIDE a bar beside 28px controls (the studio's 40px scope row, the
     * record drawer's pane strip): the bar's type (sm-plus, 600), tabs stretched to the strip so the
     * indicator meets its edge, and no hairline of its own because the host draws one.
     */
    size?: 'sm' | 'md' | 'lg';
    /** Keep long labels within a narrow container; the active tab scrolls into view. */
    overflow?: 'scroll';
    /**
     * Shared id base for the `tab`/`tabpanel` pairing. Pass the same value to `tabPanelProps()` on
     * the element that renders the active tab's content.
     *
     * Optional so the ~dozen existing consumers are untouched: without it the bar emits no
     * `aria-controls`, exactly as before.
     */
    idBase?: string;
}
/** Underline tab bar (active = primary text + primary indicator). Controlled. */
export declare function Tabs({ ariaLabel, tabs, active, onChange, className, size, idBase, overflow }: TabsProps): import("react/jsx-runtime").JSX.Element;
