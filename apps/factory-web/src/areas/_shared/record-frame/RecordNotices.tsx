'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { FRAME_NS } from './RecordFrame'

/**
 * The record's ONE notice (O-SAL-ORD-REC.notice; G.3 of the tree): the notices as children, most serious first; the first shows and
 * the rest wait behind "N more notices" (one click shows them all, one hides them again). Never above the thread: the frame puts it
 * in the body column. A notice that has nothing to say renders nothing and is not counted.
 */
export function RecordNotices({ children }: { children?: ReactNode }) {
  return (
    <WithMessages namespaces={[FRAME_NS]}>
      <Notices>{children}</Notices>
    </WithMessages>
  )
}

function Notices({ children }: { children?: ReactNode }) {
  const t = useT(FRAME_NS)
  const list = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  // How many notices drew something (each draws one element or nothing), after every change of them.
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const read = () => setCount(element.children.length)
    read()
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(read)
    observer?.observe(element, { childList: true })
    return () => observer?.disconnect()
  }, [])
  const more = count - 1
  return (
    <div className={`fw-rcf-notices${open ? ' is-open' : ''}`}>
      <div ref={list} className="fw-rcf-notices-list">
        {children}
      </div>
      {more > 0 && (
        <Button size="sm" variant="quiet" className="fw-rcf-notices-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />} {t(open ? 'notices.fewer' : 'notices.more', { count: more })}
        </Button>
      )}
    </div>
  )
}
