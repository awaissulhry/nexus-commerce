import {
  Archive,
  Ban,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  CircleX,
  FilePlus,
  FileText,
  Forward,
  GitPullRequest,
  History,
  Image,
  ListMinus,
  ListPlus,
  MapPin,
  PackageCheck,
  Palette,
  Paperclip,
  Pencil,
  PencilLine,
  RotateCcw,
  Send,
  Tag,
  Truck,
  Undo2,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

/**
 * owb-b4 w4.4 (design § 5zl: "one icon for each kind of change, the same in the office and for the customer") — a row's icon id (the
 * answer's `icon`: lucide kebab names, the domain's ACTION_ICONS) → its lucide icon. A fixed map, so the bundle holds these and not
 * every lucide icon. An id the map does not know draws a plain dot, never a crash: S2 adds an id here when the domain names a new one.
 */
export const LOG_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  'file-plus': FilePlus,
  pencil: Pencil,
  'list-plus': ListPlus,
  'pencil-line': PencilLine,
  'list-minus': ListMinus,
  users: Users,
  tag: Tag,
  paperclip: Paperclip,
  palette: Palette,
  send: Send,
  'rotate-ccw': RotateCcw,
  'undo-2': Undo2,
  'circle-x': CircleX,
  'circle-check': CircleCheck,
  'calendar-clock': CalendarClock,
  image: Image,
  'map-pin': MapPin,
  'git-pull-request': GitPullRequest,
  'package-check': PackageCheck,
  ban: Ban,
  archive: Archive,
  truck: Truck,
  warehouse: Warehouse,
  'file-text': FileText,
  forward: Forward,
  'check-check': CheckCheck,
  history: History,
})

/** The icon of an id, or null (the part draws a plain dot). */
export const logIconOf = (id: string | null | undefined): LucideIcon | null => (id && Object.hasOwn(LOG_ICONS, id) ? LOG_ICONS[id]! : null)
