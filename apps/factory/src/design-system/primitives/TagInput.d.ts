export interface TagInputProps {
    value: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string;
    suggestions?: string[];
    disabled?: boolean;
    className?: string;
    maxTags?: number;
    'aria-label'?: string;
}
export declare function TagInput({ value, onChange, placeholder, suggestions, disabled, className, maxTags, 'aria-label': ariaLabel, }: TagInputProps): import("react/jsx-runtime").JSX.Element;
