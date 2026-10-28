import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { Inter, JetBrains_Mono } from 'next/font/google'
/*
 * The design system, once for the whole app, in the cascade order the DS resolves conflicts by (as Commerce's root
 * layout): tokens → primitives → components → patterns → a11y last (its focus and reduced-motion rules win). The full
 * `tokens.css`: this app has no Tailwind, so the platform alias names need no withholding.
 */
import '@nexus/ui/styles/tokens.css'
import '@nexus/ui/styles/primitives.css'
import '@nexus/ui/styles/components.css'
import '@nexus/ui/styles/patterns.css'
import '@nexus/ui/styles/a11y.css'
import '../shell/base.css'
import { LocaleSwitchHost } from '../lib/i18n/LocaleSwitchHost'
import { createTranslator, messagesFor } from '../lib/i18n/messages'
import { I18nProvider } from '../lib/i18n/provider'
import { requestLocale } from '../lib/i18n/server'
import { PdfProvider } from '../lib/pdf/PdfProvider'
import { THEME_COOKIE, THEME_SCRIPT, themeModeOf } from '../lib/theme/theme'

export const metadata: Metadata = {
  title: 'Nexus Factory',
}

// The DS fonts, as Commerce: Inter for text, JetBrains Mono for figures. No metric fallback face (it is Arial); the
// fallback is the system UI font.
const sans = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-sans',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
})
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
})

/**
 * The root of every view (Office, Floor, Portal, Links): the language (`<html lang>`; the office puts the person's own
 * over it), the theme (the cookie's explicit dark is rendered by the server; "system" is set before paint by the inline
 * script), the skip link, the UI text, and pdf.js for every PDF viewer.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale()
  const theme = themeModeOf((await cookies()).get(THEME_COOKIE)?.value)
  const t = createTranslator(locale, messagesFor(locale, ['shell']).shell ?? {})
  return (
    <html lang={locale} className={[sans.variable, mono.variable, theme === 'dark' ? 'dark' : ''].filter(Boolean).join(' ')} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a href="#main-content" className="fw-skip">
          {t('a11y.skipToContent')}
        </a>
        <I18nProvider locale={locale} messages={messagesFor(locale, ['shell'])}>
          <LocaleSwitchHost>
            <PdfProvider>{children}</PdfProvider>
          </LocaleSwitchHost>
        </I18nProvider>
      </body>
    </html>
  )
}
