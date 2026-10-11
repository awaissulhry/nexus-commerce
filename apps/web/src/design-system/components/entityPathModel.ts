/**
 * The words of `EntityPath` (Keyword Harvest DS lane H7, 2026-10-10) — pure, tested in Node.
 *
 * Where a thing sits, top first: Portfolio › Campaign › Ad group. A missing step (no portfolio) is left out, never
 * shown as a blank between two arrows.
 */
import type { EntityRef } from './entityLinksModel'

/** The arrow between steps, in the page and in the CSV. */
export const ENTITY_PATH_SEPARATOR = ' › '

/** The steps that exist, top first: null, undefined and nameless steps are left out. */
export function entityPathSteps(items: ReadonlyArray<EntityRef | null | undefined> | null | undefined): EntityRef[] {
  return (items ?? []).filter((i): i is EntityRef => !!i && typeof i.name === 'string' && i.name.trim() !== '')
}

/** "IT_Jacket › JACKET IT Broad › Broad group" — for the CSV, the clipboard, the quick filter and the hover; '' when empty. */
export const entityPathText = (items: ReadonlyArray<EntityRef | null | undefined> | null | undefined): string =>
  entityPathSteps(items).map((i) => i.name).join(ENTITY_PATH_SEPARATOR)

/** Where each step sits in the row: the first and last keep their names longest, the middle ones are cut first. */
export type EntityPathPlace = 'first' | 'middle' | 'last' | 'only'
export const entityPathPlace = (index: number, count: number): EntityPathPlace =>
  count <= 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle'

/** Sort by the whole path's words; an empty path sorts first. */
export function compareEntityPath(a: ReadonlyArray<EntityRef | null | undefined> | null | undefined, b: ReadonlyArray<EntityRef | null | undefined> | null | undefined): number {
  return entityPathText(a).localeCompare(entityPathText(b))
}
