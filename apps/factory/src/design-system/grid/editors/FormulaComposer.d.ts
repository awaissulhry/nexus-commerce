import { type FormulaCandidate } from './formulaEditing';
import { type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview';
export declare function FormulaComposer({ text, onChange, candidates, functions, preview, sourceLabel, disabled, allowText, onApply, onCancel, applyLabel, saveOnBlur, ariaLabel, linked, showModeHelp }: {
    text: string;
    onChange: (value: string) => void;
    candidates: readonly FormulaCandidate[];
    functions: FormulaFunctionDoc[];
    preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>;
    sourceLabel?: string;
    disabled?: boolean;
    allowText?: boolean;
    onApply?: (text: string) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    onCancel?: () => void;
    applyLabel?: string;
    saveOnBlur?: boolean;
    ariaLabel?: string;
    linked?: boolean;
    showModeHelp?: boolean;
}): import("react/jsx-runtime").JSX.Element;
