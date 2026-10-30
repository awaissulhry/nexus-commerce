import type { PhotoMark } from '@nexus/ui/components/PhotoCapture/index'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { PhotoCaptureLabView, type LabPhoto, type PhotoCaptureLabModel } from './view/PhotoCaptureLabView'

/**
 * SCR-247 — photo capture with markup (DS part D21, B-W2a-24; NEW id: the DS part has no screen of its own; every photo
 * step uses it — the floor's dock, DDT, machine, defect, return and final-inspection steps (B-W2a-73 … 76), the office's
 * "Report a problem" (plant.requests) and the claim and measure link pages (W2b)). The photo is made up: an SVG of a
 * stitched leather panel with a scuff and a stain, no person, no real product. In the browser the part works for real:
 * Start camera asks the browser (a refusal or no camera is said in words), drag or tap marks, the keyboard crosshair,
 * Undo / Clear, Use photo prints what the screen would upload — nothing is sent.
 */

const PANEL = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 900'><rect width='1200' height='900' fill='dimgray'/><rect x='150' y='120' width='900' height='660' rx='40' fill='saddlebrown'/><path d='M150 450 H1050 M600 120 V780' stroke='wheat' stroke-width='10' stroke-dasharray='30 20'/><circle cx='780' cy='300' r='46' fill='peru'/><path d='M300 610 q 60 -46 120 0' stroke='tan' stroke-width='16' fill='none'/></svg>",
)}`
const PHOTO: LabPhoto = { src: PANEL, width: 1200, height: 900 }

const MARKS: PhotoMark[] = [
  { kind: 'circle', center: { x: 0.65, y: 0.333 }, radius: 0.07 },
  { kind: 'arrow', from: { x: 0.12, y: 0.9 }, to: { x: 0.3, y: 0.66 } },
]

const base = (patch: Partial<PhotoCaptureLabModel> = {}): PhotoCaptureLabModel => ({ label: 'defect', ...patch })

export const designScreen = defineDesignScreen<PhotoCaptureLabModel>({
  screen: 'SCR-247',
  title: 'Photo capture with markup (DS part D21)',
  view: PhotoCaptureLabView,
  cases: [
    {
      id: 'camera',
      label: 'Camera: guide and faces hint',
      model: base(),
      note: 'Before the camera starts: the outline guide over the view, "Keep faces out of the picture" above it, Start camera and Use a file. Start camera asks the browser; the camera stops after the shot, on Retake, on Cancel and when the step closes.',
    },
    { id: 'camera-denied', label: 'Camera blocked', model: base({ camera: 'denied' }), note: 'The browser refused the camera: the reason in words, Try again, and Use a file is still there.' },
    { id: 'camera-missing', label: 'No camera', model: base({ camera: 'unavailable' }), note: 'A desktop without a camera: the file is the way in.' },
    {
      id: 'markup',
      label: 'Markup: arrows and circles',
      model: base({ photo: PHOTO, marks: MARKS }),
      note: 'A circle round the stain and an arrow at the scuff, numbered on the photo and listed in words under it. Drag to draw, tap to mark a spot; Undo mark (⌘Z) and Clear marks.',
    },
    {
      id: 'keyboard',
      label: 'Keyboard mark under way',
      model: base({ photo: PHOTO, marks: MARKS.slice(0, 1), tool: 'arrow', keyDraft: { cursor: { x: 0.3, y: 0.66 }, anchor: { x: 0.12, y: 0.9 } } }),
      note: 'Tab to the photo: the arrow keys move the crosshair (Shift further), Enter set the start, the dashed arrow shows where Enter draws it, Escape cancels. Each step is said.',
    },
    {
      id: 'ready',
      label: 'No markup: look and use',
      model: base({ label: 'dock', photo: PHOTO, markup: false }),
      note: 'A step that only needs the photo (the delivery at the dock, a supplier DDT): Retake or Use photo.',
    },
    {
      id: 'required',
      label: 'Use photo waits for a mark',
      model: base({ photo: PHOTO, required: true }),
      note: "The screen's rule (a defect photo must show where): Use photo is held with the reason on screen until a mark exists; Undo and Clear say there is nothing to remove.",
    },
    {
      id: 'offline',
      label: 'Offline (floor)',
      model: base({ label: 'machine', photo: PHOTO, marks: MARKS, offline: true, density: 'floor' }),
      note: 'Offline is not a reason to hold: the part gives the photo to the screen, which keeps it in the tablet\'s queue and sends it when the connection is back.',
    },
    {
      id: 'floor',
      label: 'Floor tablet',
      model: base({ label: 'machine', photo: PHOTO, marks: MARKS.slice(1), density: 'floor' }),
      note: 'The floor tier: glove-sized buttons, thick marks, the main action bottom right.',
    },
    {
      id: 'comfortable',
      label: 'Link page (comfortable)',
      model: base({ label: 'measure', guide: 'silhouette', density: 'comfortable' }),
      note: 'A measure link page: the silhouette guide, phone-sized controls.',
    },
    {
      id: 'phone',
      label: 'Phone width',
      model: base({ photo: PHOTO, marks: MARKS, density: 'comfortable', phone: true }),
      note: 'At phone width every action is a full row, the main one last; the photo keeps its shape.',
    },
    {
      id: 'read-only',
      label: 'No permission (held)',
      model: base({ photo: PHOTO, marks: MARKS.slice(0, 1), readOnly: true }),
      note: 'This person may only look: every action stays focusable and says why; the reason is on screen at rest.',
    },
  ],
})
