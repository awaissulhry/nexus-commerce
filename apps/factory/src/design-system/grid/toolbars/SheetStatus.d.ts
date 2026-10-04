export interface SheetStatus {
    tone: 'neutral' | 'info' | 'warning' | 'danger';
    label: string;
    detail?: string;
    /**
     * Makes the mark a control: "2 rejected on Amazon · IT" shows those rows. Without it the mark only reports.
     * An action in the "+N" overflow is not reachable from the mark, so keep the same action available elsewhere
     * (a filter, a menu) — the mark is a shortcut, never the only way.
     */
    onSelect?: () => void;
    /** What `onSelect` does, read after the label and detail: "Show these rows". */
    actionLabel?: string;
    /** The action is engaged (a filter that is on): emits `aria-pressed`. Needs `onSelect`. */
    selected?: boolean;
}
export interface SheetStatusesProps {
    status?: readonly SheetStatus[];
    compact?: boolean;
}
/**
 * Which marks stay on the bar. Severity outranks order: a `danger` mark never folds into "+N" — not under the
 * three-mark cap and not on the host's compact tier. Only the other tones fold. Original order is kept.
 */
export declare function partitionSheetStatuses(status: readonly SheetStatus[], compact: boolean): {
    visible: SheetStatus[];
    folded: SheetStatus[];
};
/** At most three visible marks, and every danger mark. Every folded sentence remains keyboard reachable on "+N". */
export declare function SheetStatuses({ status, compact }: SheetStatusesProps): import("react/jsx-runtime").JSX.Element;
