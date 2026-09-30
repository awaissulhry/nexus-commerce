export interface TagInputProps {
    value: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string;
    suggestions?: string[];
    disabled?: boolean;
    className?: string;
    maxTags?: number;
    'aria-label'?: string;
    /** Text the field starts with — the key that opened a grid cell by typing (AG's `eventKey`), which the grid consumed. */
    initialInput?: string;
}
export declare function TagInput({ value, onChange, placeholder, suggestions, disabled, className, maxTags, 'aria-label': ariaLabel, initialInput, }: TagInputProps): import("react/jsx-runtime").JSX.Element;
