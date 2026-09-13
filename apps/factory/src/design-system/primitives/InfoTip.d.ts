/**
 * W6 (2026-08-20) — PROMOTED into the design system from
 * `app/marketing/ads/campaigns/InfoTip.tsx`, verbatim: 27 files across the ads console already
 * import it by relative path (the old path re-exports this one, so none of them changed), and it
 * is the only tooltip in the app that survives a scrolling container — the DS `Tooltip` and
 * `HoverCard` are CSS-positioned and clip at any `overflow: auto` pane edge.
 *
 * Styles: `.h10-tip` / `.h10-tipwrap` live in `design-system/styles/primitives.css` (moved from
 * `ads.css`, which now loads primitives.css tree-wide from the ads layout). Page-contextual icon
 * colouring stays where the context is — e.g. `.h10-am-fpanel .ffield > span .info` in ads.css.
 *
 * 🔴 House rules this component already embodies — keep them on any edit:
 *   · the cursor NEVER changes on hover ([[feedback_no_help_cursor]] — the question-mark cursor
 *     is banned repo-wide, ratcheted at zero);
 *   · portal to document.body, position: fixed, measured + viewport-clamped (flips top/bottom,
 *     arrow tracks the icon via --ax) — CSS positioning is what it exists to avoid;
 *   · with `children` it wraps an existing control and must NOT add a second tab stop or a
 *     second accessible name.
 */
import { type ReactNode } from 'react';
export declare function InfoTip({ tip, size, children }: {
    tip: string;
    size?: number;
    children?: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
