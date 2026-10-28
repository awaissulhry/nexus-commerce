/**
 * The floor kit — design-system parts for the factory's floor tablets (gaps G2 G3 G4 G5 G8): the floor frame and its
 * shell parts, the scan field, the PIN pad, tiles, the big action bar, list rows and confirm feedback. Every part reads
 * the page density (`--nds-density-*`) and takes all its words from the app. Imported as `@/design-system/floor` in
 * the web, `@nexus/ui/floor` elsewhere.
 */
export { FloorFrame, FloorHeader, useConfirmFeedback, useFloorSettings, type FloorFrameProps, type FloorHeaderProps } from './FloorFrame'
export { FloorButton, type FloorButtonProps, type FloorButtonSize, type FloorButtonVariant } from './FloorButton'
export { OperatorChip, operatorInitials, type OperatorChipProps } from './OperatorChip'
export { OfflineBanner, type OfflineBannerProps } from './OfflineBanner'
export {
  offlineBannerState,
  type OfflineBannerInput,
  type OfflineBannerKind,
  type OfflineBannerState,
  type OfflineBannerTone,
} from './offlineBannerModel'
export { IdleOverlay, useIdleSignOut, type IdleOverlayProps, type IdleSignOut, type IdleSignOutOptions } from './IdleOverlay'
export { createIdleTimer, type IdleClock, type IdlePhase, type IdleSnapshot, type IdleTimer, type IdleTimerOptions } from './idleTimer'
export { FloorHelpButton, type FloorHelpButtonProps } from './FloorHelpButton'
export { ScanInput, type CameraScanner, type ScanCamera, type ScanInputProps } from './ScanInput'
export {
  CAMERA_REPEAT_MS,
  classifyBurst,
  createWedgeReader,
  isCameraRepeat,
  nextStamps,
  WEDGE_DEFAULTS,
  WEDGE_PAUSE_FACTOR,
  type ScanSource,
  type WedgeOptions,
  type WedgeReader,
  type WedgeStep,
} from './scanWedge'
export { PinPad, type PinPadProps } from './PinPad'
export { PIN_LENGTH, PIN_PAD_ROWS, isPinDigit, pinDots, pinKeyFromKeyboard, pinPress, type PinDigit, type PinKey } from './pinPadModel'
export { FloorTile, FloorTileGrid, type FloorTileGridProps, type FloorTileProps } from './Tiles'
export { FloorActionBar, type FloorAction, type FloorActionBarProps, type FloorActions } from './ActionBar'
export { FloorList, FloorListRow, type FloorListProps, type FloorListRowProps } from './FloorListRow'
export { FLOOR_TONES, type FloorTone } from './tone'
export {
  confirmFeedback,
  FEEDBACK_FLASH_MS,
  FEEDBACK_TONES,
  FEEDBACK_VIBRATION,
  type ConfirmFeedbackOptions,
  type ConfirmFeedbackResult,
  type FeedbackKind,
  type FeedbackTone,
} from './confirmFeedback'
