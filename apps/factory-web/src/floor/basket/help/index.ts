/**
 * owner owb-fl8 — the basket page's help parts, imported by fl5's page ONLY from here (_owb-fl-common.md § 7). Pick C: no floor
 * chat; the 4th tile is Notes (read only). fl5 placed this file with stubs; owb-fl8 replaces its bodies (the export names stay).
 *
 *   tiles     ProblemTile · AskTile · PhotoTile · NotesTile — each ONE button (icon above its word, 48 px and more) with its own
 *             window; fl5 draws them in one row
 *   windows   ProblemWindow · AskWindow · PhotoWindow · NotesWindow — { open, onClose, read, onChanged }: fl5's "Ask your team
 *             leader" (a hold, not on its route, restricted) opens AskWindow
 *   cards     ProblemCard (the red card: Told → The team leader comes → Solved) · AskCard (the open ask, "An answer for you") —
 *             nothing drawn when the basket has none, so the page mounts them always
 *   leader    CallAnswerButtons (On my way → Solved) for a list that holds a call
 *
 * Props: `read` = fl1's basket read as fl5 parsed it (a structural subset, `HelpRead`), `onChanged` = read the basket again.
 */
export { HELP2_NAMESPACE } from './words'
export type { CallFlag, HelpRead } from './api'
export { ProblemTile, AskTile, ProblemWindow, AskWindow, type TileProps, type WindowProps } from './HelpTiles'
export { PhotoTile, PhotoWindow } from '../photo/PhotoTile'
export { NotesTile, NotesWindow } from '../notes/NotesTile'
export { ProblemCard } from './ProblemCard'
export { AskCard } from './AskCard'
export { CallAnswerButtons } from './CallAnswerButtons'

/** The help parts are built: fl5's page draws the 4-tile row and "Ask your team leader" only when this is true (no dead button). */
export const HELP_READY = true
