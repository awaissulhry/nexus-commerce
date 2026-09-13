export interface MediaStripItem {
    id: string;
    type: string;
    preview?: string | null;
    alt?: string;
}
export interface MediaStripProps {
    items: readonly MediaStripItem[];
    label: string;
    limit?: number;
    emptyLabel?: string;
    /** Optional in-cell reorder. The cell's Enter/F2 editor supplies the keyboard equivalent. */
    onReorder?(ids: string[]): void;
    onFocusCell?(): void;
    onOpen?(): void;
}
/** Non-interactive cell content. The grid supplies its own edit trigger and keyboard contract. */
export declare function MediaStrip({ items, label, limit, emptyLabel, onReorder, onFocusCell, onOpen }: MediaStripProps): import("react/jsx-runtime").JSX.Element;
