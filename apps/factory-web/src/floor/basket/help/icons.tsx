import type { ReactNode } from 'react'
import { Eye, FileX, Image, Layers, Mic, PenTool, Send, TriangleAlert, UserCheck, Wrench } from 'lucide-react'
import type { AskCode, AskTo, ProblemCode } from './model'

/**
 * owb-fl8 — the icon of each problem and ask (design P/core.js PROBLEMS, ASKS_F, ASK_TO; lucide only). The word, never the icon
 * alone, names the tile; the icon says it to a worker who reads little.
 */

export function problemIcon(code: ProblemCode | string): ReactNode {
  switch (code) {
    case 'MATERIAL':
      return <Layers />
    case 'DAMAGED':
      return <TriangleAlert />
    case 'UNCLEAR':
      return <Eye />
    case 'MACHINE':
      return <Wrench />
    case 'PAPER':
      return <FileX />
    default:
      return <TriangleAlert />
  }
}

export function askIcon(code: AskCode | string): ReactNode {
  switch (code) {
    case 'ASK_LOGO':
      return <Image />
    case 'ASK_PATCH':
      return <Layers />
    case 'ASK_TO_PATCH':
      return <Send />
    case 'ASK_UNCLEAR':
      return <Eye />
    case 'ASK_OTHER':
      return <Mic />
    default:
      return <UserCheck />
  }
}

/** Who answers: the designer (a pen) or the team leader (a person with a tick). */
export const askToIcon = (to: AskTo): ReactNode => (to === 'DESIGNER' ? <PenTool /> : <UserCheck />)
