/**
 * The KPI library's file in the browser (SCR-249 Export definitions, SCR-470 Export this definition): the CSV the person
 * sees, written here (the definitions are the library's own answer: nothing new is read).
 */
export function download(text: string, name: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}
