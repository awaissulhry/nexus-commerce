import { z } from 'zod'
import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-213: the severity classes and the tenant's words (GET / PUT /quality/severity; QualitySettings.severityTexts). The
 * words in force are the tenant's over the standard Italian and English ones; critical's meaning stays the locked text.
 */

const itEn = z.object({ it: z.string(), en: z.string() })
const byLanguage = z.record(z.string(), z.string())

export const severitySchema = z.object({
  classes: z.array(
    z.object({
      class: z.enum(DEFECT_CLASSES),
      rank: z.number().int(),
      words: itEn,
      meaning: itEn,
      acceptanceNumber: z.number().int().nullable(),
      locked: z.boolean(),
      law: z.string().nullable(),
      defects: z.number().int(),
      own: z.object({ words: byLanguage, meaning: byLanguage }).optional().default({ words: {}, meaning: {} }),
      standard: z.object({ words: itEn, meaning: itEn }).optional(),
    }),
  ),
  safetyRule: z.object({ it: z.string(), en: z.string(), law: z.string() }),
  editable: z.boolean(),
  languages: z.array(z.string()).optional().default(['it', 'en']),
  canManage: z.boolean().optional().default(false),
  version: z.number().int().optional().default(0),
  updatedAt: z.string().nullable().optional().default(null),
})
export type Severity = z.infer<typeof severitySchema>
export type SeverityClassRow = Severity['classes'][number]

/** GET /quality/severity (quality.defects.view). */
export const readSeverity = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/severity', { schema: severitySchema, signal })

export type SeverityTexts = Partial<Record<(typeof DEFECT_CLASSES)[number], Partial<Record<'words' | 'meaning', Record<string, string>>>>>

/** PUT /quality/severity (quality.defects.manage over every company): the whole set, or null for the standard texts. */
export const saveSeverity = (api: ApiClient, body: { version: number; texts: SeverityTexts | null }, idempotencyKey: string) =>
  api.request('PUT', '/quality/severity', { body, schema: severitySchema, idempotencyKey })
