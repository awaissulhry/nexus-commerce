// MC.3.5 — XHR-based upload helper with progress + abort.
//
// fetch() is the right call almost everywhere except multipart with
// progress. The Streams-API Upload Progress proposal exists but is
// not yet shipping, so per-byte progress still lives on
// XMLHttpRequest. This thin wrapper gives us the same async/await
// shape as fetch + a progress callback.

export type UploadProgress = (pct: number) => void

export interface XhrUploadResult {
  status: number
  ok: boolean
  body: unknown
}

export interface XhrUploadOptions {
  url: string
  method?: 'POST' | 'PUT'
  body: FormData | string
  headers?: Record<string, string>
  onProgress?: UploadProgress
  signal?: AbortSignal
}

export function xhrUpload({
  url,
  method = 'POST',
  body,
  headers,
  onProgress,
  signal,
}: XhrUploadOptions): Promise<XhrUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    if (headers) {
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    }

    if (signal) {
      // External abort → terminate the in-flight request and reject
      // with a plain Error instead of a DOMException so callers can
      // pattern-match on err.message.
      const onAbort = () => {
        xhr.abort()
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      // Any 2xx is OK; 4xx/5xx come back as ok=false with the parsed
      // JSON body so callers can read the error message.
      let parsed: unknown = null
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        parsed = xhr.responseText
      }
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        body: parsed,
      })
    }

    xhr.onerror = () =>
      reject(new Error('network error during upload'))
    xhr.ontimeout = () => reject(new Error('upload timed out'))

    xhr.send(body)
  })
}
