import { createElement } from 'react'
import { recordDockedThread, type RecordDockedInput } from '../../../lib/record-thread/fixtures'
import type { HeadModel } from '../../../lib/record-thread/head/model'
import { ThreadCase } from '../../../lib/record-thread/ThreadCase'
import { useRecordFrame } from './RecordFrame'
import { useDockTop } from '../record-thread/ThreadPick' // F-OP-202: a design case's dock pick, drawn inside the card as on the page

/**
 * B-TH-257…264 (TH-6 part A; the rule of picture 38) — design only: the made-up docked thread a record page's design case passes to
 * its view as `thread`, inside the RecordFrame the case draws (whose width menu it drives). The page itself mounts the office's
 * `<OfficeRecordThread docked …/>`. No `designScreen` here: the record pages' own screens draw it.
 */
function DesignThread({ input, head }: { input: RecordDockedInput; head?: Partial<HeadModel> }) {
  const frame = useRecordFrame()
  const top = useDockTop() // F-OP-202
  return createElement(ThreadCase, { model: recordDockedThread(input, { width: frame?.width ?? null, ...head }), onWidth: frame?.choose, top })
}

/** The element a record page's design case passes to its view as its `thread` (its type, its number, its party or none). */
export const designDockedThread = (input: RecordDockedInput, head?: Partial<HeadModel>) => createElement(DesignThread, { input, head })
