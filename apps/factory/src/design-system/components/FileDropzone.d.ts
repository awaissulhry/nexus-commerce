/**
 * FileDropzone — a generic file picker (drag-drop + click + keyboard). Validates type
 * (against the `accept` extension list) and size (`maxBytes`) client-side, then hands the
 * accepted File[] to `onFiles`; the caller owns the upload/parse transport. The non-image
 * sibling of ImageUpload — no preview, used for CSV/TSV/XLSX/JSON imports and the like.
 * Requires `styles/components.css`.
 */
import { type ReactNode } from 'react';
export interface FileDropzoneProps {
    /** Called with the validated files. */
    onFiles: (files: File[]) => void;
    /** Comma-separated extension list (e.g. '.csv,.tsv,.xlsx,.xls,.json'). Empty = any. */
    accept?: string;
    /** Client-side max size guard per file (bytes). */
    maxBytes?: number;
    /** Allow selecting more than one file. */
    multiple?: boolean;
    disabled?: boolean;
    /** Secondary line — defaults to the accepted formats + size limit. */
    hint?: ReactNode;
    className?: string;
}
export declare function FileDropzone({ onFiles, accept, maxBytes, multiple, disabled, hint, className }: FileDropzoneProps): import("react/jsx-runtime").JSX.Element;
