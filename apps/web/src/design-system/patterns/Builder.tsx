'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '@/design-system/primitives'

export interface BuilderSection {
  id: string
  label: ReactNode
  title?: ReactNode
  content: ReactNode
}

export interface BuilderProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  sections: BuilderSection[]
  primaryLabel?: ReactNode
  onPrimary?: () => void
  busy?: boolean
}

/**
 * Full-screen builder (H10 RuleBuilder / AiGoalBuilder): top bar (close + title
 * + primary action), a scroll-spy left nav, and a scrolling section body.
 * Portaled to <body>; Esc closes. The spine for the rule/goal/campaign builders.
 */
export function Builder({ open, onClose, title, sections, primaryLabel = 'Save', onPrimary, busy }: BuilderProps) {
  const [active, setActive] = useState<string | undefined>(sections[0]?.id)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const el = contentRef.current
    if (!el) return
    const onScroll = () => {
      const threshold = el.scrollTop + 80
      let current = sections[0]?.id
      for (const s of sections) {
        const node = el.querySelector<HTMLElement>(`#bsec-${s.id}`)
        if (node && node.offsetTop <= threshold) current = s.id
      }
      setActive(current)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [open, sections])

  const goTo = (id: string) => {
    const el = contentRef.current
    const node = el?.querySelector<HTMLElement>(`#bsec-${id}`)
    if (el && node) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' })
    setActive(id)
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="h10-ds-builder" role="dialog" aria-modal="true">
      <div className="h10-ds-builder-top">
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <span className="ttl">{title}</span>
        <span className="grow" />
        {onPrimary && (
          <Button variant="primary" onClick={onPrimary} disabled={busy}>
            {primaryLabel}
          </Button>
        )}
      </div>
      <div className="h10-ds-builder-body">
        <nav className="h10-ds-builder-nav">
          {sections.map((s) => (
            <button key={s.id} type="button" className={['h10-ds-builder-navitem', s.id === active ? 'on' : ''].filter(Boolean).join(' ')} onClick={() => goTo(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="h10-ds-builder-content" ref={contentRef}>
          {sections.map((s) => (
            <section key={s.id} id={`bsec-${s.id}`} className="h10-ds-builder-section">
              {s.title != null && <h3>{s.title}</h3>}
              {s.content}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
