import { themeModeOf, type ThemeMode } from './theme'

/**
 * The page's ONE theme state: every control that shows or changes the theme (the top bar's button, the profile's
 * choice) reads this store, so a change anywhere shows everywhere at once. Plain module: the cookie and the `<html>`
 * class come in as functions, so the rules run in a Node test.
 */

export interface ThemeIo {
  /** The saved choice (the theme cookie's value), or undefined. */
  read(): string | undefined
  /** Saves a choice (the theme cookie). */
  write(mode: ThemeMode): void
  /** Draws a choice (`.dark` on `<html>`). */
  apply(mode: ThemeMode): void
}

export interface ThemeStore {
  /** The current choice: read once from the saved one, then what was set. */
  get(): ThemeMode
  set(mode: ThemeMode): void
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createThemeStore(io: ThemeIo): ThemeStore {
  let current: ThemeMode | null = null
  const listeners = new Set<() => void>()
  return {
    get() {
      if (current === null) current = themeModeOf(io.read())
      return current
    },
    set(mode) {
      io.write(mode)
      io.apply(mode)
      current = mode
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
