import { type ReactNode } from 'react';
export interface OrderedListProps {
    label: string;
    items: readonly string[];
    onChange: (items: string[]) => void;
    renderItem?: (item: string) => ReactNode;
    /** Human-readable control names and announcements while items retain stable IDs. */
    itemLabel?: (item: string) => string;
    disabled?: boolean;
    /** Use the focusable grip with ArrowUp/ArrowDown instead of separate arrow buttons. */
    keyboardGrip?: boolean;
    /** Unboxed 28px rows for compact mapping forms. */
    compact?: boolean;
    draggable?: boolean;
}
/** Controlled ordering with equivalent pointer and keyboard actions; identities remain stable. */
export declare function OrderedList({ label, items, onChange, renderItem, itemLabel, disabled, draggable, keyboardGrip, compact }: OrderedListProps): import("react/jsx-runtime").JSX.Element;
