'use client'

import { useState, type ReactNode } from 'react'
import { Camera, Users } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'
import { OrderPictureWindow } from '../../../../../../lib/record-picture/OrderPictureWindow'
import type { ReadPictures } from '../../../../../../lib/record-picture/cache'
import type { SaveOrderPicture } from '../../../../../../lib/record-picture/api'
import type { PictureChoice } from '../../../../../../lib/record-picture/order-picture'
import type { PictureSource } from '../../../../../../lib/record-picture/model'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import type { BackPlace } from '../../../../../../lib/record-frame/back'
import { useFlowWords } from '../../flow-words'
import type { BandTag } from '../model'
import './band.css'

/**
 * owb-of5 step 1 (design plan § 5i; prototype rec.js orderBand) — the parts the order band puts in the record frame's slots: the
 * picture (a button that opens "The picture of the order" for who may change it — sales and the owner; the designer and the floor
 * see a plain picture), the tags beside the ONE state chip, People (the order's People card in a window) and Back's words. Draws
 * what it is given; fetches nothing (the ports come from the container).
 */

export interface BandPictureProps {
  readonly source: PictureSource
  readonly recordId: string
  /** "SO-2026-0142", "RQ-0012": the picture's name and the window's second line. */
  readonly number: string
  readonly subject?: string | null
  readonly version: number
  readonly fileId: string | null
  readonly read: ReadPictures | null
  /** The save door; null: this reader may not change the picture (a plain picture, no window). */
  readonly save: SaveOrderPicture | null
  readonly choices: readonly PictureChoice[]
  readonly onSaved?: () => void
}

export function BandPicture({ source, recordId, number, subject = null, version, fileId, read, save, choices, onSaved }: BandPictureProps) {
  const [open, setOpen] = useState(false)
  return (
    <span className={save ? 'fw-flow-bandpic is-door' : 'fw-flow-bandpic'}>
      <RecordPicture source={source} recordId={recordId} number={number} size="line" read={read} {...(save ? { onOpen: () => setOpen(true) } : {})} />
      {save ? <Camera size={12} aria-hidden className="fw-flow-bandpic-cam" /> : null}
      {save ? (
        <OrderPictureWindow open={open} onClose={() => setOpen(false)} number={number} subject={subject} record={{ source, recordId, read }} now={{ fileId, version }} choices={choices} save={save} onSaved={() => onSaved?.()} />
      ) : null}
    </span>
  )
}

/** The tags beside the state chip, in the design's order (model bandTagsOf). */
export function BandTags({ tags }: { readonly tags: readonly BandTag[] }) {
  const f = useFlowWords()
  return (
    <>
      {tags.map((tag) => (
        <Tag key={tag.kind} tone={tag.tone}>
          {f(tag.key, tag.params)}
        </Tag>
      ))}
    </>
  )
}

/** People: a quiet button ("People · 3") that opens the order's People card in a window (the card is the host's). */
export function BandPeople({ count, number, children }: { readonly count: number; readonly number: string; readonly children: ReactNode }) {
  const f = useFlowWords()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="quiet" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Users size={14} aria-hidden /> {count > 0 ? f('people.count', { count }) : f('people.button')}
      </Button>
      <WindowShell open={open} onClose={() => setOpen(false)} title={f('people.window', { number })} size="lg">
        {open ? children : null}
      </WindowShell>
    </>
  )
}

/** Back's words: where it goes ("Orders", "Seed Racing", "Design desk"); `fallback` (the page's list) when nothing before is known. */
export function useBackWords(): (place: BackPlace | null, fallback: string) => string {
  const f = useFlowWords()
  return (place, fallback) => (!place ? fallback : place.kind === 'customer' && place.name ? place.name : f(`back.${place.kind}`))
}
