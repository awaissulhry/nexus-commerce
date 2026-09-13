import { type ReactNode } from 'react';
import { type ActionImpact } from '../grid/actions/registry';
import type { AskToConfirm } from '../grid/actions/runAction';
export interface ActionConfirmProps {
    impact: ActionImpact;
    onConfirm: () => void;
    onCancel: () => void;
    /** Inline review keeps the same arming rules; the host owns its enclosing dialog. */
    mode?: 'modal' | 'inline';
}
/** Kept pure so direct hook users and registry users share the same safety boundary. */
export declare function canConfirmAction(impact: ActionImpact, typed: string, acknowledged: boolean): boolean;
/** Itemised consequences, exact subject typing, visible instructions and explicit acknowledgement. */
export declare function ActionConfirm({ impact, onConfirm, onCancel, mode }: ActionConfirmProps): import("react/jsx-runtime").JSX.Element;
export interface ActionConfirmApi {
    ask: AskToConfirm;
    element: ReactNode;
}
export declare function useActionConfirm(): ActionConfirmApi;
