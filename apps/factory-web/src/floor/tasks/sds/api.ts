import { z } from 'zod'
import { CHEMICAL_USES, GHS_PICTOGRAMS, QUANTITY_UNITS, SIGNAL_WORDS } from '@nexus/factory-domain/safety/chemicals/rules'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { readFromStore } from '../../../record-panels/store'

/**
 * The cabinet QR's reads on the floor (B-W2b-143 on the API of the same step, apps/factory-api modules/safety/chemicals/floor.ts;
 * floor.work at the device's own site): what the tablet keeps — every chemical in use at its site with its cabinet, hazards,
 * place, PPE words and its current sheets (file id, size, SHA-256) — and one current sheet's PDF bytes (a 60-second presigned
 * GET read at once). No person, no money.
 */

export const keptSheetSchema = z.object({ id: z.string(), versionLabel: z.string(), revisedOn: z.string(), language: z.string(), fileId: z.string(), sizeBytes: z.number(), sha256: z.string() })
export type KeptSheet = z.infer<typeof keptSheetSchema>

export const floorChemicalSchema = z.object({
  id: z.string(),
  name: z.string(),
  supplier: z.string().nullable(),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)),
  signalWord: z.enum(SIGNAL_WORDS).nullable(),
  hazardStatements: z.array(z.string()),
  precautionStatements: z.array(z.string()),
  storagePlace: z.string(),
  cabinetCode: z.string().nullable(),
  maxQuantity: z.string().nullable(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable(),
  ppe: z.array(z.string()),
  current: z.array(keptSheetSchema),
})
export type FloorChemical = z.infer<typeof floorChemicalSchema>

export const packSchema = z.object({ siteId: z.string(), site: z.object({ code: z.string(), name: z.string() }), language: z.string(), at: z.string(), chemicals: z.array(floorChemicalSchema) })
export type SdsPack = z.infer<typeof packSchema>

/** GET /safety/floor/chemicals: the site's register as a tablet keeps it. */
export const readPack = (api: ApiClient, signal?: AbortSignal): Promise<SdsPack> => api.get('/safety/floor/chemicals', { schema: packSchema, signal })

/** GET /safety/floor/data-sheets/:id/download, then the bytes (checked against the SHA-256 by the keeper). */
export async function readSheetBytes(api: ApiClient, sheetId: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const answer = await api.get(`/safety/floor/data-sheets/${encodeURIComponent(sheetId)}/download`, { schema: z.object({ download: presignedSchema, sha256: z.string(), sizeBytes: z.number() }) })
  return { bytes: await readFromStore(answer.download), sha256: answer.sha256 }
}
