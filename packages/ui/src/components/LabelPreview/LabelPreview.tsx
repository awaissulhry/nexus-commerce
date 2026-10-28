'use client'

/**
 * LabelPreview — what a label will look like, to scale, and where its print job stands (gap G11): bundle tickets,
 * hide tags, garment PPE labels, badges, carrier labels (SCR-053, 072, 085, 092, 095, 096, 098).
 *
 *   <LabelPreview
 *     layout={{ name: 'Cartellino fascio', widthMm: 100, heightMm: 50, blocks: [
 *       { kind: 'title', text: 'Giacca Aria · Nero' },
 *       { kind: 'row', blocks: [{ kind: 'fields', columns: 2, fields: [{ label: 'Taglia', value: '52', size: 'xl' }, …] },
 *                               { kind: 'qr', value: 'B-000123-04' }] },
 *       { kind: 'barcode', value: 'B-000123-04' },
 *     ] }}
 *     renderQr={(value) => <QrCode value={value} />}
 *     print={{ status: 'failed', label: 'Non stampata', detail: 'Stampante Taglio 1: carta finita' }}
 *     onRetry={retry} retryLabel="Riprova"
 *   />
 *
 * - **Layout as data** (`labelLayout.ts`): size in mm and blocks top to bottom — title, text, fields, Code 128
 *   barcode, QR, pictogram marks, rows side by side, a rule, and a fill that pushes the rest to the bottom edge.
 * - **To scale**: at most `scale` px per mm (default 4: a 100 mm ticket is 400 px wide); narrower space shrinks the whole
 *   label, text included (every size inside is in label millimetres, by container units). What does not fit on the
 *   label is cut off, as it would be when printed.
 * - **Paper and ink in both themes**: a label is white with black print; the preview stays so in dark mode, framed on
 *   the page, so a barcode can be test-scanned off the screen.
 * - **Code 128** is drawn here (`Code128`, no dependency); **QR** and **pictograms** come from the app
 *   (`renderQr`, `renderMark`), sized in mm; without them a QR leaves an outlined square.
 * - **Print state**: QUEUED, SENT, PRINTED, FAILED — icon + word + detail in its tone, announced politely; a failed job
 *   offers `onRetry`. More actions (Print, Reprint, Void) go in `actions`. Buttons are `FloorButton`, so they are
 *   glove-sized on the floor tier and console-sized in the office.
 * - Accessible: the label is a named figure whose text is real text; each barcode and QR is one image named by
 *   `codeLabel`. Every word comes from the app.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Check, Clock, RotateCcw, Send, TriangleAlert } from 'lucide-react'

import { FloorButton } from '../../floor/FloorButton'
import { Code128 } from './Code128'
import { labelCanRetry, type LabelBlock, type LabelLayout, type LabelPrintState, type LabelPrintStatus } from './labelLayout'
import './labelPreview.css'

export interface LabelPreviewProps {
  layout: LabelLayout
  /** Most px per mm. Default 4. The label shrinks below it to fit its container. */
  scale?: number
  /** Draws a QR of `value`, filling a `sizeMm` square (an `<svg>` that fills its box). */
  renderQr?: (value: string, sizeMm: number) => ReactNode
  /** Draws pictogram `id`, filling a `sizeMm` square. */
  renderMark?: (id: string, sizeMm: number) => ReactNode
  /** A code's name for a screen reader: (value, kind) => "Codice a barre B-000123-04". Default: the value. */
  codeLabel?: (value: string, kind: 'barcode' | 'qr') => string
  /** Shown and read where a barcode value cannot be encoded: (value) => "Codice non stampabile: …". */
  invalidCodeLabel?: (value: string) => string
  /** The print job, when there is one. */
  print?: LabelPrintState
  /** Offered when the job failed. */
  onRetry?: () => void
  retryLabel?: string
  /** Why retry cannot run now (already retrying, printer offline). */
  retryHeldReason?: string | null
  /** More actions beside the state (Print, Reprint, Void). */
  actions?: ReactNode
  id?: string
  className?: string
}

const PRINT_ICON: { readonly [S in LabelPrintStatus]: ReactNode } = {
  queued: <Clock />,
  sent: <Send />,
  printed: <Check />,
  failed: <TriangleAlert />,
}

interface BlockContext {
  renderQr?: LabelPreviewProps['renderQr']
  renderMark?: LabelPreviewProps['renderMark']
  codeLabel?: LabelPreviewProps['codeLabel']
  invalidCodeLabel?: LabelPreviewProps['invalidCodeLabel']
}

function Block({ block, ctx }: { block: LabelBlock; ctx: BlockContext }) {
  switch (block.kind) {
    case 'title':
      return (
        <div className="nds-label-title" data-size={block.size ?? 'lg'}>
          {block.text}
        </div>
      )
    case 'text':
      return (
        <p className="nds-label-text" data-size={block.size ?? 'sm'} data-align={block.align ?? 'start'} data-bold={block.bold ? 'true' : undefined}>
          {block.text}
        </p>
      )
    case 'fields':
      return (
        <dl className="nds-label-fields" style={{ '--nds-label-cols': block.columns ?? 2 } as CSSProperties}>
          {block.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="nds-label-field">
              <dt>{f.label}</dt>
              <dd data-size={f.size ?? 'md'}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'barcode':
      return (
        <Code128
          className="nds-label-barcode"
          value={block.value}
          showText={block.showText ?? true}
          label={ctx.codeLabel?.(block.value, 'barcode')}
          invalidLabel={ctx.invalidCodeLabel?.(block.value)}
          style={{ '--nds-label-bar-h': block.heightMm ?? 10 } as CSSProperties}
        />
      )
    case 'qr': {
      const size = block.sizeMm ?? 18
      return (
        <span className="nds-label-square nds-label-qr" style={{ '--nds-label-square': size } as CSSProperties} role="img" aria-label={ctx.codeLabel?.(block.value, 'qr') ?? block.value}>
          {ctx.renderQr ? ctx.renderQr(block.value, size) : <span className="nds-label-square-empty" aria-hidden />}
        </span>
      )
    }
    case 'mark': {
      const size = block.sizeMm ?? 10
      return (
        <span className="nds-label-square nds-label-mark" style={{ '--nds-label-square': size } as CSSProperties} role="img" aria-label={block.label}>
          {ctx.renderMark ? ctx.renderMark(block.id, size) : <span className="nds-label-square-empty" aria-hidden />}
        </span>
      )
    }
    case 'row':
      return (
        <div className="nds-label-row" data-align={block.align ?? 'start'}>
          {block.blocks.map((b, i) => (
            <Block key={i} block={b} ctx={ctx} />
          ))}
        </div>
      )
    case 'rule':
      return <hr className="nds-label-rule" />
    case 'fill':
      return <span className="nds-label-fill" aria-hidden />
  }
}

export function LabelPreview({
  layout,
  scale = 4,
  renderQr,
  renderMark,
  codeLabel,
  invalidCodeLabel,
  print,
  onRetry,
  retryLabel,
  retryHeldReason,
  actions,
  id,
  className,
}: LabelPreviewProps) {
  const ctx: BlockContext = { renderQr, renderMark, codeLabel, invalidCodeLabel }
  const size = {
    '--nds-label-w': layout.widthMm,
    '--nds-label-h': layout.heightMm,
    '--nds-label-scale': scale,
    '--nds-label-pad': layout.paddingMm ?? 2,
  } as CSSProperties
  const retry = onRetry && labelCanRetry(print)
  return (
    <div id={id} className={['nds-label-preview', className ?? ''].filter(Boolean).join(' ')} data-status={print?.status}>
      <figure className="nds-label-figure" aria-label={layout.name}>
        <div className="nds-label" style={size}>
          <div className="nds-label-body">
            {layout.blocks.map((b, i) => (
              <Block key={i} block={b} ctx={ctx} />
            ))}
          </div>
        </div>
      </figure>
      {print || actions ? (
        <div className="nds-label-print">
          {print ? (
            <div className="nds-label-print-state" data-status={print.status} role="status">
              <span className="nds-label-print-icon" aria-hidden>
                {PRINT_ICON[print.status]}
              </span>
              <span className="nds-label-print-text">
                <span className="nds-label-print-word">{print.label}</span>
                {print.detail ? <span className="nds-label-print-detail">{print.detail}</span> : null}
              </span>
            </div>
          ) : null}
          {retry || actions ? (
            <div className="nds-label-print-actions">
              {retry ? (
                <FloorButton variant="primary" icon={<RotateCcw />} heldReason={retryHeldReason} onClick={onRetry}>
                  {retryLabel}
                </FloorButton>
              ) : null}
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
