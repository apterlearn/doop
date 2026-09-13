import { useEffect, useRef, useState } from 'react'
import { withTokenStyle } from '../../shared/tokens'
import { api } from './api'
import { useStore } from './store'

/** Renders frame HTML through the server's preview endpoint and hands back an
 *  object URL the browser can show in an <img>. The URL is owned here — the
 *  server answers with raw PNG bytes, so each fetch allocates a blob that
 *  only this hook can release — and stays alive while the component is.
 *
 *  The canvas's design tokens are bound into the HTML before it is sent, so a
 *  preview matches what the canvas and the server's own renders show. */
export function useHtmlPreview(html: string | undefined, width: number, height: number): string | null {
  const tokens = useStore((s) => s.canvas?.tokens)
  const bound = html === undefined ? undefined : withTokenStyle(html, tokens)
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
    if (!bound) return
    let live = true
    api
      .renderPreview(bound, width, height)
      .then((url) => {
        if (!live) {
          URL.revokeObjectURL(url)
          return
        }
        setState((prev) => {
          if (prev && prev.url !== url) URL.revokeObjectURL(prev.url)
          current.current = url
          return { html: bound, url }
        })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [bound, width, height])
  /* a stale preview must never show under a different proposal or version */
  return state && state.html === bound ? state.url : null
}
