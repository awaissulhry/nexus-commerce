/**
 * The label preview's data (gap G11): a label's size in millimetres and its content as blocks top to bottom, so one
 * component draws a bundle ticket, a hide tag, a garment PPE label, a badge or a carrier label (SCR-053, 072, 085, 092,
 * 095, 096, 098). The app builds the layout; the words and values in it are the app's.
 *
 * Sizes inside a label are in millimetres of the printed label (text heights too), so the preview scales as a whole.
 */
import { isCode128Text } from './code128Model'

/** Text height on the label: sm 2.2 mm, md 3 mm, lg 4.2 mm, xl 6 mm. */
export type LabelTextSize = 'sm' | 'md' | 'lg' | 'xl'

export const LABEL_TEXT_MM: { readonly [S in LabelTextSize]: number } = { sm: 2.2, md: 3, lg: 4.2, xl: 6 }

export interface LabelField {
  /** "Taglia" — printed small above the value. */
  label: string
  /** "52". */
  value: string
  /** The value's height. Default `md`. */
  size?: LabelTextSize
}

export type LabelBlock =
  /** The label's heading. Default `lg`. */
  | { kind: 'title'; text: string; size?: LabelTextSize }
  /** A line or paragraph (a warning, the care text, a standard's number). Default `sm`. */
  | { kind: 'text'; text: string; size?: LabelTextSize; bold?: boolean; align?: 'start' | 'center' | 'end' }
  /** Label/value pairs in 1–4 columns. */
  | { kind: 'fields'; fields: readonly LabelField[]; columns?: 1 | 2 | 3 | 4 }
  /** A Code 128 barcode of `value`, full width, bars `heightMm` tall (default 10), the value printed under it. */
  | { kind: 'barcode'; value: string; heightMm?: number; showText?: boolean }
  /** A QR code of `value`, `sizeMm` square (default 18). Drawn by the app's `renderQr`. */
  | { kind: 'qr'; value: string; sizeMm?: number }
  /** A pictogram (CE mark, a PPE class pictogram, a care symbol), `sizeMm` square (default 10). Drawn by `renderMark`. */
  | { kind: 'mark'; id: string; label: string; sizeMm?: number }
  /** Blocks side by side (fields beside a QR). QR codes and marks keep their size; the rest share the width. */
  | { kind: 'row'; blocks: readonly LabelBlock[]; align?: 'start' | 'center' | 'end' }
  /** A thin printed line. */
  | { kind: 'rule' }
  /** Empty space that pushes what follows to the bottom edge. */
  | { kind: 'fill' }

export interface LabelLayout {
  /** What the label is ("Cartellino fascio"), for a screen reader. */
  name: string
  widthMm: number
  heightMm: number
  /** Blank margin inside the edge. Default 2 mm. */
  paddingMm?: number
  blocks: readonly LabelBlock[]
}

export type LabelPrintStatus = 'queued' | 'sent' | 'printed' | 'failed'

/** Where the label's print job stands, in the app's words. */
export interface LabelPrintState {
  status: LabelPrintStatus
  /** "In coda", "Inviata", "Stampata", "Non stampata". */
  label: string
  /** The printer and time, or why it failed. */
  detail?: string
}

export const LABEL_PRINT_STATUSES: readonly LabelPrintStatus[] = ['queued', 'sent', 'printed', 'failed']

/** The tone each print state is drawn in (always with its icon and word). */
export const LABEL_PRINT_TONE: { readonly [S in LabelPrintStatus]: 'neutral' | 'info' | 'success' | 'danger' } = {
  queued: 'neutral',
  sent: 'info',
  printed: 'success',
  failed: 'danger',
}

/** Every block, rows opened, in reading order. */
export function labelBlocks(blocks: readonly LabelBlock[]): LabelBlock[] {
  return blocks.flatMap((b) => (b.kind === 'row' ? [b, ...labelBlocks(b.blocks)] : [b]))
}

/** Barcode values in a layout that Code 128 cannot carry — check before sending a label to print. */
export function labelInvalidCodes(layout: Pick<LabelLayout, 'blocks'>): string[] {
  return labelBlocks(layout.blocks).flatMap((b) => (b.kind === 'barcode' && !isCode128Text(b.value) ? [b.value] : []))
}

/** Retry is offered for a failed job only. */
export const labelCanRetry = (print: LabelPrintState | undefined): boolean => print?.status === 'failed'
