import { type OptionListItem } from './OptionList';
/** The list's item shape, aliased so this component and `OptionList` cannot drift apart. */
export type MultiSelectOption = OptionListItem;
export interface MultiSelectProps {
    options: MultiSelectOption[];
    value: string[];
    onChange: (next: string[]) => void;
    /** label shown when nothing is selected (default "All") */
    placeholder?: string;
    className?: string;
    ariaLabel?: string;
    /** force the in-popover search box; it otherwise appears past OptionList's threshold */
    searchable?: boolean;
    searchPlaceholder?: string;
}
/**
 * Checkbox multi-select dropdown (H10 `.h10-ms`): "All" / "N selected" + Select-all.
 *
 * The TRIGGER, the label and the popover placement live here; the list inside the popover is
 * `OptionList`, shared with the grid's column-menu set filter so the two controls are the same
 * control and not two files that agree today. See `OptionList` for why.
 */
export declare function MultiSelect({ options, value, onChange, placeholder, className, ariaLabel, searchable, searchPlaceholder }: MultiSelectProps): import("react/jsx-runtime").JSX.Element;
