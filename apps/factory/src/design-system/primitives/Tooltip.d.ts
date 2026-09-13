import { type ReactNode } from 'react';
export interface TooltipProps {
    /** tooltip text/content shown above the trigger on hover/focus */
    label: ReactNode;
    className?: string;
    children: ReactNode;
    /** Escape scroll containers and sticky headers. Inherited from TooltipPortalProvider. */
    portal?: boolean;
}
/** Configure hints for a scrolling host. Disabled hosts render only the labelled triggers. */
export declare function TooltipPortalProvider({ children, disabled }: {
    children: ReactNode;
    disabled?: boolean;
}): import("react/jsx-runtime").JSX.Element;
/** Hover/focus tooltip. Scrolling hosts opt into a viewport-positioned portal. */
export declare function Tooltip({ label, className, children, portal }: TooltipProps): import("react/jsx-runtime").JSX.Element;
