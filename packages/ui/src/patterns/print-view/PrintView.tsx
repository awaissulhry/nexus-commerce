'use client'

/**
 * PrintView — a page made for paper (B-W2b-09; design 00-page-anatomy §3.14; the print pages B-W2a-38, -46, -51 …
 * composed one each): on screen a strip with Print and the way back; on paper and screen alike the title, who printed
 * it and when, and the filters that were on (or "No filters: every row"); the sections never split across a sheet.
 *
 *   <PrintView title="Daily production report — Bologna, 31 Oct" printedAt={formatDateTime(now)} printedBy={person.name}
 *     filters={[{ label: 'Line', value: 'L1' }]} back={{ href: reportsHref, label: t('back') }} printHeld={loading ? t('reading') : null}
 *     labels={ds.printView}>
 *     <PrintSection title="L1 · Linea giacche">…</PrintSection>
 *   </PrintView>
 *
 * - **Off paper**: the strip, and every element the app marks `printHide` / `data-print-hide` (the rail already is; the
 *   app marks its top bar and toolbars). Buttons inside the body print as they look.
 * - **Light**: paper is white, so the view draws light while it is open (`light`, default true) and puts the person's
 *   theme back when it closes; it also switches for the print itself (`beforeprint` / `afterprint`) in either case.
 * - **Print held**: while the content is read, Print is held with the reason — never a print of a half-read page.
 * - Page numbers in the sheet's margin ("2 / 5"), wherever the browser draws page margin boxes.
 * Its own entry point (`patterns/print-view`). Every word from `labels` or the app.
 */
import { useEffect, type ComponentType, type ReactNode } from 'react'
import NextLink from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'

import { Button } from '../../primitives/Button'
import { mergeLabels } from '../../lib/labels'
import { PRINT_VIEW_LABELS, type PrintViewLabels } from './PrintViewLabels'
import { forceLight, printFiltersLine, printedLine, type PrintFilter } from './printViewModel'
import './print-view.css'

export type PrintViewLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>

export interface PrintViewProps {
  /** What the paper is: "Daily production report — Bologna, 31 Oct 2026". */
  title: ReactNode
  /** Lines under the title (the company, the site, the record's version). */
  meta?: readonly ReactNode[]
  /** When it was printed, already written ("31 Oct 2026, 10:42"). */
  printedAt?: string | null
  /** Who printed it. */
  printedBy?: string | null
  /** The filters of the view being printed; `null` when the page has no filters (no line). */
  filters?: readonly PrintFilter[] | null
  /** Why Print cannot run yet ("Still reading the report"). */
  printHeld?: string | null
  /** Print. Default `window.print()`. */
  onPrint?: () => void
  /** The way back to the view (a real link). */
  back?: { href: string; label?: string } | null
  /** More controls in the strip (a paper size, a language). */
  tools?: ReactNode
  /** Draw light while open. Default true. */
  light?: boolean
  linkAs?: PrintViewLinkComponent
  labels?: Partial<PrintViewLabels>
  className?: string
  children?: ReactNode
}

export function PrintView({
  title, meta, printedAt, printedBy, filters, printHeld, onPrint, back, tools, light = true, linkAs, labels, className, children,
}: PrintViewProps) {
  const words = mergeLabels(PRINT_VIEW_LABELS, labels)
  useEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null
    // While open (`light`), and always for the print itself: something may set the theme again after this mounted.
    const restoreOpen = light ? forceLight(root) : () => {}
    let restorePrint: () => void = () => {}
    const before = () => { restorePrint = forceLight(root) }
    const after = () => { restorePrint(); restorePrint = () => {} }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
      after()
      restoreOpen()
    }
  }, [light])
  const Link = linkAs ?? NextLink
  const printed = printedLine(printedAt, printedBy, words)
  return (
    <article className={['nds-printview', className ?? ''].filter(Boolean).join(' ')}>
      <div className="nds-printview-strip" role="group" aria-label={words.strip} data-print-hide="">
        {back && (
          <Link className="nds-printview-back" href={back.href}>
            <ArrowLeft size={14} aria-hidden /> {back.label ?? words.back}
          </Link>
        )}
        <span className="nds-printview-tools">{tools}</span>
        <Button variant="primary" onClick={() => (onPrint ? onPrint() : window.print())} heldReason={printHeld ?? null}>
          <Printer size={14} aria-hidden /> {words.print}
        </Button>
      </div>
      <header className="nds-printview-head">
        <h1 className="nds-printview-title">{title}</h1>
        {meta?.map((line, index) => (
          <p key={index} className="nds-printview-meta">{line}</p>
        ))}
        {printed && <p className="nds-printview-meta">{printed}</p>}
        {filters != null && <p className="nds-printview-filters">{printFiltersLine(filters, words)}</p>}
      </header>
      <div className="nds-printview-body">{children}</div>
    </article>
  )
}

/** A part of the paper that never splits across two sheets (a lane, a table with its heading). */
export function PrintSection({ title, children, className }: { title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={['nds-printview-section', className ?? ''].filter(Boolean).join(' ')}>
      {title != null && <h2 className="nds-printview-section-title">{title}</h2>}
      {children}
    </section>
  )
}
