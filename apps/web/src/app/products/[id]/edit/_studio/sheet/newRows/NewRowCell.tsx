'use client'

/**
 * Add rows — the identity cell of an EMPTY row: the SKU typed so far (or "Type the SKU"), a line that says what the row
 * will create or what the server answered, its state pill ("Not saved", "Saving…", "Refused", "Not confirmed",
 * "Created") and a remove button. Drawn with the sheet's one identity band (`IdentityBand`), so an empty row lines up with
 * the real rows around it. The row itself wears `UNSAVED_ROW_CLASS` (the dashed bar); this cell opts out of the row's
 * muted ink (`nds-cell-full-strength`, set by the column) so its words stay readable.
 *
 * The SKU is typed in the column's own editor (S11's first-column editor answers `create` for an `unsaved` row); this
 * renderer never edits.
 */
import { memo, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, Pill } from '@/design-system/primitives'
import { IdentityBand, SkuTag } from '@/design-system/grid'
import { identitySkuHover } from '../identitySkuEdit'
import { NEW_ROWS_WORDS, newRowLine, newRowPill, removable, type NewRow } from './newRows'

export interface NewRowCellProps {
  row: NewRow
  onRemove: (rowId: string) => void
  /** The tree slot, so the SKU starts where its siblings' do (`ExpandSlot` on a variation row). */
  expand?: ReactNode
  /** A listing (alias) row is a band: no picture. A variation row keeps the picture's place. */
  noImage?: boolean
}

/** The remove button's name: which row it removes. */
export const removeRowName = (row: Pick<NewRow, 'sku'>) => (row.sku ? `Remove the new row ${row.sku}` : 'Remove this empty row')

/** The empty row's hover: its refusal as the first column says one, else its state and line. */
export const newRowHover = (row: NewRow): string | undefined => row.state === 'refused' && row.reason
  ? identitySkuHover(row.reason)
  : `${newRowPill(row).label}. ${newRowLine(row)}`

export const NewRowCell = memo(function NewRowCell({ row, onRemove, expand, noImage }: NewRowCellProps) {
  const pill = newRowPill(row)
  const line = newRowLine(row)
  return (
    <IdentityBand
      expand={expand}
      noImage={noImage}
      image={null}
      sku={row.sku ? <SkuTag>{row.sku}</SkuTag> : <span className="nds-cell-muted">{NEW_ROWS_WORDS.typeSku}</span>}
      secondary={line}
      secondaryTitle={line}
      /* F8 — a refusal reads as on every first-column cell ("Not saved: …", `identitySkuHover`); the editor leads with it
         when the SKU is typed again, and the store said it as a toast when it happened. */
      title={newRowHover(row)}
      trailing={<>
        <Pill tone={pill.tone} size="sm">{pill.label}</Pill>
        {removable(row) && (
          <Button size="sm" variant="quiet" className="icon" aria-label={removeRowName(row)}
            onClick={(event) => { event.stopPropagation(); onRemove(row.id) }}>
            <X size={14} aria-hidden />
          </Button>
        )}
      </>}
    />
  )
})
