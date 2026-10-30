import { floorVersionResponse } from '../../../../floor/install'

/**
 * Which floor app version this server serves now (PLT-241, B-W2a-42): the tablet compares it with the version its page
 * runs and updates only when its offline queue is empty (floor/queue/update.ts); Admin › Devices marks a tablet that
 * reports another version as outdated. Public like the manifest: it says nothing but the version.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return floorVersionResponse()
}
