import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { boardSchema, type LineBoard } from '../../lib/line-board/schema'

/** The line board of this DISPLAY device (B-W2b-50): its device cookie alone; the Office's preview reads the same board. */
const displaySchema = boardSchema.extend({ device: z.object({ id: z.string(), name: z.string(), mode: z.literal('DISPLAY') }) })

export function readDisplayBoard(api: ApiClient): Promise<LineBoard> {
  return api.get('/production/boards/display', { schema: displaySchema })
}
