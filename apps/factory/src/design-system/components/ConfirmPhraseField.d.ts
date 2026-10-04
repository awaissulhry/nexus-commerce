import { type ReactNode } from 'react';
/** The one rule: the typed text equals the phrase, character for character. An empty phrase never matches. */
export declare function phraseMatches(typed: string, phrase: string): boolean;
export type PhraseMatchState = 'empty' | 'partial' | 'mismatch' | 'match';
/** Where the typing stands: nothing yet, a correct start, a mistake, or the exact phrase. */
export declare function phraseMatchState(typed: string, phrase: string): PhraseMatchState;
export declare const PHRASE_STATE_TEXT: Readonly<Record<PhraseMatchState, string>>;
export interface ConfirmPhraseFieldProps {
    /** The exact text to type: a SKU, an item number, a count. */
    phrase: string;
    value: string;
    onChange: (value: string) => void;
    /** The label. Default: "Type <phrase> exactly to confirm", with the phrase in bold. */
    label?: ReactNode;
    /** The input's id. Default: generated. */
    id?: string;
    className?: string;
    disabled?: boolean;
    autoFocus?: boolean;
}
export declare function ConfirmPhraseField({ phrase, value, onChange, label, id, className, disabled, autoFocus }: ConfirmPhraseFieldProps): import("react/jsx-runtime").JSX.Element;
