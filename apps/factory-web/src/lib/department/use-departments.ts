'use client'

import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../api/client'
import { useLocale } from '../i18n/provider'
import { departmentOfAnswer, fixedDepartments, type Department, type DepartmentAnswer } from './model'
import { useDepartmentWords } from './words'

/**
 * owb-b4 w4.2 — the departments of the factory, read ONCE per tab from `GET /production/departments` (office: workorders.view or
 * product.styles.view; floor: floor.work — the API decides) with this web's own zod (every field but the four the parts draw is
 * optional: a new field never breaks a page), in the server's order (`seq`). Until it answers — and when it fails or the host has no
 * client — the parts draw the fixed table of the nine (the seed's looks, the catalogue's names), so a chip never waits.
 *
 * NOT in `view/`: a view fetches nothing. The host gives its own API client (office `useOfficeApi()`, the floor its device client).
 */

const departmentSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable().optional(),
  nameI18n: z.record(z.string(), z.string()).nullable().optional(),
  tone: z.string(),
  icon: z.string(),
  workCentreKind: z.string().optional(),
  seq: z.number().optional(),
  floorReady: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).nullable().optional(),
  // owb-pd6 (S4): the route builder's Manage sends it back with a rename, a close or an open.
  version: z.number().int().optional(),
})
export const departmentsAnswerSchema = z.object({ departments: z.array(departmentSchema) })
export type DepartmentsAnswer = z.infer<typeof departmentsAnswerSchema>

export const DEPARTMENTS_PATH = '/production/departments'
/** How long one read is used before a mount reads again (a department is renamed rarely). */
export const DEPARTMENTS_LIFE_MS = 5 * 60_000

/** One read (the host's client): the rows in the server's order. */
export async function readDepartments(api: ApiClient, signal?: AbortSignal): Promise<readonly DepartmentAnswer[]> {
  const answer = await api.get(DEPARTMENTS_PATH, { schema: departmentsAnswerSchema, signal })
  return [...answer.departments].sort((a, b) => (a.seq ?? a.number) - (b.seq ?? b.number))
}

let kept: { readonly rows: readonly DepartmentAnswer[]; readonly until: number } | null = null
let inflight: Promise<readonly DepartmentAnswer[]> | null = null

/** The kept rows while fresh, else undefined. */
export const keptDepartments = (now = Date.now()): readonly DepartmentAnswer[] | undefined => (kept && kept.until > now ? kept.rows : undefined)

/** One read for every mount of the tab (a read that is out is shared; a failed one is not kept). */
export function wantDepartments(api: ApiClient, now = Date.now()): Promise<readonly DepartmentAnswer[]> {
  const fresh = keptDepartments(now)
  if (fresh) return Promise.resolve(fresh)
  if (!inflight) {
    inflight = readDepartments(api).then(
      (rows) => {
        kept = { rows, until: Date.now() + DEPARTMENTS_LIFE_MS }
        inflight = null
        return rows
      },
      (error: unknown) => {
        inflight = null
        throw error
      },
    )
  }
  return inflight
}

/** Forget the kept read (tests; S4's department manage after a change). */
export function resetDepartments(): void {
  kept = null
  inflight = null
}

export interface DepartmentsState {
  /** The departments to draw: the server's once it answered, else the fixed table of the nine. */
  readonly departments: readonly Department[]
  /** `fixed`: the fixed table (not answered yet, no client, or the read failed); `ready`: the server's. */
  readonly state: 'fixed' | 'ready'
}

/** The departments in the page's language (the host's client; none: the fixed table). */
export function useDepartments(api: ApiClient | null | undefined): DepartmentsState {
  const locale = useLocale()
  const say = useDepartmentWords()
  const [rows, setRows] = useState<readonly DepartmentAnswer[] | undefined>(() => keptDepartments())
  useEffect(() => {
    if (!api) return
    let live = true
    wantDepartments(api).then(
      (answer) => live && setRows(answer),
      () => undefined, // the fixed table stays: a chip never shows an error
    )
    return () => {
      live = false
    }
  }, [api])
  return useMemo<DepartmentsState>(() => (rows && rows.length > 0 ? { departments: rows.map((row) => departmentOfAnswer(row, locale)), state: 'ready' } : { departments: fixedDepartments(say), state: 'fixed' }), [rows, locale, say])
}
