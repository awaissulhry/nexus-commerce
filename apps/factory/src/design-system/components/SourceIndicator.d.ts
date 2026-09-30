export type ValueSourceKind = 'master' | 'override' | 'rule' | 'default' | 'missing' | 'linked' | 'channel' | 'formula' | 'ai' | 'warning';
export interface SourceIndicatorProps {
    kind: ValueSourceKind;
    label: string;
    description: string;
    /** Exact tooltip copy, including a native title when the host disables custom hints. */
    tooltip?: string;
    /** An action is offered only when both its description and handler are present. */
    actionLabel?: string;
    onAction?: () => void;
    /** Labels stay visible in legends; dense cells use the same icon with a tooltip. */
    showLabel?: boolean;
    /**
     * A routine source (a value that follows somewhere else) drawn in the muted text colour, so the cells that hold
     * their own value stand out on a dense sheet. Quieter, never hidden: the icon, its name and its action stay.
     */
    quiet?: boolean;
    tabIndex?: number;
}
/** A value's origin, with a hover/focus explanation that escapes scrolling grids. */
export declare function SourceIndicator({ kind, label, description, tooltip, actionLabel, onAction, showLabel, quiet, tabIndex }: SourceIndicatorProps): import("react/jsx-runtime").JSX.Element;
