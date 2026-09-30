import type { StoredSheetLayout } from '@/design-system/grid/views/savedViewTransport'
import { layoutPart, type WorkingLayoutPayload } from './sheetLayoutMemory'

/** A failed legacy read is unknown, while the modern record's absence can still be verified. */
export async function readSheetWorkingLayout(
  read: (surface: string) => Promise<StoredSheetLayout<WorkingLayoutPayload> | null>,
  surface: string,
  legacySurface?: string,
) {
  const record = await read(surface)
  let layout = record ? layoutPart(record.filters) : null
  let error: string | null = null
  if (!record && legacySurface) {
    try { layout = layoutPart((await read(legacySurface))?.filters) }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load your previous saved layout' }
  }
  return { record, layout, error }
}

/** Only a user pin gesture may create/update the saved layout. AG also unpins during viewport changes. */
export function isUserColumnPin(source: string | undefined) {
  return source === 'columnMenu' || source === 'contextMenu' || source === 'uiColumnDragged'
    || source === 'toolPanelUi' || source === 'toolPanelDragAndDrop'
}
