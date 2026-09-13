export interface TooltipInteraction {
    open: boolean;
    keyboardFocus: boolean;
    suppressed: boolean;
}
export type TooltipInteractionEvent = 'pointer-enter' | 'pointer-move' | 'pointer-leave' | 'keyboard-focus' | 'pointer-focus' | 'blur' | 'dismiss' | 'keyboard-navigation';
/** Activation dismisses the hint until fresh pointer movement or keyboard navigation. */
export declare function nextTooltipInteraction(state: TooltipInteraction, event: TooltipInteractionEvent): TooltipInteraction;
