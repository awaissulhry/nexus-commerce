export interface MediaSource {
    url: string;
    mimeType?: string;
}
export interface MediaCaption {
    url: string;
    language: string;
    label: string;
    default?: boolean;
}
export interface MediaPreviewProps {
    type: string;
    url?: string | null;
    poster?: string | null;
    label: string;
    sources?: readonly MediaSource[];
    captions?: readonly MediaCaption[];
    transcript?: string | null;
}
/** Link and media URLs never accept executable protocols. Relative URLs support local assets. */
export declare function mediaUrl(value?: string | null): string | undefined;
export declare function mediaTypeLabel(type: string): string;
/** Image-only data URLs support existing catalog and local preview consumers. Never used for links. */
export declare function mediaImageUrl(value?: string | null): string | undefined;
export declare function MediaTypeIcon({ type, size }: {
    type: string;
    size?: number;
}): import("react/jsx-runtime").JSX.Element;
/** Original aspect ratio; playback starts only on request. Unknown formats retain a safe file link. */
export declare function MediaPreview(props: MediaPreviewProps): import("react/jsx-runtime").JSX.Element;
