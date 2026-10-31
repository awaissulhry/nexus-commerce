'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { ddtPdfLink, fileLink, getDdt, getDocuments, getShipment, listDdts, listPackingLists, type Shipment } from '../api'
import { packDocuments, packingListToPrint, type PackDocument } from '../daily-model'
import { abilitiesOf, readProblem } from '../model'
import { presignedBytes } from '../files'
import type { Loaded } from '../record/record-model'
import type { PackModel } from './pack-model'
import { ShipmentPackView } from './view/ShipmentPackView'

/**
 * `/w/<company>/warehouse/shipments/<id>/pack` (SCR-067-pack; design tab:sh-tab-pack "All documents"): the shipment, its
 * live DDT, the packing list that lists the parcels as they are now (else the newest), and the Declaration of Conformity
 * and user information each style travels with — read once, each document's PDF fetched with files.read (the DDT from the
 * fiscal archive, the others through the files route), then drawn for paper. Opened in a new tab from the shipment.
 */
export function ShipmentPack({ shipmentId }: { shipmentId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/warehouse\/shipments\/[^/]+\/pack\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [shipment, setShipment] = useState<Loaded<Shipment>>({ status: 'loading' })
  const [ddt, setDdt] = useState<PackModel['ddt']>(null)
  const [sender, setSender] = useState('')
  const [documents, setDocuments] = useState<PackDocument[] | null>(null)
  const [files, setFiles] = useState<PackModel['files']>({})
  const [included, setIncluded] = useState<string[]>([])
  const [readAt, setReadAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    setShipment({ status: 'loading' })
    setDocuments(null)
    setFiles({})
    try {
      const value = await getShipment(api, shipmentId)
      setShipment({ status: 'ready', value })
      const [rows, versions, travel] = await Promise.all([listDdts(api, value.id), listPackingLists(api, value.id).catch(() => null), getDocuments(api, value.id).catch(() => null)])
      const liveRow = rows.find((row) => row.status === 'LIVE') ?? null
      const live = liveRow ? await getDdt(api, liveRow.id) : null
      setDdt(live ? { number: live.number, documentDate: live.documentDate, startAt: live.startAt, fileId: live.fileId } : null)
      setSender(live?.sender.name ?? '')
      const pack = packDocuments({ ddt: live ? { number: live.number, fileId: live.fileId } : null, ddtRequired: value.ddtRequired, packingList: packingListToPrint(versions), travel: travel?.documents ?? null })
      setDocuments(pack)
      setIncluded(pack.filter((entry) => entry.fileId).map((entry) => entry.key))
      setReadAt(new Date().toISOString())
      if (!can.readFiles) return
      for (const entry of pack) {
        if (!entry.fileId) continue
        const fileId = entry.fileId
        const read = entry.kind === 'DDT' && liveRow ? ddtPdfLink(api, liveRow.id) : fileLink(api, fileId)
        read
          .then((download) => presignedBytes(download))
          .then((data) => setFiles((current) => ({ ...current, [entry.key]: { data, problem: null } })))
          .catch((error: unknown) => setFiles((current) => ({ ...current, [entry.key]: { data: null, problem: isApiError(error) ? readProblem(error) : 'pack.fileFailed' } })))
      }
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setShipment({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setShipment({ status: 'forbidden' })
      else setShipment({ status: 'error', problem: readProblem(error) })
    }
  }, [api, shipmentId, can.view, can.readFiles])

  useEffect(() => {
    void load()
  }, [load])

  const model: PackModel = { prefix, allowed: can.view, readFiles: can.readFiles, company: session.company?.name ?? '', sender, shipment, ddt, documents, files, included, readAt }
  return (
    <ShipmentPackView
      model={model}
      actions={{
        onToggle: (key) => setIncluded((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])),
        onRetry: () => void load(),
      }}
    />
  )
}
