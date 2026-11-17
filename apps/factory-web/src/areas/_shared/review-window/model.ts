/**
 * B-TH-271 (threads plan PL6, picture 40) — the pure rule of a window's docked thread: shown beside the content (`docked`), folded
 * to a slim "Add a note" column (`folded`: an office-only thread with nothing written yet, until a person opens it), or no thread
 * column at all (`alone`: the person does not read threads here). A thread with a party never folds (a customer's answer is seen).
 */
export type WindowLayout = 'alone' | 'docked' | 'folded'

export function windowLayout(input: { readonly hasThread: boolean; readonly notesOnly: boolean; readonly empty: boolean; readonly opened: boolean }): WindowLayout {
  if (!input.hasThread) return 'alone'
  return input.notesOnly && input.empty && !input.opened ? 'folded' : 'docked'
}

/** The window's own keys stay quiet while the focus is inside its thread (the thread has its own: J / K, R, N). */
export const inWindowThread = (target: EventTarget | null): boolean => !!(target as HTMLElement | null)?.closest?.('.fw-rw-thread')
