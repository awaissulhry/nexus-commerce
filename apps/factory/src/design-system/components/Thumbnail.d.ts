export interface ThumbnailProps {
    src: string | null;
    /** Total gallery image count; the hover preview says "1 of N" when > 1. */
    photoCount?: number;
    alt?: string;
    /** Hovering opens a 320px preview after a 400ms dwell. Default true. */
    hoverPreview?: boolean;
    /** When set the thumb is a button; otherwise a plain box. */
    onClick?: () => void;
    /** Overrides the button's title / aria-label. */
    title?: string;
}
declare function ThumbnailImpl({ src, photoCount, alt, hoverPreview, onClick, title }: ThumbnailProps): import("react/jsx-runtime").JSX.Element;
export declare const Thumbnail: import("react").MemoExoticComponent<typeof ThumbnailImpl>;
export {};
