import { FloorIncident } from '../../../../floor/tasks/incident/Incident'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/incident` — Report an incident: someone hurt first (112, first aiders, a call for help), then what, where, photo (SCR-230, B-W2b-137). */
export default function FloorIncidentPage() {
  return <FloorIncident />
}
