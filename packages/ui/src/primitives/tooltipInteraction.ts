export interface TooltipInteraction {
  open: boolean
  keyboardFocus: boolean
  suppressed: boolean
}

export type TooltipInteractionEvent =
  | 'pointer-enter' | 'pointer-move' | 'pointer-leave'
  | 'keyboard-focus' | 'pointer-focus' | 'blur'
  | 'dismiss' | 'keyboard-navigation'

/** Activation dismisses the hint until fresh pointer movement or keyboard navigation. */
export function nextTooltipInteraction(state: TooltipInteraction, event: TooltipInteractionEvent): TooltipInteraction {
  switch (event) {
    case 'pointer-enter': return { ...state, open: !state.suppressed }
    case 'pointer-move': return { ...state, open: true, suppressed: false }
    case 'pointer-leave': return { ...state, open: state.keyboardFocus && !state.suppressed }
    case 'keyboard-focus': return { ...state, open: !state.suppressed, keyboardFocus: !state.suppressed }
    case 'pointer-focus': return { ...state, open: false, keyboardFocus: false }
    case 'blur': return { ...state, open: false, keyboardFocus: false }
    case 'dismiss': return { ...state, open: false, keyboardFocus: false, suppressed: true }
    case 'keyboard-navigation': return { ...state, suppressed: false }
  }
}
