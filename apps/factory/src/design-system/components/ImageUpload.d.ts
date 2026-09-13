export interface ImageUploadCriterion {
    label: string;
    value: string;
}
export interface ImageUploadProps {
    value: string | null;
    onChange: (url: string | null) => void;
    /** Upload transport — receives the validated File, resolves to the stored URL. */
    onUpload: (file: File) => Promise<string>;
    label?: string;
    criteria?: ImageUploadCriterion[];
    /** Comma-separated accept list (default PNG/JPG). */
    accept?: string;
    /** Client-side max size guard (bytes). */
    maxBytes?: number;
    /** Minimum pixel dimensions (the image must be at least this big). */
    minWidth?: number;
    minHeight?: number;
    /** CSS aspect-ratio for the preview/zone box (e.g. '1 / 1', '1200 / 628'). */
    aspect?: string;
    /** Optional "Select from assets" action (DAM browse). */
    onSelectFromAssets?: () => void;
    disabled?: boolean;
    className?: string;
}
export declare function ImageUpload({ value, onChange, onUpload, label, criteria, accept, maxBytes, minWidth, minHeight, aspect, onSelectFromAssets, disabled, className }: ImageUploadProps): import("react/jsx-runtime").JSX.Element;
