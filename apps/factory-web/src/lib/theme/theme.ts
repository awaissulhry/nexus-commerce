/**
 * Light and dark (the design system's `.dark` class on `<html>`). A person picks light, dark or the system's; the
 * choice is a cookie, so the server renders `.dark` for an explicit dark choice and the page never flashes. For
 * "system" the small inline script below sets the class from `prefers-color-scheme` before the first paint.
 */

export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export const THEME_COOKIE = 'factory_theme'

export function themeModeOf(value: string | null | undefined): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

/** The next mode of the top bar's theme button: light → dark → system → light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light'
}

/** Whether a mode draws dark, given the system's preference. */
export function isDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark)
}

/**
 * Runs in `<head>` before the body paints: for "system", follows the system's preference. No data from the request
 * is written into it (the mode is read from the class the server set), so it is a constant string.
 */
export const THEME_SCRIPT = `(function(){try{var c=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var m=c?decodeURIComponent(c[1]):'system';if(m!=='light'&&m!=='dark'&&window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark')}}catch(e){}})()`
