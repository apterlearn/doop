import { useEffect, useRef, useState } from 'react'
import { api } from './api'

/** Renders frame HTML through the server's preview endpoint and hands back an
 *  object URL the browser can show in an <img>. The URL is owned here — the
 *  server answers with raw PNG bytes, so each fetch allocates a blob that
 *  only this hook can release — and stays alive while the component is. */
export function useHtmlPreview(html: string | undefined, width: number, height: number): string | null {
  const [state, setState] = useState<{ html: string; url: string } | null>(null)
  /* the URL of the newest render; the unmount cleanup revokes it, since no
     re-render happens after the component is gone */
  const current = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current)
    },
    [],
  )
  useEffect(() => {
    if (!html) return
    let live = true
    api
      .renderPreview(html, width, height)
      .then((url) => {
        if (!live) {
          URL.revokeObjectURL(url)
          return
        }
        setState((prev) => {
          if (prev && prev.url !== url) URL.revokeObjectURL(prev.url)
          current.current = url
          return { html, url }
        })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [html, width, height])
  /* a stale preview must never show under a different proposal or version */
  return state && state.html === html ? state.url : null
}
