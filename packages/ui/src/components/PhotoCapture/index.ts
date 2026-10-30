/**
 * Photo capture with markup (gap D21) — an entry point of its own, NOT re-exported by the components barrel: the web pulls
 * that barrel into every page's first load, and this part brings the floor kit's `FloorButton` (the one density-aware
 * button) with its stylesheet, plus its own `photo-capture.css`. Import this folder (`@/design-system/components/PhotoCapture`
 * in the web, `@nexus/ui/components/PhotoCapture/index` by package path). Data in, events out: it returns the photo and
 * its marks; the app uploads them.
 */
export { PhotoCapture, type PhotoCaptureProps } from './PhotoCapture'
export {
  CENTRE,
  DEFAULT_RADIUS,
  KEY_STEP,
  KEY_STEP_BIG,
  MIN_MARK,
  PHOTO_CAPTURE_WORDS,
  PHOTO_MAX_SIZE,
  PHOTO_QUALITY,
  TAP_ARROW,
  arrowHead,
  cameraProblemOf,
  cameraProblemWords,
  clampPoint,
  describeMark,
  distance,
  fill,
  fitSize,
  isCameraProblem,
  keyStep,
  markFromDrag,
  markInPixels,
  marksCount,
  photoHeldReason,
  pointIn,
  positionOf,
  positionWords,
  stepAfterShot,
  strokeOf,
  type CameraProblem,
  type CameraState,
  type CapturedPhoto,
  type KeyDraft,
  type KeyStepResult,
  type PhotoCaptureWords,
  type PhotoGuide,
  type PhotoMark,
  type PhotoPoint,
  type PhotoPosition,
  type PhotoSource,
  type PhotoStep,
  type PhotoTool,
  type PixelMark,
} from './photoCaptureModel'
