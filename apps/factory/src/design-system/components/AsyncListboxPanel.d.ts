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
    /**
     * Enter or Tab chose the highlighted choice, reported in the capture phase so a grid commits it and moves (Enter down,
     * Tab right), exactly as `ListboxPanel.onKeyChoice` does — `end` included. Enter with a search and nothing highlighted
     * (the choices are still loading) keeps the panel open. Absent, Enter commits here and Tab leaves, as they always did.
     */
    onKeyChoice?: (value: string | null, end?: KeyboardEvent) => void;
    /** Names the stored value when the loaded choices do not include it ("Current: …"); absent, nothing is shown. */
    currentLabel?: string;
    /**
     * A row above the choices that empties the value (`SELECT_CLEAR_LABEL`), as `ListboxPanel.emptyLabel`: ↑ from the first
     * choice reaches it, and Enter / Tab / a click choose `''`. Shown while a stored value can be cleared even when no
     * choice is loaded yet (an eBay category before the 2-character search). Not added when a choice is already `''`.
     */
    emptyLabel?: string;
    style?: CSSProperties;
}
export declare function AsyncListboxPanel({ label, query, onQueryChange, options, value, loading, error, message, placeholder, emptyMessage, onRetry, onCommit, onCancel, onKeyChoice, currentLabel, emptyLabel, style }: AsyncListboxPanelProps): import("react/jsx-runtime").JSX.Element;
