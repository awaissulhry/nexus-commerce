'use client'

import { useEffect, useRef, useState } from 'react'
import { Printer, Shield } from 'lucide-react'

import { LabelPreview, type LabelLayout, type LabelPrintState, type LabelPrintStatus } from '@/design-system/components'
import { FloorButton, FloorFrame } from '@/design-system/floor'
import { SegmentedControl } from '@/design-system/primitives'

import s from './labels.module.css'

/*
 * 2026-10-28 — label preview and print state (gap G11, `packages/ui/src/components/LabelPreview`): five label shapes as
 * data, drawn to scale; Code 128 drawn by the design system, QR codes and pictograms by the app (here: no QR drawer,
 * so an outlined square; two stand-in pictograms). Every name, code and number is made up. Verify: the labels stay
 * white with black print in dark mode; a narrow column shrinks a label whole; the print state reads icon + word +
 * detail; Retry appears only when the job failed and walks it back through queued → sent → printed.
 */

const BUNDLE: LabelLayout = {
  name: 'Cartellino fascio B-000123-04',
  widthMm: 100,
  heightMm: 50,
  blocks: [
    { kind: 'title', text: 'Giacca Aria · Nero' },
    {
      kind: 'row',
      blocks: [
        {
          kind: 'fields',
          columns: 3,
          fields: [
            { label: 'Taglia', value: '52', size: 'xl' },
            { label: 'Pezzi', value: '24', size: 'xl' },
            { label: 'Strati', value: '1–24', size: 'lg' },
            { label: 'Fascio', value: 'B-000123-04' },
            { label: 'Ordine', value: 'WO-2026-0042' },
          ],
        },
        { kind: 'qr', value: 'B-000123-04', sizeMm: 17 },
      ],
    },
    { kind: 'fill' },
    { kind: 'barcode', value: 'B-000123-04', heightMm: 9 },
  ],
}

const HIDE: LabelLayout = {
  name: 'Etichetta pelle HT-2026-0042',
  widthMm: 60,
  heightMm: 40,
  blocks: [
    { kind: 'title', text: 'Pelle bovina 1,2 mm', size: 'md' },
    {
      kind: 'fields',
      columns: 2,
      fields: [
        { label: 'Lotto', value: 'L-0077' },
        { label: 'Area', value: '5,42 m²', size: 'lg' },
        { label: 'Scelta', value: 'A' },
        { label: 'Tono', value: '3' },
      ],
    },
    { kind: 'fill' },
    { kind: 'barcode', value: 'HT-2026-0042', heightMm: 8 },
  ],
}

const PPE: LabelLayout = {
  name: 'Etichetta DPI SER2026000123',
  widthMm: 50,
  heightMm: 90,
  blocks: [
    { kind: 'row', align: 'center', blocks: [{ kind: 'mark', id: 'rider', label: 'Pittogramma abbigliamento moto', sizeMm: 14 }, { kind: 'title', text: 'AA', size: 'xl' }] },
    { kind: 'text', text: 'EN 17092-3:2020 · Classe AA', bold: true, size: 'md' },
    { kind: 'text', text: 'Giacca moto · Esempio Aria' },
    { kind: 'rule' },
    { kind: 'fields', columns: 2, fields: [{ label: 'Taglia', value: '52', size: 'lg' }, { label: 'Serie', value: 'SER2026000123', size: 'sm' }] },
    { kind: 'text', text: 'Leggere la nota informativa prima dell’uso.' },
    { kind: 'text', text: 'Esempio S.r.l. · Via Inventata 1 · 00000 Città' },
    { kind: 'fill' },
    { kind: 'row', align: 'end', blocks: [{ kind: 'barcode', value: 'SER2026000123', heightMm: 8 }, { kind: 'mark', id: 'ce', label: 'Marcatura CE', sizeMm: 9 }] },
  ],
}

const BADGE: LabelLayout = {
  name: 'Badge BDG-0007',
  widthMm: 85,
  heightMm: 54,
  paddingMm: 4,
  blocks: [
    { kind: 'title', text: 'Maria Rossi', size: 'xl' },
    { kind: 'text', text: 'Cucitura · Turno A', size: 'md' },
    { kind: 'fill' },
    { kind: 'barcode', value: 'BDG-0007', heightMm: 12 },
  ],
}

const CARRIER: LabelLayout = {
  name: 'Etichetta corriere',
  widthMm: 100,
  heightMm: 150,
  paddingMm: 4,
  blocks: [
    { kind: 'title', text: 'Corriere Esempio · Standard', size: 'lg' },
    { kind: 'rule' },
    { kind: 'text', text: 'Destinatario', size: 'sm', bold: true },
    { kind: 'text', text: 'Cliente Esempio · Via Finta 2 · 00000 Paese (XX)', size: 'md' },
    { kind: 'rule' },
    {
      kind: 'fields',
      columns: 3,
      fields: [
        { label: 'Colli', value: '1 / 2', size: 'lg' },
        { label: 'Peso', value: '4,2 kg', size: 'lg' },
        { label: 'DDT', value: '2026/0042', size: 'lg' },
      ],
    },
    { kind: 'fill' },
    { kind: 'barcode', value: '0012345678901234', heightMm: 25 },
  ],
}

const NOT_PRINTABLE: LabelLayout = {
  name: 'Codice non stampabile',
  widthMm: 60,
  heightMm: 30,
  blocks: [{ kind: 'title', text: 'Lotto con accento', size: 'md' }, { kind: 'fill' }, { kind: 'barcode', value: 'Città-01', heightMm: 10 }],
}

const PRINT_WORDS: { readonly [S in LabelPrintStatus]: LabelPrintState } = {
  queued: { status: 'queued', label: 'In coda', detail: 'Stampante Taglio 1' },
  sent: { status: 'sent', label: 'Inviata', detail: 'Stampante Taglio 1 · 10:42' },
  printed: { status: 'printed', label: 'Stampata', detail: 'Stampante Taglio 1 · 10:42' },
  failed: { status: 'failed', label: 'Non stampata', detail: 'Stampante Taglio 1: carta finita' },
}

/** Stand-in pictograms (the app draws the real ones): drawn in the label's ink. */
function renderMark(id: string) {
  if (id === 'ce') {
    return (
      <svg viewBox="0 0 24 16" aria-hidden>
        <text x="12" y="13" textAnchor="middle" fontSize="13" fontWeight="700" fill="currentColor">
          CE
        </text>
      </svg>
    )
  }
  return <Shield aria-hidden strokeWidth={1.75} />
}

const codeLabel = (value: string, kind: 'barcode' | 'qr') => `${kind === 'qr' ? 'Codice QR' : 'Codice a barre'} ${value}`

/** The bundle ticket on the floor tier, with its print job: choose a state, or retry a failed one. */
function PrintStateExample() {
  const [status, setStatus] = useState<LabelPrintStatus>('failed')
  const [retrying, setRetrying] = useState(false)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  const retry = () => {
    setRetrying(true)
    setStatus('queued')
    timers.current.push(window.setTimeout(() => setStatus('sent'), 700))
    timers.current.push(
      window.setTimeout(() => {
        setStatus('printed')
        setRetrying(false)
      }, 1600),
    )
  }
  return (
    <div className={s.example} id="label-print-example">
      <h3 className={s.title}>Bundle ticket with its print state, on the floor tier (SCR-095)</h3>
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Print state"
          value={status}
          onChange={(v) => setStatus(v as LabelPrintStatus)}
          options={[
            { value: 'queued', label: 'Queued' },
            { value: 'sent', label: 'Sent' },
            { value: 'printed', label: 'Printed' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label="Cartellini">
          <LabelPreview
            layout={BUNDLE}
            codeLabel={codeLabel}
            print={PRINT_WORDS[status]}
            onRetry={retry}
            retryLabel="Riprova"
            retryHeldReason={retrying ? 'Nuovo invio in corso' : null}
            actions={
              <FloorButton icon={<Printer />} onClick={() => undefined}>
                Ristampa
              </FloorButton>
            }
          />
        </FloorFrame>
      </div>
    </div>
  )
}

export function LabelPreviewExample() {
  return (
    <section id="label-preview-example" className={s.kit} lang="it">
      <p className={s.note}>
        Labels as data, to scale (at most 4 px per mm; a narrow column shrinks a label whole). Paper and ink do not follow
        the theme. QR codes come from the app; here there is no QR drawer, so the square is left outlined.
      </p>
      <PrintStateExample />
      <div className={s.grid}>
        <figure className={s.cell}>
          <LabelPreview layout={HIDE} codeLabel={codeLabel} print={PRINT_WORDS.printed} />
          <figcaption className={s.caption}>Hide tag 60 × 40 mm (SCR-092)</figcaption>
        </figure>
        <figure className={s.cell}>
          <LabelPreview layout={PPE} codeLabel={codeLabel} renderMark={renderMark} print={PRINT_WORDS.queued} />
          <figcaption className={s.caption}>Garment PPE label 50 × 90 mm (SCR-096)</figcaption>
        </figure>
        <figure className={s.cell}>
          <LabelPreview layout={BADGE} codeLabel={codeLabel} print={PRINT_WORDS.sent} />
          <figcaption className={s.caption}>Badge 85 × 54 mm (SCR-085)</figcaption>
        </figure>
        <figure className={s.cell}>
          <LabelPreview layout={CARRIER} scale={3} codeLabel={codeLabel} />
          <figcaption className={s.caption}>Carrier label 100 × 150 mm at 3 px/mm (SCR-098)</figcaption>
        </figure>
        <figure className={s.cell}>
          <LabelPreview layout={NOT_PRINTABLE} codeLabel={codeLabel} invalidCodeLabel={(v) => `Non stampabile in Code 128: ${v}`} />
          <figcaption className={s.caption}>A value Code 128 cannot carry: no bars, its words instead</figcaption>
        </figure>
      </div>
    </section>
  )
}
