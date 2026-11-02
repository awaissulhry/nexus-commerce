import type { BoardHour, BoardStation, LineBoard } from './schema'

/**
 * Made-up line boards for the design cases of SCR-173 (the wall) and its office preview: never real business data. No
 * `designScreen` here: each screen's own fixtures.ts names its cases.
 */

const uid = (n: number) => `0190f0e2-0000-7000-9173-${String(n).padStart(12, '0')}`
export const AT = '2026-10-29T09:42:05.000Z'

const reason = (code: string, labelIt: string, labelEn: string) => ({ code, labelIt, labelEn, labelI18n: { it: labelIt, en: labelEn }, icon: null, colour: null })

const hour = (h: number, done: number, target: number | null, state: BoardHour['state'], why?: ReturnType<typeof reason>): BoardHour => ({
  hour: h,
  label: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`,
  state,
  done,
  targetPieces: target,
  short: state === 'OVER' && target !== null && done < target,
  reason: why ?? null,
})

const station = (n: number, state: BoardStation['state'], material = false): BoardStation => {
  const looks = { MACHINE_DOWN: { icon: 'alert-octagon', tone: 'danger', shape: 'OCTAGON' }, CALLING: { icon: 'bell', tone: 'warning', shape: 'TRIANGLE' }, COMING: { icon: 'user-check', tone: 'info', shape: 'CIRCLE' }, CLEAR: { icon: 'check', tone: 'success', shape: 'SQUARE' } } as const
  return {
    id: uid(100 + n),
    code: `CUC-${String(n).padStart(2, '0')}`,
    name: `Cucitura ${n}`,
    call: state === 'CALLING' ? 'CALLING' : state === 'COMING' ? 'COMING' : 'CLEAR',
    material,
    machineDown: state === 'MACHINE_DOWN',
    state,
    look: looks[state],
  }
}

export const BOARD: LineBoard = {
  asOf: AT,
  line: { id: uid(1), code: 'L1', name: 'Linea giacche' },
  site: { id: uid(2), code: 'A1', name: 'Stabilimento dimostrativo', timeZone: 'Europe/Rome' },
  day: '2026-10-29',
  shift: { label: 'Mattina', start: '2026-10-29T05:00:00.000Z', end: '2026-10-29T13:00:00.000Z' },
  output: {
    done: 86,
    target: 192,
    targetSoFar: 96,
    pace: 'BEHIND',
    paceLook: { icon: 'trending-down', tone: 'warning' },
    shortHours: 1,
    hours: [hour(6, 24, 24, 'OVER'), hour(7, 25, 24, 'OVER'), hour(8, 16, 24, 'OVER', reason('BREAKDOWN', 'Guasto macchina', 'Machine breakdown')), hour(9, 21, 24, 'OVER'), hour(10, 0, 24, 'RUNNING'), hour(11, 0, 24, 'LATER'), hour(12, 0, 24, 'LATER'), hour(13, 0, 24, 'LATER')],
  },
  stations: [station(1, 'CLEAR'), station(2, 'CLEAR'), station(3, 'CALLING'), station(4, 'MACHINE_DOWN'), station(5, 'COMING'), station(6, 'CLEAR'), station(7, 'CALLING', true), station(8, 'CLEAR')],
  wip: {
    bundles: 21,
    pieces: 188,
    stuck: 2,
    operations: [
      { code: 'CUC-PRE', name: 'Preparazione', bundles: 4, pieces: 36, stuck: 0, level: 'MEDIUM', pile: false },
      { code: 'CUC-ASS', name: 'Cucitura assemblaggio', bundles: 12, pieces: 108, stuck: 2, level: 'HIGH', pile: true },
      { code: 'RIF', name: 'Rifinitura', bundles: 5, pieces: 44, stuck: 0, level: 'LOW', pile: false },
      { code: 'CQ', name: 'Controllo', bundles: 0, pieces: 0, stuck: 0, level: 'NONE', pile: false },
    ],
    capped: false,
  },
  quality: { dhu: '3.4', defects: 3, units: 89 },
  note: { shiftLabel: 'Mattina', topics: ['MATERIAL', 'QUALITY'], text: 'Nuovo lotto di pelle alle 11: controllare il colore prima di cucire.', at: '2026-10-29T06:10:00.000Z' },
}

export const NO_TARGET_BOARD: LineBoard = {
  ...BOARD,
  output: { ...BOARD.output, target: null, targetSoFar: null, pace: 'NO_TARGET', paceLook: { icon: 'minus', tone: 'neutral' }, shortHours: 0, hours: BOARD.output.hours.map((row) => ({ ...row, targetPieces: null, short: false, reason: null })) },
}

export const EMPTY_BOARD: LineBoard = {
  ...NO_TARGET_BOARD,
  shift: null,
  output: { ...NO_TARGET_BOARD.output, done: 0, hours: [] },
  stations: [],
  wip: { bundles: 0, pieces: 0, stuck: 0, operations: BOARD.wip.operations.map((row) => ({ ...row, bundles: 0, pieces: 0, stuck: 0, level: 'NONE', pile: false })), capped: false },
  quality: { dhu: null, defects: 0, units: 0 },
  note: null,
}

export const MANY_STATIONS_BOARD: LineBoard = { ...BOARD, stations: Array.from({ length: 18 }, (_, index) => station(index + 1, index % 7 === 3 ? 'CALLING' : index === 11 ? 'MACHINE_DOWN' : 'CLEAR')) }

export const BOARD_LINES = [
  { id: BOARD.line.id, code: 'L1', name: 'Linea giacche' },
  { id: uid(3), code: 'L2', name: 'Linea pantaloni' },
]
