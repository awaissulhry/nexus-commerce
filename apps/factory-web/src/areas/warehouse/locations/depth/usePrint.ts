'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listLabelPrinters } from '../../../_shared/stock/api'
import { readProblem } from '../../../_shared/stock/model'
import { placeLabelsPdf, printPlaceLabels, type PlaceView } from './api'
import { blockProblemOf, labelRefusalOf, printHeldOf, printSplit, type DepthCan, type PrintActions, type PrintDialogModel } from './model'

/**
 * Print labels (design warehouse.locations page.h "Print labels (W2b)", Location › Labels "Print · Reprint", tab:lc-tab-labels
 * "Bin labels PDF"): the dialog's container part, shared by the list and the record. Opens on the places picked, reads the
 * site's label printers (print.view), prints with ONE Idempotency-Key per dialog (`POST /inventory/locations/labels/print`:
 * one job per place; a place without a code gets its suggested code first), or opens the bin labels PDF in a new tab (the
 * tab opened in the click itself, so a pop-up blocker lets it through; blocked anyway, the file is downloaded). `onDone`
 * runs after a print (the page reads the codes and jobs again).
 */
export function usePrint(api: ApiClient, can: Pick<DepthCan, 'printLabels' | 'printView' | 'manage'>, onDone: () => void) {
  const [model, setModel] = useState<PrintDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model

  const open = useCallback(
    (places: PlaceView[], siteId: string, siteCode: string, language: 'it' | 'en') => {
      key.current = newIdempotencyKey()
      setModel({ places, siteCode, draft: { printerId: can.printLabels ? '' : 'PDF', copies: 1, language }, printers: can.printView ? { status: 'loading' } : null, posting: false, problem: null, done: null })
      if (!can.printView) return
      listLabelPrinters(api, siteId)
        .then((printers) =>
          setModel((current) => (current ? { ...current, printers: { status: 'ready', value: printers }, draft: { ...current.draft, printerId: current.draft.printerId || (printers.length === 1 ? printers[0]!.id : printers.length === 0 ? 'PDF' : '') } } : current)),
        )
        .catch((error: unknown) => setModel((current) => (current ? { ...current, printers: { status: 'error', problem: readProblem(error) }, draft: { ...current.draft, printerId: current.draft.printerId || 'PDF' } } : current)))
    },
    [api, can.printLabels, can.printView],
  )

  const actions: PrintActions = {
    onChange: (draft) => setModel((current) => (current ? { ...current, draft, problem: null } : current)),
    onClose: () => {
      // B-W2b-383: places the PDF left out changed since the page read them: it reads them again too.
      const printed = (latest.current?.done?.jobs.length ?? 0) > 0 || (latest.current?.done?.pdfLeftOut ?? 0) > 0
      setModel(null)
      if (printed) onDone()
    },
    onPrint: () => {
      const current = latest.current
      if (!current || printHeldOf(current, can) || !key.current) return
      const split = printSplit(current.places)
      const ids = split.printable.map((place) => place.id)
      if (current.draft.printerId === 'PDF') {
        // The tab opens in the click; the bytes fill it.
        const tab = typeof window === 'undefined' ? null : window.open('', '_blank')
        setModel({ ...current, posting: true, problem: null })
        placeLabelsPdf(api, { locationIds: ids, copies: current.draft.copies, language: current.draft.language })
          .then(({ bytes, refused }) => {
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
            if (tab && !tab.closed) tab.location.href = url
            else {
              const link = document.createElement('a')
              link.href = url
              link.download = `bin-labels-${current.siteCode}.pdf`
              document.body.append(link)
              link.click()
              link.remove()
            }
            setTimeout(() => URL.revokeObjectURL(url), 120_000)
            // B-W2b-383 (XF8:05): places the API left out (changed since the page read them) are said; else the dialog closes.
            setModel((now) => (now && refused > 0 ? { ...now, posting: false, done: { jobs: [], refused: [], pdfLeftOut: refused } } : null))
          })
          .catch((error: unknown) => {
            tab?.close()
            setModel((now) => (now ? { ...now, posting: false, problem: blockProblemOf(error) } : now))
          })
        return
      }
      setModel({ ...current, posting: true, problem: null })
      printPlaceLabels(api, { printerId: current.draft.printerId, locationIds: ids, copies: current.draft.copies, language: current.draft.language }, key.current)
        .then((answer) => {
          const byId = new Map(current.places.map((place) => [place.id, place]))
          const refused = [
            ...split.refused.map((entry) => ({ code: entry.place.code, key: entry.key })),
            ...answer.refused.map((entry) => {
              const place = byId.get(entry.locationId)
              return { code: entry.code, key: (place && labelRefusalOf(place)) ?? 'wd.loc.label.refused.other' }
            }),
          ]
          setModel((now) => (now ? { ...now, posting: false, done: { jobs: answer.jobs, refused } } : now))
        })
        .catch((error: unknown) => setModel((now) => (now ? { ...now, posting: false, problem: blockProblemOf(error) } : now)))
    },
  }
  return { model, open, actions }
}
