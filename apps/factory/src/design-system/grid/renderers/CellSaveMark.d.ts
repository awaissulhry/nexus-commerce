import type { CellSaveState } from '../editors/roundTrip';
export interface CellSaveMarkProps {
    state: CellSaveState | null | undefined;
}
/** Shape and words distinguish identical waiting/unknown washes without a new tab stop. */
export declare function CellSaveMark({ state }: CellSaveMarkProps): import("react/jsx-runtime").JSX.Element | null;
