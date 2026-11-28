'use client'

import { useMemo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { catalogueFor, createTranslator } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'
import './yellow-line.css'

/**
 * owb-of7 step 4 (design plan § 5g, X2 "Warn, don't stop": a warning is a yellow line + "Go on"; L1 pick A builds no new warn row) —
 * THE part every office dialog draws for a passed warning: a yellow line with the host's words and ONE "Go on" (absent `onGoOn`: the
 * words only). "Go on" does the dialog's act with the warning passed (the host sends its `overrides`; the command's own audit row keeps
 * who went on, base `passed-warnings.ts`). Its one word reads the shared `orders` catalogue straight (no page must load it). Draws its
 * props; fetches nothing.
 */
export function YellowLine({ children, onGoOn, held = null }: { readonly children: ReactNode; readonly onGoOn?: () => void; /** Why "Go on" waits (the act's own held words). */ readonly held?: string | null }) {
  const locale = useLocale()
  const reader = useReader()
  const goOn = useMemo(() => createTranslator(locale, catalogueFor(locale, 'orders', reader))('kit.goOn'), [locale, reader])
  return <YellowLineBody goOn={goOn} onGoOn={onGoOn} held={held}>{children}</YellowLineBody>
}

/** The line itself (no hook: the tests draw it and press its button): the mark, the words, "Go on" when the host gives the act. */
export function YellowLineBody({ children, goOn, onGoOn, held = null }: { readonly children: ReactNode; readonly goOn: string; readonly onGoOn?: (() => void) | undefined; readonly held?: string | null }) {
  return (
    <div className="fw-yl" role="note">
      <AlertTriangle size={16} aria-hidden className="fw-yl-mark" />
      <div className="fw-yl-words">{children}</div>
      {onGoOn ? (
        <Button size="sm" variant="warning" heldReason={held} onClick={onGoOn}>
          {goOn}
        </Button>
      ) : null}
    </div>
  )
}
