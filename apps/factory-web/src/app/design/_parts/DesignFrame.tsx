'use client'

import { useEffect, useMemo, type MouseEvent } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider, LocaleSwitchProvider } from '../../../lib/i18n/provider'
import { findCase, findScreen } from '../_registry'
import type { FrameOptions } from './frame-options'
import '../design.css'

/**
 * One fixture of one screen, alone on the page (`/design/SCR-003/owner?theme=dark&lang=it`): the gallery shows it in an
 * iframe at the chosen width, so the screen's own media queries apply; opened alone it is the screen at full size, for
 * the keyboard. The theme is set on `<html>` (DS `.dark`), the language from the address. Links do not navigate: the
 * frame shows one screen, never the app behind it.
 */
export function DesignFrame({ screenId, caseId, options }: { screenId: string; caseId: string; options: FrameOptions }) {
  const router = useRouter()
  const pathname = usePathname()
  const screen = findScreen(screenId)
  const item = screen ? findCase(screen, caseId) : undefined
  const messages = useMemo(() => messagesFor(options.locale, ['shell']), [options.locale])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', options.theme === 'dark')
    document.documentElement.lang = options.locale
  }, [options.theme, options.locale])

  // A link in a fixture would leave the screen: keep the click here (Next's Link checks `defaultPrevented`).
  const stayHere = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest?.('a[href]')
    if (anchor && !anchor.getAttribute('href')?.startsWith('#')) event.preventDefault()
  }

  if (!screen || !item) {
    return (
      <main id="main-content">
        <EmptyState title="No such fixture" description={`${screenId} / ${caseId}`} />
      </main>
    )
  }
  const View = screen.view
  return (
    <I18nProvider locale={options.locale} messages={messages}>
      <LocaleSwitchProvider
        onChange={(locale) => router.replace(`${pathname}?theme=${options.theme}&width=${options.width}&lang=${LOCALES.includes(locale) ? locale : 'en'}`)}
      >
        <div onClickCapture={stayHere} data-design-frame={`${screen.screen}/${item.id}`}>
          {screen.part ? (
            <div className="fw-design-part">
              <View model={item.model} />
            </div>
          ) : (
            <View model={item.model}>{screen.holdsPage ? <SamplePage /> : null}</View>
          )}
        </div>
      </LocaleSwitchProvider>
    </I18nProvider>
  )
}

/** A stand-in page inside the office shell: the shell's fixtures show the frame, not a page (its title is the band's). */
function SamplePage() {
  return (
    <Card padded>
      <EmptyState
        title="The page goes here"
        description="This frame shows the Office shell around a page: top bar, rail, the area's subheader band with its pages button, banners and the phone bottom bar. Each area's page is its own design batch."
        action={<Button variant="primary">Primary action</Button>}
      />
    </Card>
  )
}
