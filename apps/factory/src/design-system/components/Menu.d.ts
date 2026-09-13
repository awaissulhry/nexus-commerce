import { type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import type { Tone } from '../primitives/tone';
export interface MenuItemDef {
    id: string;
    label?: ReactNode;
    icon?: ReactNode;
    tone?: Tone;
    disabled?: boolean;
    onSelect?: () => void;
    /**
     * Render this item as a real `<a>` rather than a `<button>`.
     *
     * A menu of destinations needs actual links: ⌘-click, middle-click and "Open in new tab" are all
     * swallowed by a `<button onClick={router.push}>`, and an operator who expects a link to behave
     * like one gets nothing. `onSelect` still fires (instrumentation, closing the menu), so a caller
     * can do both.
     */
    href?: string;
    /** `'_blank'` opens a new tab; `rel="noopener noreferrer"` is then applied automatically. */
    target?: '_blank' | '_self';
    /** Tooltip. Supplementary only — never the sole home of a reason; see `description`. */
    title?: string;
    /**
     * A second line under the label, for the reason an item is unavailable — or any note that
     * belongs to the item rather than to the menu.
     * A disabled item with `description != null` stays keyboard reachable but cannot activate.
     * A reasonless disabled item keeps its native disabled attribute and is skipped.
     *
     * 🔴 This is deliberately NOT a tooltip. A tooltip is hover-only: invisible to touch, invisible
     * to a keyboard user scanning the menu, and gone the moment the pointer moves. The whole point of
     * these rows is that a disabled item explains itself, and behind hover it explains itself only to
     * someone who already suspected there was something to find (hub rulings #133/#231 — an
     * instruction may never live only on a disabled control).
     *
     * The DS owns the wrap width, so every consumer wraps identically and no caller has to reach for
     * `white-space`. Before this existed, `Publish ▾` folded the reason into `label` as a second
     * nowrap span and the menu measured 617–629px wide for two items, with one line running 520.1px
     * beside a sibling that wrapped at 222.6px — two wrapping policies, 2.3× apart, in one menu.
     */
    description?: ReactNode;
    /**
     * Render a rule instead of an item. Everything else on the entry is ignored.
     *
     * The SP wizard's Select menu needed a divider between "by campaign kind" and "by match type";
     * without one the two groups read as one undifferentiated list.
     */
    separator?: boolean;
}
export interface MenuProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    selectedId?: string;
    onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: MenuItemDef) => void;
    /** trigger button content */
    label: ReactNode;
    items: MenuItemDef[];
    align?: 'left' | 'right';
    triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>;
    className?: string;
}
/**
 * Anchored dropdown menu (H10 `.h10-menu` look). The trigger renders as a DS
 * secondary button; the menu closes on outside-click or item select. Requires
 * `styles/primitives.css` (trigger) + `styles/components.css` (menu).
 */
export declare function Menu({ label, items, align, triggerProps, className, open: controlledOpen, onOpenChange, selectedId, onNavigate }: MenuProps): import("react/jsx-runtime").JSX.Element;
