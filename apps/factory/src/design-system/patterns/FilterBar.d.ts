import { type ReactNode } from 'react';
/**
 * FilterBar — the ONE declarative, config-driven filter bar for every grid
 * workspace (products, listings, fulfillment, pricing…). Pass a `dimensions`
 * array; the bar renders the collapsible Ad-Manager panel (built on
 * `FilterPanel`) with the right control per dimension — so feature pages own
 * *configuration*, never the bar's UI. Reproduces the campaigns-page filter bar
 * (`.h10-am-fpanel`) through DS tokens; change it here and every consumer
 * updates.
 */
export interface FilterBarOption {
    value: string;
    label: string;
    /** Optional facet count — rendered muted after the label. */
    count?: number;
}
export type FilterDimension = {
    key: string;
    label: ReactNode;
    kind: 'multiselect';
    options: FilterBarOption[];
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    /**
     * Always offer the in-popover search, whatever the option count. The picker adds one on
     * its own past seven options; a DATA-DRIVEN list (product types, brands, tags) is worth
     * searching at any size, because the operator is looking for a name, not scanning a menu.
     */
    searchable?: boolean;
    /** Span two columns of the 6-col grid. */
    wide?: boolean;
} | {
    key: string;
    label: ReactNode;
    kind: 'select';
    options: FilterBarOption[];
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    wide?: boolean;
} | {
    key: string;
    label: ReactNode;
    kind: 'range';
    min: string;
    max: string;
    onChange: (min: string, max: string) => void;
    unit?: '€' | '%' | '';
    wide?: boolean;
} | {
    key: string;
    label: ReactNode;
    kind: 'toggle';
    value: boolean;
    onChange: (next: boolean) => void;
    wide?: boolean;
};
export interface FilterBarProps {
    /** Panel title (default "Filters"). */
    title?: ReactNode;
    /** Declarative filter dimensions, rendered in order across the 6-col grid. */
    dimensions: FilterDimension[];
    /** Optional preset chips row above the field grid. */
    presets?: ReactNode;
    /** Clear-all handler; renders the footer "Clear" button (disabled when inactive). */
    onClear?: () => void;
    /** Count of active filters; disables Clear at 0. */
    activeCount?: number;
    /** Initial open state (default true — matches the campaigns grid). */
    defaultOpen?: boolean;
}
export declare function FilterBar({ title, dimensions, presets, onClear, activeCount, defaultOpen }: FilterBarProps): import("react/jsx-runtime").JSX.Element;
