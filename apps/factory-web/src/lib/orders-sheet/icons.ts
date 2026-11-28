import {
  AlertTriangle,
  Banknote,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  Hourglass,
  Image as ImageIcon,
  Lock,
  Mail,
  MessageCircle,
  Printer,
  Send,
  Trash2,
  Truck,
  Undo2,
  UserPen,
  X,
  type LucideIcon,
} from 'lucide-react'

/**
 * owb-of3 — a chip's or a bulk act's icon id (lucide kebab name, the door's choice) → its lucide icon. A fixed map, so the bundle
 * holds these and not every lucide icon. An id the map does not know draws no icon (the words still say it), never a crash.
 */
export const SHEET_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  'alert-triangle': AlertTriangle,
  banknote: Banknote,
  check: Check,
  'check-check': CheckCheck,
  clock: Clock,
  download: Download,
  'file-text': FileText,
  hourglass: Hourglass,
  image: ImageIcon,
  lock: Lock,
  mail: Mail,
  'message-circle': MessageCircle,
  printer: Printer,
  send: Send,
  'trash-2': Trash2,
  truck: Truck,
  'undo-2': Undo2,
  'user-pen': UserPen,
  x: X,
})

export const sheetIconOf = (id: string | null | undefined): LucideIcon | null => (id && Object.hasOwn(SHEET_ICONS, id) ? SHEET_ICONS[id]! : null)
