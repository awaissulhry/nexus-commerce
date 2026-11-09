import { z } from 'zod'
import { DOCUMENT_CATEGORIES, QUESTION_KINDS, QUESTION_SECTIONS, type Question } from './questions'

/**
 * A question as the API answers it (B-W2b-172): one schema for the API's contract and the web's readers (the link page and
 * the supplier's record), so the three never drift. Words in Italian and English; every field beyond the four a question
 * always has is optional (factory-domain questions.ts).
 */
const words = z.object({ it: z.string(), en: z.string() })

export const questionSchema = z.object({
  key: z.string(),
  section: z.enum(QUESTION_SECTIONS),
  kind: z.enum(QUESTION_KINDS),
  required: z.boolean(),
  text: words,
  help: words.nullish(),
  explain: z.enum(['YES', 'NO']).nullish(),
  options: z.array(z.object({ code: z.string(), text: words })).nullish(),
  category: z.enum(DOCUMENT_CATEGORIES).nullish(),
  document: z.object({ title: words, paragraphs: z.object({ it: z.array(z.string()), en: z.array(z.string()) }) }).nullish(),
})
export type QuestionData = z.infer<typeof questionSchema>

/** Questions as the API answers them (the same values; the answer's arrays are plain lists). */
export const questionData = (questions: readonly Question[]): QuestionData[] => questions as unknown as QuestionData[]
