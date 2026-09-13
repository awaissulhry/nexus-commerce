import { type Applied, type FormulaCandidate } from './formulaEditing';
import type { FormulaPreviewResponse } from './formulaPreview';
export declare function useFormulaPreview(expr: string, preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>, enabled?: boolean): {
    response: FormulaPreviewResponse | null;
    inFlight: boolean;
    setResponse: import("react").Dispatch<import("react").SetStateAction<FormulaPreviewResponse | null>>;
    setInFlight: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    retry: () => void;
};
export declare function formulaSuggestions(text: string, caret: number, candidates: readonly FormulaCandidate[]): {
    token: import("./formulaEditing").RefToken | null;
    options: {
        value: string;
        label: string;
        searchText: string;
        title: string;
        group: string;
        trailing: string | undefined;
    }[];
    choose: (value: string) => Applied | null;
};
export declare function appendFormulaPart(text: string, part: string): Applied;
/** Shared text-building affordances for the sheet, record drawer, and bulk preview. */
export declare function FormulaGuidance({ text, sourceLabel, onChange, disabled, allowText, linked, showModeHelp, onInteractionChange }: {
    text: string;
    sourceLabel?: string;
    onChange: (next: Applied) => void;
    disabled?: boolean;
    allowText?: boolean;
    linked?: boolean;
    showModeHelp?: boolean;
    onInteractionChange?: (active: boolean) => void;
}): import("react/jsx-runtime").JSX.Element;
