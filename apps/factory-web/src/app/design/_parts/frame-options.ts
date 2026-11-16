import { isLocale, type Locale } from '../../../lib/i18n/locales'

/**
 * How a design frame is shown: theme, width and language, read from its address (`?theme=dark&width=phone&lang=it`).
 * B-TH-297 (PR-13): the Owner's widths — "Wide 1920" (the dead space on the right shows there) and "Phone 375" beside 1440,
 * 1024 and 390. The address names a width by its key (`width=wide`) or by its pixels (`width=1920`).
 */

export type DesignTheme = 'light' | 'dark'
export type DesignWidth = 'wide' | 'desktop' | 'tablet' | 'phone' | 'phone375'

export const DESIGN_WIDTHS: Readonly<Record<DesignWidth, { width: number; height: number; label: string }>> = {
  /** B-TH-297: a full-HD office screen; every list and record fills it (no page max-width, no dead space on the right). */
  wide: { width: 1920, height: 1080, label: 'Wide 1920' },
  desktop: { width: 1440, height: 900, label: 'Desktop 1440' },
  /** A 10-inch floor tablet held landscape (the floor screens' first size). */
  tablet: { width: 1024, height: 768, label: 'Tablet 1024' },
  phone: { width: 390, height: 844, label: 'Phone 390' },
  /** B-TH-297: the smallest phone the Owner checks (an iPhone SE / mini width). */
  phone375: { width: 375, height: 667, label: 'Phone 375' },
}

const WIDTH_KEYS = Object.keys(DESIGN_WIDTHS) as DesignWidth[]

export interface FrameOptions {
  theme: DesignTheme
  width: DesignWidth
  locale: Locale
}

type Search = Readonly<Record<string, string | string[] | undefined>>

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** A width of the address: its key, or its pixels (`1920`, `375`); anything else is the desktop. */
export function widthOf(asked: string | undefined): DesignWidth {
  if (!asked) return 'desktop'
  if ((WIDTH_KEYS as readonly string[]).includes(asked)) return asked as DesignWidth
  const pixels = /^\d{3,4}$/.test(asked) ? Number(asked) : NaN
  return WIDTH_KEYS.find((key) => DESIGN_WIDTHS[key].width === pixels) ?? 'desktop'
}

export function frameOptions(search: Search): FrameOptions {
  const theme = one(search.theme) === 'dark' ? 'dark' : 'light'
  const width = widthOf(one(search.width))
  const lang = one(search.lang)
  return { theme, width, locale: isLocale(lang) ? lang : 'en' }
}

export function frameHref(screen: string, fixture: string, options: FrameOptions): string {
  return `/design/${encodeURIComponent(screen)}/${encodeURIComponent(fixture)}?theme=${options.theme}&width=${options.width}&lang=${options.locale}`
}
