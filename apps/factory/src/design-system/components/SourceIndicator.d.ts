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
    tabIndex?: number;
}
/** A value's origin, with a hover/focus explanation that escapes scrolling grids. */
export declare function SourceIndicator({ kind, label, description, tooltip, actionLabel, onAction, showLabel, tabIndex }: SourceIndicatorProps): import("react/jsx-runtime").JSX.Element;
