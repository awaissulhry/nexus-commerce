import { type ReactNode } from 'react';
export interface MediaCardProps {
    src?: string | null;
    /** A file-type or processing placeholder when the source has no image preview. */
    placeholder?: ReactNode;
    mediaType?: string;
    label: string;
    detail?: ReactNode;
    marker?: ReactNode;
    onPreview(): void;
    selected?: boolean;
    onSelectedChange?(selected: boolean): void;
    disabled?: boolean;
    actions?: ReactNode;
}
/** Uncropped image, explicit failure, independent preview/selection/actions. */
export declare function MediaCard({ src, placeholder, mediaType, label, detail, marker, onPreview, selected, onSelectedChange, disabled, actions }: MediaCardProps): import("react/jsx-runtime").JSX.Element;
export interface MediaGalleryItem {
    id: string;
    src?: string | null;
    label: string;
    detail?: ReactNode;
    mediaType?: string;
    placeholder?: ReactNode;
}
export interface MediaGalleryProps {
    label: string;
    items: readonly MediaGalleryItem[];
    onChange(ids: string[]): void;
    onRemove?(id: string): void;
    onPreview(id: string): void;
    disabled?: boolean;
    firstLabel?: string;
    /** Expose an explicit one-based position selector when arbitrary moves are needed. */
    positionControls?: boolean;
    /** Featured first tile and compact contextual actions for an anchored editor. */
    compact?: boolean;
}
/** Controlled gallery; drag and labelled move buttons perform the identical reorder. */
export declare function MediaGallery({ label, items, onChange, onRemove, onPreview, disabled, firstLabel, positionControls, compact }: MediaGalleryProps): import("react/jsx-runtime").JSX.Element;
