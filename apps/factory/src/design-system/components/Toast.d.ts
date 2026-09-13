import { type ReactNode } from 'react';
import type { Tone } from '../primitives/tone';
export interface ToastApi {
    /** `opts.duration` overrides the provider default for ONE toast — a toast carrying an
     *  interactive verb (an Undo) needs more time on screen than a plain receipt. */
    toast: (message: ReactNode, tone?: Tone, opts?: {
        duration?: number;
    }) => void;
}
/** Wrap the app (or a subtree) once; renders a bottom-center toast viewport. */
export declare function ToastProvider({ children, duration }: {
    children: ReactNode;
    duration?: number;
}): import("react/jsx-runtime").JSX.Element;
/**
 * `const { toast } = useToast()`.
 *
 * Works with or without a `<ToastProvider>` — but mount one. See the note above for why the
 * fallback exists and why it complains.
 */
export declare function useToast(): ToastApi;
