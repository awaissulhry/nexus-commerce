export interface IconPickerProps {
    /** The chosen icon id, or null for the plain dot. */
    value?: string | null;
    onChange: (icon: string | null) => void;
    /** Tints the options, so the choice is previewed in the colour the tag will actually wear. */
    color?: string | null;
    ariaLabel?: string;
    disabled?: boolean;
    className?: string;
}
export declare function IconPicker({ value, onChange, color, ariaLabel, disabled, className }: IconPickerProps): import("react/jsx-runtime").JSX.Element;
