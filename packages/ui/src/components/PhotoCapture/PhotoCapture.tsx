'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Camera, CameraOff, Check, Circle, Eraser, ImageUp, MoveUpRight, RotateCcw, ScanFace, TriangleAlert, Undo2, X } from 'lucide-react'
import { FloorButton } from '../../floor/FloorButton'
import {
  CENTRE,
  PHOTO_CAPTURE_WORDS,
  PHOTO_MAX_SIZE,
  PHOTO_QUALITY,
  arrowHead,
  cameraProblemOf,
  cameraProblemWords,
  describeMark,
  fill,
  fitSize,
  isCameraProblem,
  keyStep,
  markFromDrag,
  markInPixels,
  marksCount,
  pointIn,
  positionWords,
  stepAfterShot,
  strokeOf,
  photoHeldReason,
  type CameraProblem,
  type CameraState,
  type CapturedPhoto,
  type KeyDraft,
  type PhotoCaptureWords,
  type PhotoGuide,
  type PhotoMark,
  type PhotoPoint,
  type PhotoSource,
  type PhotoStep,
  type PhotoTool,
} from './photoCaptureModel'
import './photo-capture.css'

export interface PhotoCaptureProps {
  /** The part's name (a region): "Photo of the defect". */
  label: string
  /**
   * "Use photo": the photo, the marks as data and the photo with the marks drawn in. The app uploads it (files, the
   * floor's offline queue); the part sends nothing. While a returned promise runs, Use photo is held ("Preparing…").
   * The app says what went wrong if its upload fails.
   */
  onCapture: (photo: CapturedPhoto) => void | Promise<void>
  /** A Cancel button (the app closes the step or the dialog). */
  onCancel?: () => void
  /** Every change of the marks (the app's rule for `useHeldReason`, a draft it keeps). */
  onMarksChange?: (marks: readonly PhotoMark[]) => void
  /** Mark the photo with arrows and circles (default true). False: take the photo, look at it, use it. */
  markup?: boolean
  /** The outline drawn over the camera: `frame` (default), `silhouette` (a person, for measures) or `none`. */
  guide?: PhotoGuide
  /** The "Keep faces out of the picture" line above the camera (default true; GDPR minimisation). */
  facesHint?: boolean
  /** Start the camera at once (the browser asks first). Default false: the person presses Start camera. */
  autoStart?: boolean
  /** The longest side of what the part gives back, px (default 2048). */
  maxSize?: number
  /** JPEG quality, 0–1 (default 0.85). */
  quality?: number
  /**
   * A photo to mark from the start (an existing one, a design case): size in px. It must be same-origin, a `data:` /
   * `blob:` address or served with CORS, or the canvas cannot read it back.
   */
  defaultPhoto?: { src: string; width: number; height: number }
  defaultMarks?: readonly PhotoMark[]
  defaultTool?: PhotoTool
  /** Start with a keyboard mark under way (a design case). */
  defaultKeyDraft?: KeyDraft
  /** Start with the camera in this state (a design case; the browser decides in real use). */
  defaultCamera?: CameraProblem
  /** Why nothing can be done now (no permission): every action is held, said at rest and on each attempt. Offline is NOT a reason: the app queues the upload. */
  heldReason?: string | null
  /** The app's rule for Use photo ("Mark the problem first"), or a function of the marks. Held with this reason. */
  useHeldReason?: string | null | ((marks: readonly PhotoMark[]) => string | null | undefined)
  words?: Partial<PhotoCaptureWords>
  className?: string
}

interface Shot {
  src: string
  width: number
  height: number
  /** The photo as the part made it (camera, file); null for a given photo until Use photo. */
  blob: Blob | null
  source: PhotoSource
  /** The part made this object URL and revokes it. */
  ownUrl: boolean
}

interface Drag {
  from: PhotoPoint
  to: PhotoPoint
}

// ── Browser-only helpers (called from handlers, never while rendering) ───────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    if (!/^(data|blob):/.test(src)) image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('photo: the image did not load'))
    image.src = src
  })
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('photo: no JPEG'))), 'image/jpeg', quality)
  })
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

/** The colours the person saw on screen, read from the drawn marks (no colour is written in this file). */
function markColours(svg: SVGSVGElement | null): { core: string; outline: string; plate: string } {
  const read = (selector: string, property: 'stroke' | 'fill', variable: string): string => {
    const element = svg?.querySelector(selector)
    const value = element ? getComputedStyle(element)[property] : ''
    if (value && value !== 'none') return value
    return svg ? getComputedStyle(svg).getPropertyValue(variable).trim() : ''
  }
  return {
    core: read('.nds-photo-mark-core', 'stroke', '--nds-warning'),
    outline: read('.nds-photo-mark-outline', 'stroke', '--nds-tooltip-light-fg'),
    plate: read('.nds-photo-mark-badge', 'fill', '--nds-tooltip-light-bg'),
  }
}

/** The photo at `size`, with `marks` drawn in as they look on screen (numbered), as a JPEG. */
async function renderPhoto(image: HTMLImageElement, size: { width: number; height: number }, marks: readonly PhotoMark[], quality: number, svg: SVGSVGElement | null): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('photo: no canvas')
  context.drawImage(image, 0, 0, size.width, size.height)
  if (marks.length) {
    const colours = markColours(svg)
    const stroke = strokeOf(size.width, size.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    marks.forEach((mark, index) => {
      const px = markInPixels(mark, size.width, size.height)
      const path = new Path2D()
      if (px.kind === 'circle') {
        path.arc(px.center.x, px.center.y, Math.max(1, px.radius), 0, Math.PI * 2)
      } else {
        const [left, right] = arrowHead(px.from, px.to, stroke.head)
        path.moveTo(px.from.x, px.from.y)
        path.lineTo(px.to.x, px.to.y)
        path.moveTo(left.x, left.y)
        path.lineTo(px.to.x, px.to.y)
        path.lineTo(right.x, right.y)
      }
      context.strokeStyle = colours.outline
      context.lineWidth = stroke.outline
      context.stroke(path)
      context.strokeStyle = colours.core
      context.lineWidth = stroke.core
      context.stroke(path)
      const at = badgeAt(px)
      context.beginPath()
      context.arc(at.x, at.y, stroke.head * 0.6, 0, Math.PI * 2)
      context.fillStyle = colours.plate
      context.fill()
      context.lineWidth = stroke.core * 0.6
      context.strokeStyle = colours.outline
      context.stroke()
      context.fillStyle = colours.outline
      context.font = `bold ${Math.round(stroke.head * 0.75)}px sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(String(index + 1), at.x, at.y)
    })
  }
  return toJpeg(canvas, quality)
}

/** Where a mark's number sits: at an arrow's tail, at a circle's top left. */
function badgeAt(px: ReturnType<typeof markInPixels>): { x: number; y: number } {
  if (px.kind === 'arrow') return px.from
  const offset = px.radius * Math.SQRT1_2
  return { x: px.center.x - offset, y: px.center.y - offset }
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function MarkShape({ mark, index, width, height, preview }: { mark: PhotoMark; index?: number; width: number; height: number; preview?: boolean }) {
  const stroke = strokeOf(width, height)
  const px = markInPixels(mark, width, height)
  const shape =
    px.kind === 'circle'
      ? { d: `M ${px.center.x - px.radius} ${px.center.y} a ${px.radius} ${px.radius} 0 1 0 ${px.radius * 2} 0 a ${px.radius} ${px.radius} 0 1 0 ${-px.radius * 2} 0` }
      : (() => {
          const [left, right] = arrowHead(px.from, px.to, stroke.head)
          return { d: `M ${px.from.x} ${px.from.y} L ${px.to.x} ${px.to.y} M ${left.x} ${left.y} L ${px.to.x} ${px.to.y} L ${right.x} ${right.y}` }
        })()
  const at = badgeAt(px)
  return (
    <g className={`nds-photo-mark${preview ? ' is-preview' : ''}`}>
      <path className="nds-photo-mark-outline" d={shape.d} strokeWidth={stroke.outline} />
      {/* A mark under way is dashed (in the photo's own px, so the dash scales with the stroke). */}
      <path className="nds-photo-mark-core" d={shape.d} strokeWidth={stroke.core} strokeDasharray={preview ? `${stroke.core * 3} ${stroke.core * 2}` : undefined} />
      {index !== undefined ? (
        <g className="nds-photo-mark-number">
          <circle className="nds-photo-mark-badge" cx={at.x} cy={at.y} r={stroke.head * 0.6} strokeWidth={stroke.core * 0.6} />
          <text x={at.x} y={at.y} fontSize={stroke.head * 0.75} textAnchor="middle" dominantBaseline="central">
            {index + 1}
          </text>
        </g>
      ) : null}
    </g>
  )
}

function Crosshair({ draft, width, height }: { draft: KeyDraft; width: number; height: number }) {
  const stroke = strokeOf(width, height)
  const x = draft.cursor.x * width
  const y = draft.cursor.y * height
  const arm = stroke.head * 1.6
  const d = `M ${x - arm} ${y} L ${x + arm} ${y} M ${x} ${y - arm} L ${x} ${y + arm}`
  return (
    <g className="nds-photo-crosshair">
      <path className="nds-photo-mark-outline" d={d} strokeWidth={stroke.core + 2} />
      <path className="nds-photo-crosshair-line" d={d} strokeWidth={Math.max(2, stroke.core / 2)} />
      {draft.anchor ? <circle className="nds-photo-anchor" cx={draft.anchor.x * width} cy={draft.anchor.y * height} r={stroke.core * 1.6} strokeWidth={stroke.core * 0.6} /> : null}
    </g>
  )
}

function Guide({ guide }: { guide: PhotoGuide }) {
  if (guide === 'none') return null
  const shape =
    guide === 'silhouette' ? (
      <>
        <ellipse cx="200" cy="74" rx="30" ry="36" />
        <path d="M 128 292 L 138 176 Q 144 128 200 122 Q 256 128 262 176 L 272 292" />
      </>
    ) : (
      <>
        <rect x="44" y="34" width="312" height="232" rx="18" />
      </>
    )
  return (
    <svg className="nds-photo-guide" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false">
      <g className="nds-photo-guide-outline">{shape}</g>
      <g className="nds-photo-guide-line">{shape}</g>
    </svg>
  )
}

/**
 * PhotoCapture — a photo for a record, from the camera or a file, with arrows and circles drawn on it (gap D21,
 * "Photo capture with markup"; the floor's FloorPhotoCapture, the office's "Report a problem", every photo step: dock,
 * DDT, machine, defects, returns, link pages).
 *
 * - Capture: the camera through the browser only (`getUserMedia`, the rear camera), started when the person asks (or
 *   `autoStart`); an outline guide over the view and "Keep faces out of the picture" above it; "Use a file" always there
 *   (a camera that is blocked, missing or busy says so in words, with Try again). Every camera track stops after the
 *   shot, on Retake, on Cancel and when the part goes away.
 * - Markup: Arrow or Circle, drawn by dragging (a tap marks a spot), or by keyboard — the arrows move a crosshair
 *   (Shift further), Enter sets the start, Enter again draws, Escape cancels; Undo mark (⌘Z / Ctrl+Z) and Clear marks.
 *   Each mark is numbered on the photo and listed in words under it. Every step is said in one polite live region.
 * - Use photo gives the app the photo (JPEG, long edge ≤ `maxSize`, re-encoded so a file's metadata is gone), the marks as
 *   data (0..1 of the photo) and the photo with the marks drawn in. Held, never disabled: the part's state, the app's
 *   `heldReason` and its `useHeldReason` rule, each with its reason on screen.
 *
 * Data in, events out: no upload, no API call. Sized by the page density (`FloorButton`, `--nds-density-*`): big on the
 * floor tier, phone-sized on comfortable, console-sized at standard. Every word comes in through `words`. Its own entry
 * point (not the components barrel): `@nexus/ui/components/PhotoCapture/index`.
 */
export function PhotoCapture(props: PhotoCaptureProps) {
  const {
    label,
    onCapture,
    onCancel,
    onMarksChange,
    markup = true,
    guide = 'frame',
    facesHint = true,
    autoStart = false,
    maxSize = PHOTO_MAX_SIZE,
    quality = PHOTO_QUALITY,
    defaultPhoto,
    defaultMarks,
    defaultTool = 'circle',
    defaultKeyDraft,
    defaultCamera,
    heldReason,
    useHeldReason,
    className,
  } = props
  const words = useMemo<PhotoCaptureWords>(() => ({ ...PHOTO_CAPTURE_WORDS, ...props.words }), [props.words])
  const instructionsId = useId()
  const heldId = useId()

  const [shot, setShot] = useState<Shot | null>(() =>
    defaultPhoto && defaultPhoto.width > 0 && defaultPhoto.height > 0 ? { src: defaultPhoto.src, width: defaultPhoto.width, height: defaultPhoto.height, blob: null, source: 'given', ownUrl: false } : null,
  )
  const [step, setStep] = useState<PhotoStep>(() => (shot ? stepAfterShot(markup) : 'capture'))
  const [camera, setCamera] = useState<CameraState>(defaultCamera ?? 'idle')
  const [marks, setMarks] = useState<readonly PhotoMark[]>(() => defaultMarks ?? [])
  const [tool, setTool] = useState<PhotoTool>(defaultTool)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [keyDraft, setKeyDraft] = useState<KeyDraft | null>(defaultKeyDraft ?? null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [said, setSaid] = useState('')

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const surfaceRef = useRef<SVGSVGElement | null>(null)
  const mainRef = useRef<HTMLButtonElement | null>(null)
  const mounted = useRef(false)
  const stepRef = useRef(step)
  const shotRef = useRef(shot)
  const cameraWanted = useRef(false)
  const pointerFocus = useRef(false)
  const focusAfterStep = useRef(false)
  const marksSeen = useRef(marks)

  stepRef.current = step
  shotRef.current = shot

  const say = useCallback((text: string) => {
    // The same sentence twice is still said: the second one differs by a no-break space.
    setSaid((before) => (before === text ? `${text}\u00a0` : text))
  }, [])

  const stopCamera = useCallback(() => {
    stopStream(streamRef.current)
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const releaseShot = useCallback((old: Shot | null) => {
    if (old?.ownUrl && typeof URL !== 'undefined') URL.revokeObjectURL(old.src)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopStream(streamRef.current)
      streamRef.current = null
      releaseShot(shotRef.current)
    }
  }, [releaseShot])

  useEffect(() => {
    if (marksSeen.current === marks) return
    marksSeen.current = marks
    onMarksChange?.(marks)
  }, [marks, onMarksChange])

  // Focus follows the step the person moved to (never on the first paint).
  useEffect(() => {
    if (!focusAfterStep.current) return
    focusAfterStep.current = false
    if (step === 'markup') surfaceRef.current?.focus()
    else mainRef.current?.focus()
  }, [step])

  const goTo = useCallback((next: PhotoStep) => {
    focusAfterStep.current = true
    setStep(next)
  }, [])

  const startCamera = useCallback(async () => {
    if (heldReason) {
      say(heldReason)
      return
    }
    setProblem(null)
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.getUserMedia) {
      setCamera('unavailable')
      say(words.cameraUnavailable)
      return
    }
    setCamera('starting')
    say(words.cameraStarting)
    try {
      const stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
      if (!mounted.current || stepRef.current !== 'capture') {
        stopStream(stream)
        return
      }
      stopStream(streamRef.current)
      streamRef.current = stream
      cameraWanted.current = true
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play().catch(() => undefined)
      }
      setCamera('live')
      say(words.cameraLive)
    } catch (error) {
      if (!mounted.current) return
      const kind = cameraProblemOf(error)
      setCamera(kind)
      say(cameraProblemWords(kind, words))
    }
  }, [heldReason, say, words])

  useEffect(() => {
    if (autoStart && !defaultCamera && stepRef.current === 'capture') void startCamera()
    // Only on the first paint: later starts are the person's.
  }, [])

  // Leaving the capture step stops the camera.
  useEffect(() => {
    if (step !== 'capture') stopCamera()
  }, [step, stopCamera])

  const landShot = useCallback(
    (next: Shot, said: string) => {
      stopCamera()
      setCamera('idle')
      if (shotRef.current !== next) releaseShot(shotRef.current)
      setShot(next)
      setMarks([])
      setKeyDraft(null)
      setProblem(null)
      goTo(stepAfterShot(markup))
      say(said)
    },
    [goTo, markup, releaseShot, say, stopCamera],
  )

  const takePhoto = useCallback(async () => {
    if (heldReason) {
      say(heldReason)
      return
    }
    const video = videoRef.current
    if (!video || camera !== 'live') return
    const size = fitSize(video.videoWidth, video.videoHeight, maxSize)
    if (!size.width) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height
      canvas.getContext('2d')?.drawImage(video, 0, 0, size.width, size.height)
      const blob = await toJpeg(canvas, quality)
      if (!mounted.current) return
      landShot({ src: URL.createObjectURL(blob), width: size.width, height: size.height, blob, source: 'camera', ownUrl: true }, words.shotTaken)
    } catch {
      setProblem(words.prepareFailed)
      say(words.prepareFailed)
    }
  }, [camera, heldReason, landShot, maxSize, quality, say, words])

  const pickFile = useCallback(() => {
    if (heldReason) {
      say(heldReason)
      return
    }
    fileRef.current?.click()
  }, [heldReason, say])

  const onFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      let url = ''
      try {
        url = URL.createObjectURL(file)
        const image = await loadImage(url)
        const size = fitSize(image.naturalWidth, image.naturalHeight, maxSize)
        if (!size.width) throw new Error('photo: no size')
        const blob = await renderPhoto(image, size, [], quality, null)
        if (!mounted.current) return
        landShot({ src: URL.createObjectURL(blob), width: size.width, height: size.height, blob, source: 'file', ownUrl: true }, words.fileRead)
      } catch {
        setProblem(words.fileUnreadable)
        say(words.fileUnreadable)
      } finally {
        if (url) URL.revokeObjectURL(url)
      }
    },
    [landShot, maxSize, quality, say, words],
  )

  const retake = useCallback(() => {
    if (heldReason) {
      say(heldReason)
      return
    }
    releaseShot(shotRef.current)
    setShot(null)
    setMarks([])
    setKeyDraft(null)
    setDrag(null)
    setProblem(null)
    setCamera('idle')
    goTo('capture')
    if (cameraWanted.current) {
      // The person already let the camera in: open it again for the new shot.
      queueMicrotask(() => void startCamera())
    }
  }, [goTo, heldReason, releaseShot, say, startCamera])

  const cancel = useCallback(() => {
    stopCamera()
    onCancel?.()
  }, [onCancel, stopCamera])

  const addMark = useCallback(
    (mark: PhotoMark) => {
      say(fill(words.added, { mark: describeMark(mark, marks.length, words) }))
      setMarks([...marks, mark])
    },
    [marks, say, words],
  )

  const undo = useCallback(() => {
    if (heldReason) {
      say(heldReason)
      return
    }
    if (!marks.length) {
      say(words.undoNothing)
      return
    }
    say(fill(words.removed, { mark: describeMark(marks[marks.length - 1]!, marks.length - 1, words) }))
    setMarks(marks.slice(0, -1))
  }, [heldReason, marks, say, words])

  const clear = useCallback(() => {
    if (heldReason) {
      say(heldReason)
      return
    }
    if (!marks.length) {
      say(words.clearNothing)
      return
    }
    say(words.cleared)
    setMarks([])
    setKeyDraft((draft) => (draft ? { ...draft, anchor: null } : draft))
  }, [heldReason, marks, say, words])

  const pickTool = useCallback(
    (next: PhotoTool) => {
      setTool(next)
      say(fill(words.toolPicked, { tool: next === 'arrow' ? words.toolArrow : words.toolCircle }))
    },
    [say, words],
  )

  const photoHeld = photoHeldReason({ heldReason, busy, hasPhoto: shot !== null, marks, rule: useHeldReason, words })

  const confirmPhoto = useCallback(async () => {
    if (photoHeld) {
      say(photoHeld)
      return
    }
    const current = shotRef.current
    if (!current) return
    setBusy(true)
    setProblem(null)
    say(words.preparing)
    let result: CapturedPhoto
    try {
      const image = await loadImage(current.src)
      const size = fitSize(current.width, current.height, maxSize)
      const photo = current.blob && size.width === current.width && size.height === current.height ? current.blob : await renderPhoto(image, size, [], quality, null)
      const marked = marks.length ? await renderPhoto(image, size, marks, quality, surfaceRef.current) : null
      result = { photo, marks, marked, width: size.width, height: size.height, source: current.source }
    } catch {
      if (mounted.current) {
        setBusy(false)
        setProblem(words.prepareFailed)
        say(words.prepareFailed)
      }
      return
    }
    try {
      await onCapture(result)
    } catch {
      // The app's upload failed: the app says so in its own words.
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [marks, maxSize, onCapture, photoHeld, quality, say, words])

  // ── Markup surface: pointer and keyboard ──
  const aspect = shot ? shot.height / shot.width : 1

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerFocus.current = true
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (heldReason) {
      say(heldReason)
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const point = pointIn(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
    setDrag({ from: point, to: point })
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const point = pointIn(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
    setDrag({ from: drag.from, to: point })
  }
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerFocus.current = false
    if (!drag) return
    const point = pointIn(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
    setDrag(null)
    addMark(markFromDrag(tool, drag.from, point, aspect))
  }
  const onPointerCancel = () => {
    pointerFocus.current = false
    setDrag(null)
  }

  const onSurfaceFocus = (event: FocusEvent<SVGSVGElement>) => {
    // The crosshair comes with keyboard focus only (Tab, or focus moved after a key press); a pointer user draws.
    if (pointerFocus.current) return
    let visible = true
    try {
      visible = event.currentTarget.matches(':focus-visible')
    } catch {
      // An old browser without :focus-visible: show it.
    }
    if (visible) setKeyDraft((draft) => draft ?? { cursor: CENTRE, anchor: null })
  }
  const onSurfaceBlur = () => {
    // Tab away cancels a mark under way and hides the crosshair.
    setKeyDraft(null)
  }

  const onSurfaceKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      undo()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const draft = keyDraft ?? { cursor: CENTRE, anchor: null }
    if (heldReason && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      say(heldReason)
      return
    }
    const result = keyStep(draft, event.key, { shift: event.shiftKey, tool, aspect })
    if (result.kind === 'ignored') return
    event.preventDefault()
    event.stopPropagation()
    setKeyDraft(result.draft)
    if (result.kind === 'moved') {
      if (result.regionChanged || !keyDraft) say(fill(words.cursorAt, { at: positionWords(result.draft.cursor, words) }))
    } else if (result.kind === 'anchored') {
      say(fill(tool === 'arrow' ? words.startArrow : words.startCircle, { at: positionWords(result.draft.cursor, words) }))
    } else if (result.kind === 'tooShort') {
      say(words.tooShort)
    } else if (result.kind === 'cancelled') {
      say(words.markCancelled)
    } else if (result.kind === 'mark') {
      addMark(result.mark)
    }
  }

  const preview: PhotoMark | null = drag
    ? markFromDrag(tool, drag.from, drag.to, aspect)
    : keyDraft?.anchor
      ? markFromDrag(tool, keyDraft.anchor, keyDraft.cursor, aspect)
      : null

  // ── Render ──
  const root = ['nds-photo', className ?? ''].filter(Boolean).join(' ')
  const status = (
    <p className="nds-floor-sr" role="status" aria-live="polite">
      {said}
    </p>
  )
  const fileInput = (
    <input
      ref={fileRef}
      className="nds-floor-sr"
      type="file"
      accept="image/*"
      capture="environment"
      tabIndex={-1}
      aria-hidden
      aria-label={words.useFile}
      onChange={(event) => void onFile(event)}
    />
  )
  const heldNote = heldReason ? (
    <p className="nds-photo-note is-held" id={heldId}>
      <span className="nds-floor-icon" aria-hidden>
        <TriangleAlert />
      </span>
      <span>{heldReason}</span>
    </p>
  ) : null
  const problemNote = problem ? (
    <p className="nds-photo-note is-problem">
      <span className="nds-floor-icon" aria-hidden>
        <TriangleAlert />
      </span>
      <span>{problem}</span>
    </p>
  ) : null

  if (step === 'capture') {
    const live = camera === 'live'
    const cameraWords =
      camera === 'starting' ? words.cameraStarting : isCameraProblem(camera) ? cameraProblemWords(camera, words) : camera === 'idle' ? words.cameraOff : null
    const startHeld = heldReason || (camera === 'starting' ? words.cameraStarting : null)
    return (
      <section className={root} aria-label={label} data-step="capture" data-camera={camera}>
        {heldNote}
        <p className="nds-photo-hint">
          {facesHint ? (
            <span className="nds-photo-hint-line">
              <span className="nds-floor-icon" aria-hidden>
                <ScanFace />
              </span>
              <span>{words.facesHint}</span>
            </span>
          ) : null}
          {guide !== 'none' ? <span className="nds-photo-hint-line is-guide">{guide === 'silhouette' ? words.guideSilhouette : words.guideFrame}</span> : null}
        </p>
        <div className="nds-photo-viewfinder">
          <video ref={videoRef} className="nds-photo-video" playsInline muted aria-label={words.videoLabel} hidden={!live} />
          <Guide guide={guide} />
          {cameraWords ? (
            <p className="nds-photo-state">
              <span className="nds-floor-icon" aria-hidden>
                {isCameraProblem(camera) ? <CameraOff /> : <Camera />}
              </span>
              <span>{cameraWords}</span>
            </p>
          ) : null}
        </div>
        {problemNote}
        <div className="nds-photo-actions">
          {onCancel ? (
            <FloorButton variant="quiet" icon={<X />} onClick={cancel}>
              {words.cancel}
            </FloorButton>
          ) : null}
          <FloorButton icon={<ImageUp />} onClick={pickFile} heldReason={heldReason || null}>
            {words.useFile}
          </FloorButton>
          {live ? (
            <FloorButton ref={mainRef} variant="primary" size="lg" icon={<Camera />} onClick={() => void takePhoto()} heldReason={heldReason || null} className="nds-photo-main">
              {words.takePhoto}
            </FloorButton>
          ) : (
            <FloorButton ref={mainRef} variant="primary" size="lg" icon={<Camera />} onClick={() => void startCamera()} heldReason={startHeld} className="nds-photo-main">
              {isCameraProblem(camera) ? words.tryAgain : words.startCamera}
            </FloorButton>
          )}
        </div>
        {fileInput}
        {status}
      </section>
    )
  }

  const photo = shot!
  const stageStyle = { '--nds-photo-aspect': String(photo.width / photo.height) } as CSSProperties
  const marksWords = marksCount(marks.length, words)
  const undoHeld = heldReason || (marks.length ? null : words.undoNothing)
  const clearHeld = heldReason || (marks.length ? null : words.clearNothing)

  return (
    <section className={root} aria-label={label} data-step={step}>
      {heldNote}
      {step === 'markup' ? (
        <div className="nds-photo-toolbar">
          <div className="nds-photo-tools" role="group" aria-label={words.tools}>
            <span className="nds-photo-tools-label" aria-hidden>
              {words.tools}
            </span>
            <FloorButton variant={tool === 'arrow' ? 'primary' : 'secondary'} size="sm" icon={<MoveUpRight />} aria-pressed={tool === 'arrow'} onClick={() => pickTool('arrow')}>
              {words.toolArrow}
            </FloorButton>
            <FloorButton variant={tool === 'circle' ? 'primary' : 'secondary'} size="sm" icon={<Circle />} aria-pressed={tool === 'circle'} onClick={() => pickTool('circle')}>
              {words.toolCircle}
            </FloorButton>
          </div>
          <div className="nds-photo-tools">
            <FloorButton size="sm" icon={<Undo2 />} onClick={undo} heldReason={undoHeld}>
              {words.undo}
            </FloorButton>
            <FloorButton size="sm" icon={<Eraser />} onClick={clear} heldReason={clearHeld}>
              {words.clear}
            </FloorButton>
          </div>
        </div>
      ) : null}
      <div className="nds-photo-stage" style={stageStyle}>
        <img className="nds-photo-img" src={photo.src} alt={words.photoAlt} width={photo.width} height={photo.height} draggable={false} />
        {step === 'markup' ? (
          <svg
            ref={surfaceRef}
            className="nds-photo-surface"
            viewBox={`0 0 ${photo.width} ${photo.height}`}
            preserveAspectRatio="none"
            role="application"
            tabIndex={0}
            aria-label={words.surface}
            aria-describedby={heldReason ? `${instructionsId} ${heldId}` : instructionsId}
            data-tool={tool}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onFocus={onSurfaceFocus}
            onBlur={onSurfaceBlur}
            onKeyDown={onSurfaceKey}
          >
            {marks.map((mark, index) => (
              <MarkShape key={index} mark={mark} index={index} width={photo.width} height={photo.height} />
            ))}
            {preview ? <MarkShape mark={preview} width={photo.width} height={photo.height} preview /> : null}
            {keyDraft ? <Crosshair draft={keyDraft} width={photo.width} height={photo.height} /> : null}
          </svg>
        ) : (
          <svg className="nds-photo-surface is-still" viewBox={`0 0 ${photo.width} ${photo.height}`} preserveAspectRatio="none" aria-hidden focusable="false">
            {marks.map((mark, index) => (
              <MarkShape key={index} mark={mark} index={index} width={photo.width} height={photo.height} />
            ))}
          </svg>
        )}
      </div>
      {step === 'markup' ? (
        <>
          <p className="nds-photo-instructions" id={instructionsId}>
            {words.instructions}
          </p>
          <div className="nds-photo-marks">
            <p className="nds-photo-marks-count">{marksWords}</p>
            {marks.length ? (
              <ol className="nds-photo-marks-list" aria-label={marksWords}>
                {marks.map((mark, index) => (
                  <li key={index}>{describeMark(mark, index, words)}</li>
                ))}
              </ol>
            ) : null}
          </div>
        </>
      ) : null}
      {problemNote}
      {photoHeld && photoHeld !== heldReason && !busy ? (
        <p className="nds-photo-note is-held">
          <span className="nds-floor-icon" aria-hidden>
            <TriangleAlert />
          </span>
          <span>{photoHeld}</span>
        </p>
      ) : null}
      <div className="nds-photo-actions">
        {onCancel ? (
          <FloorButton variant="quiet" icon={<X />} onClick={cancel}>
            {words.cancel}
          </FloorButton>
        ) : null}
        <FloorButton icon={<RotateCcw />} onClick={retake} heldReason={heldReason || null}>
          {words.retake}
        </FloorButton>
        <FloorButton ref={step === 'review' ? mainRef : undefined} variant="primary" size="lg" icon={<Check />} onClick={() => void confirmPhoto()} heldReason={photoHeld} className="nds-photo-main">
          {busy ? words.preparing : words.usePhoto}
        </FloorButton>
      </div>
      {fileInput}
      {status}
    </section>
  )
}
