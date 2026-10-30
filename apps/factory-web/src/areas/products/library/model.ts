import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * Shared rules of the product libraries (Materials & trims SCR-047/048, Operations and Sizes & measurements SCR-049):
 * what a person may do (from their permissions and money grains), the problems in this catalogue's words (never the
 * API's message), and the small text helpers the three screens share. Pure: nothing here renders or fetches.
 */

export interface LibraryCan {
  /** product.materials.view: Materials & trims. */
  materials: boolean
  /** product.materials.manage: create, change, archive a material and its colours. */
  materialsManage: boolean
  /** product.materials.cost + money.cost: set the standard purchase price. */
  materialsCost: boolean
  /** money.cost: see a standard purchase price at all (the API drops it otherwise). */
  seesCost: boolean
  /** product.routing.view: the operation library (and a routing). */
  operations: boolean
  /** product.operations.manage: create, change, archive an operation. */
  operationsManage: boolean
  /** product.routing.manage: change a draft routing (update a step to the library's minutes). */
  routingManage: boolean
  /** product.styles.view: size scales, styles. */
  styles: boolean
  /** product.styles.manage: create and change size scales. */
  scalesManage: boolean
  /** compliance.certificates.view: certificates covering a material. */
  certificates: boolean
  /** quality.lots.view: a material's lots and their test results. */
  lots: boolean
  /** inventory.stock.view: what is in stock. */
  stock: boolean
  /** parties.view: the supplier picker. */
  parties: boolean
}

export function libraryCan(permissions: readonly string[]): LibraryCan {
  const held = new Set(permissions)
  const has = (permission: string) => held.has(permission)
  const seesCost = has('money.cost')
  return {
    materials: has('product.materials.view'),
    materialsManage: has('product.materials.manage'),
    materialsCost: has('product.materials.cost') && seesCost,
    seesCost,
    operations: has('product.routing.view'),
    operationsManage: has('product.operations.manage'),
    routingManage: has('product.routing.manage'),
    styles: has('product.styles.view'),
    scalesManage: has('product.styles.manage'),
    certificates: has('compliance.certificates.view'),
    lots: has('quality.lots.view'),
    stock: has('inventory.stock.view'),
    parties: has('parties.view'),
  }
}

/** A read's state: null value while it runs; a problem key when it failed. */
export interface Read<T> {
  value: T | null
  problem: string | null
}
export const reading = <T>(): Read<T> => ({ value: null, problem: null })
export const ready = <T>(value: T): Read<T> => ({ value, problem: null })
export const failed = <T>(problem: string): Read<T> => ({ value: null, problem })

export interface Notice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

/** A failed read in this catalogue's words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  switch (error.kind) {
    case 'signed_out':
    case 'forbidden':
    case 'not_found':
    case 'unavailable':
    case 'rate_limited':
    case 'contract':
      return `problem.read.${error.kind}`
    default:
      return 'problem.read.internal'
  }
}

export interface WriteProblem {
  key: string
  /** Read the record again (someone changed it meanwhile; COL-078: never overwritten). */
  reload: boolean
  /** The refused fields' paths without the `body/` part (`code`, `colours/2/code`), for a form to point at. */
  paths: string[]
  /** The API's own sentences, kept as data under our words (English). */
  messages: string[]
}

/** A refused write in this catalogue's words, with the fields it names. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false, paths: [], messages: [] }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, '').replace(/\./g, '/')).filter((path) => path !== '')
  const messages = error.issues.map((issue) => issue.message ?? '').filter((message) => message !== '')
  if (error.kind === 'conflict') {
    const moved = error.code === 'version_conflict' || paths.some((path) => path.split('/').includes('version'))
    if (moved) return { key: 'problem.write.moved', reload: true, paths, messages }
    if (/taken/i.test(error.message)) return { key: 'problem.write.codeTaken', reload: false, paths, messages }
    return { key: 'problem.write.state', reload: true, paths, messages: messages.length ? messages : [error.message] }
  }
  if (error.kind === 'invalid') return { key: 'problem.write.invalid', reload: false, paths, messages }
  if (error.kind === 'step_up') return { key: 'problem.write.stepUp', reload: false, paths, messages }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found', paths, messages }
  return { key: 'problem.write.internal', reload: false, paths, messages }
}

/** The form field a refused path is about: `thicknessMaxMm`, `composition/1/percent` → `composition`. */
export const fieldOf = (path: string): string => path.split('/')[0] ?? path

/** Whether a field (or one of its parts) was refused. */
export const refusedField = (paths: readonly string[], field: string): boolean => paths.some((path) => path === field || path.startsWith(`${field}/`))

/** A CSV line (RFC 4180 quoting). */
export function csvLine(values: readonly (string | number | null | undefined)[]): string {
  return values
    .map((value) => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

/** A CSV file from its header and rows. */
export const csvOf = (header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string => [csvLine(header), ...rows.map(csvLine)].join('\n')

/** Saves a text file in the browser (the BOM makes a spreadsheet read UTF-8). */
export function downloadCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A key that belongs to the page: not while typing, not inside a dialog or a menu, no modifier. */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')
}

/** "—" for an unknown value (never 0, never empty). */
export const dash = (value: string | number | null | undefined): string => (value === null || value === undefined || value === '' ? '—' : String(value))

/** The ids still loaded after a re-read (a selection never points at a row that is gone). */
export const keepLoaded = (selected: readonly string[], loaded: readonly { id: string }[] | null): string[] => {
  if (!loaded) return []
  const ids = new Set(loaded.map((row) => row.id))
  return selected.filter((id) => ids.has(id))
}
