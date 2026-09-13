import { type CSSProperties } from 'react';
import type { ListboxOption } from './Listbox';
export interface AsyncListboxPanelProps {
    label: string;
    query: string;
    onQueryChange: (query: string) => void;
    options: ListboxOption[];
    value?: string;
    loading?: boolean;
    error?: string;
    message?: string;
    placeholder?: string;
    emptyMessage?: string;
    onRetry?: () => void;
    onCommit: (value: string) => void;
    onCancel: () => void;
    style?: CSSProperties;
}
/** Search plus externally loaded choices. The caller owns fetching/filtering and popup placement. */
export declare function AsyncListboxPanel({ label, query, onQueryChange, options, value, loading, error, message, placeholder, emptyMessage, onRetry, onCommit, onCancel, style }: AsyncListboxPanelProps): import("react/jsx-runtime").JSX.Element;
