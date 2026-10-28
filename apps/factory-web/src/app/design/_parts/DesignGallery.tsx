'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { EmptyState } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { SegmentedControl, Tag } from '@nexus/ui/primitives'
import { LOCALES, LOCALE_NAMES, isLocale } from '../../../lib/i18n/locales'
import { findScreen } from '../_registry'
import { DESIGN_WIDTHS, frameHref, type DesignTheme, type DesignWidth, type FrameOptions } from './frame-options'
import '../design.css'

type Themes = 'both' | DesignTheme

/**
 * `/design/SCR-003` — every case of one screen, each in an iframe at the chosen width (so the screen's media queries
 * are real), in light and dark side by side or one of them, in either language. "Open alone" shows a case at full
 * size, for the keyboard check.
 */
export function DesignGallery({ screenId, initial }: { screenId: string; initial: FrameOptions & { themes: Themes } }) {
  const router = useRouter()
  const pathname = usePathname()
  const screen = findScreen(screenId)
  const [themes, setThemes] = useState<Themes>(initial.themes)
  const [width, setWidth] = useState<DesignWidth>(initial.width)
  const [locale, setLocale] = useState(initial.locale)
  const listRef = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(1200)

  useEffect(() => {
    router.replace(`${pathname}?themes=${themes}&width=${width}&lang=${locale}`, { scroll: false })
  }, [themes, width, locale, pathname, router])

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const observe = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width))
    observe.observe(node)
    return () => observe.disconnect()
  }, [])

  if (!screen) return <EmptyState title="No such screen" description={screenId} />
  const size = DESIGN_WIDTHS[width]
  const shown: DesignTheme[] = themes === 'both' ? ['light', 'dark'] : [themes]
  const gap = 16
  const scale = Math.min(1, (room - gap * (shown.length - 1)) / shown.length / size.width)

  return (
    <main id="main-content" className="fw-design">
      <PageHeader
        eyebrow={
          <Link href="/design" className="fw-design-back">
            Design index
          </Link>
        }
        title={
          <>
            <Tag tone="info">{screen.screen}</Tag> {screen.title}
          </>
        }
        subtitle={`${screen.cases.length} cases · ${screen.file}`}
        actions={
          <div className="fw-design-toggles">
            <SegmentedControl
              ariaLabel="Theme"
              size="sm"
              value={themes}
              onChange={(value) => setThemes(value as Themes)}
              options={[
                { value: 'both', label: 'Both' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
            <SegmentedControl
              ariaLabel="Width"
              size="sm"
              value={width}
              onChange={(value) => setWidth(value as DesignWidth)}
              options={(Object.keys(DESIGN_WIDTHS) as DesignWidth[]).map((key) => ({ value: key, label: DESIGN_WIDTHS[key].label }))}
            />
            <SegmentedControl
              ariaLabel="Language"
              size="sm"
              value={locale}
              onChange={(value) => isLocale(value) && setLocale(value)}
              options={LOCALES.map((option) => ({ value: option, label: LOCALE_NAMES[option] }))}
            />
          </div>
        }
      />
      <div ref={listRef} className="fw-design-cases-list">
        {screen.cases.map((item) => (
          <section key={item.id} id={item.id} className="fw-design-case" aria-labelledby={`${item.id}-title`}>
            <div className="fw-design-case-head">
              <h2 id={`${item.id}-title`}>{item.label}</h2>
              {item.note && <p className="fw-design-muted">{item.note}</p>}
            </div>
            <div className="fw-design-frames" style={{ gap }}>
              {shown.map((theme) => {
                const href = frameHref(screen.screen, item.id, { theme, width, locale })
                return (
                  <figure key={theme} className="fw-design-frame">
                    <figcaption>
                      {theme === 'dark' ? 'Dark' : 'Light'} · {size.label} ·{' '}
                      <a href={href} target="_blank" rel="noreferrer">
                        Open alone
                      </a>
                    </figcaption>
                    <div className="fw-design-viewport" style={{ width: size.width * scale, height: size.height * scale }}>
                      <iframe
                        title={`${screen.screen} ${item.label}, ${theme}, ${size.label}`}
                        src={href}
                        width={size.width}
                        height={size.height}
                        loading="lazy"
                        style={{ transform: `scale(${scale})` }}
                      />
                    </div>
                  </figure>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}
