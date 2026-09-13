import type { HTMLAttributes, ReactNode } from 'react';
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
    /** padded body (ignored when `header` is set — header layout has its own padding) */
    padded?: boolean;
    /** resting card shadow */
    elevated?: boolean;
    /** optional header title; renders a bordered head + padded body */
    header?: ReactNode;
    /** 9.3 — sub-line under the header title. 105 call sites across the platform wanted one and
     *  had to keep a second Card implementation to get it. Ignored without `header`. */
    description?: ReactNode;
    /** optional right-aligned header slot (e.g. an action button) */
    headerAction?: ReactNode;
    /**
     * Makes the whole card a `<button>` — a KPI tile that filters a chart, a card that scrolls to
     * its section. Four surfaces hand-rolled this because `Card` was not interactive and `Button`
     * is not a card (`.hl-tile`, `.rpt-kpi` and two more).
     *
     * ⚠️ A card with an interactive `headerAction` must NOT also take `onClick` — a button inside
     * a button is invalid HTML and browsers resolve it unpredictably. Put the click on the action
     * or on the card, never both.
     */
    onClick?: () => void;
    /** engaged state for a tile that toggles something; emits `aria-pressed`. Needs `onClick`. */
    pressed?: boolean;
    children?: ReactNode;
    className?: string;
}
/** Surface container (H10 panel/`.h10-am-card` look). */
export declare function Card({ padded, elevated, header, description, headerAction, onClick, pressed, children, className, ...rest }: CardProps): import("react/jsx-runtime").JSX.Element;
