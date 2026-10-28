import { isLocale, type Locale } from '../../../lib/i18n/locales'

/** How a design frame is shown: theme, width and language, read from its address (`?theme=dark&width=phone&lang=it`). */

export type DesignTheme = 'light' | 'dark'
export type DesignWidth = 'desktop' | 'phone'

export const DESIGN_WIDTHS: Readonly<Record<DesignWidth, { width: number; height: number; label: string }>> = {
  desktop: { width: 1440, height: 900, label: 'Desktop 1440' },
  phone: { width: 390, height: 844, label: 'Phone 390' },
}

export interface FrameOptions {
  theme: DesignTheme
  width: DesignWidth
  locale: Locale
}

type Search = Readonly<Record<string, string | string[] | undefined>>

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export function frameOptions(search: Search): FrameOptions {
  const theme = one(search.theme) === 'dark' ? 'dark' : 'light'
  const width = one(search.width) === 'phone' ? 'phone' : 'desktop'
  const lang = one(search.lang)
  return { theme, width, locale: isLocale(lang) ? lang : 'en' }
}

export function frameHref(screen: string, fixture: string, options: FrameOptions): string {
  return `/design/${encodeURIComponent(screen)}/${encodeURIComponent(fixture)}?theme=${options.theme}&width=${options.width}&lang=${options.locale}`
}
