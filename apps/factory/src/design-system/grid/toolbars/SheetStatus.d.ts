export interface SheetStatus {
    tone: 'neutral' | 'info' | 'warning' | 'danger';
    label: string;
    detail?: string;
}
export interface SheetStatusesProps {
    status?: readonly SheetStatus[];
    compact?: boolean;
}
/** At most three visible marks. Every surplus sentence remains keyboard reachable. */
export declare function SheetStatuses({ status, compact }: SheetStatusesProps): import("react/jsx-runtime").JSX.Element;
