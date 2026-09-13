export interface ComboboxOption {
    value: string;
    label: string;
}
export interface ComboboxProps {
    options: ComboboxOption[];
    value?: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
}
/** Single-select typeahead (H10 `.h10-combo`): filter-as-you-type + pick. */
export declare function Combobox({ options, value, onChange, placeholder, className }: ComboboxProps): import("react/jsx-runtime").JSX.Element;
