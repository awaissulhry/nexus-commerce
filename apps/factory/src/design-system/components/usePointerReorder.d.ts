import { type HTMLAttributes } from 'react';
/** Pointer capture for a reorder grip. The caller supplies the equivalent keyboard action. */
export declare function usePointerReorder({ disabled, horizontal, onMove }: {
    disabled?: boolean;
    horizontal?: boolean;
    onMove(from: number, to: number): void;
}): {
    dragging: number | null;
    cancel: () => void;
    handleProps: (index: number) => HTMLAttributes<HTMLElement>;
};
