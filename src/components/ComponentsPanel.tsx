import { useState } from 'react'
import type { ComponentSummary } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { stageCenterWorld } from '../lib/frameClipboard'
import { recordCreate } from '../lib/history'
import { posthog } from '../lib/posthog'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { ListHint, ListItem, ListMeta, ListSection, ListTitle } from './ui/list'

/* The Components tab: the canvas's component library. A component is one
   definition an agent instances into frames instead of redrawing, so this
   lists what exists, how big it is and how widely it is used — enough to see
   that a library is forming, and what is in it. */

/** Row thumbnails are 64px tall; a component is as wide as it declares. */
const thumb = 'h-16 w-16 shrink-0 rounded-[8px] border border-line bg-white object-cover object-top'

const variantTag =
  'shrink-0 rounded-full border border-current px-[7px] py-px font-mono text-[9px] uppercase text-accent-ink'

/** A component's markup size, at the scale a library row is read at. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export function ComponentsPanel() {
  const components = useStore((s) => s.components)

  return (
    <PanelBody className="flex flex-col py-2">
      <ListSection>
        <span>Components</span>
        <span>{components.length}</span>
      </ListSection>
      {components.length === 0 ? (
        <ListHint>
          No components yet. A component is a reusable piece of design — a button, a card, a nav bar — that agents
          instance into frames instead of drawing it again, so every screen shares one definition.
        </ListHint>
      ) : (
        components.map((c) => <ComponentRow key={c.id} component={c} />)
      )}
    </PanelBody>
  )
}

/** One component: its thumbnail, its name and size, and how many frames hold
 *  an instance. A row has two actions: insert an instance of the component as
 *  a new frame — centered in the view, on the page being watched, and tracking
 *  the library entry from then on — or copy its name for an agent to
 *  reference. */
function ComponentRow({ component: c }: { component: ComponentSummary }) {
  /* the variant's parent, when it is still in the library */
  const parentName = useStore((s) => s.components.find((x) => x.id === c.variantOf)?.name)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [insertFailed, setInsertFailed] = useState(false)

  const copyName = () => {
    navigator.clipboard.writeText(c.name).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, console.error)
  }

  /* the summary row carries no markup, so the full component is fetched first.
     Insertion follows the same rules as a frame preset: it lands centered in
     the view, and only a later page needs saying — the server auto-places on
     the first one. */
  const insert = async () => {
    setInserting(true)
    setInsertFailed(false)
    try {
      const component = await api.getComponent(c.id)
      const s = useStore.getState()
      const onFirstPage = !s.activePageId || s.canvas?.pages?.[0]?.id === s.activePageId
      const pageId = onFirstPage ? undefined : s.activePageId
      const center = stageCenterWorld()
      const frame = await api.createFrame(component.canvasId, {
        name: component.name,
        /* the markup goes in inside the same wrapper the server's
           insert_component builds. That wrapper is the whole of what makes the
           new frame an instance: update_component propagation, the
           delete_component guard and this row's own instance count all find an
           instance by its data-doop-component attribute. A fresh instance
           carries no overrides. */
        html: `<div data-doop-component="${component.id}">${component.html}</div>`,
        width: component.width,
        height: component.height,
        x: Math.round(center.x - component.width / 2),
        y: Math.round(center.y - component.height / 2),
        ...(pageId ? { pageId } : {}),
      })
      posthog.capture('frame_created', { via: 'component' })
      recordCreate(frame)
      useStore.getState().select(frame.id)
      /* last, and on its own: the frame is created and the canvas already
         shows it, so this only catches up the row's own count — the library
         list is the server's count of frames holding an instance, and a frame
         creation does not broadcast a components update. Deliberately not
         awaited and its failure only logged: the insert has succeeded by now,
         and a count that lands a beat late beats a row claiming it failed. */
      void api
        .listComponents(component.canvasId)
        .then((list) => useStore.getState().setComponents(list))
        .catch(console.error)
    } catch (err) {
      console.error(err)
      /* the row says so: a silent failure reads as a button that does nothing
         — most often the component was deleted while the row was on screen */
      setInsertFailed(true)
    } finally {
      /* either way the row stays usable: a stuck "Inserting…" would read as a
         button that does nothing */
      setInserting(false)
    }
  }

  return (
    <ListItem className="gap-1.5 py-2.5">
      <div className="flex items-center gap-2.5">
        {failed ? (
          <span className={`${thumb} flex items-center justify-center text-[10px] text-ink-faint`}>no preview</span>
        ) : (
          <img
            className={thumb}
            src={`/api/components/${c.id}/screenshot.png?scale=2`}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex items-center gap-1.5">
            <ListTitle className="truncate">{c.name}</ListTitle>
            {c.variantOf && (
              <span className={variantTag} title={parentName ? `Variant of ${parentName}` : 'Variant'}>
                variant
              </span>
            )}
          </div>
          <ListMeta>
            {Math.round(c.width)}×{Math.round(c.height)} · used in {c.instanceCount} frame
            {c.instanceCount === 1 ? '' : 's'}
          </ListMeta>
          <div className="flex items-center justify-between gap-2">
            <ListMeta>{bytes(c.htmlBytes)}</ListMeta>
            <div className="flex items-center gap-1">
              <Button variant="bare" size="pill" onClick={insert} disabled={inserting}>
                {inserting ? 'Inserting…' : 'Insert'}
              </Button>
              <Button variant="bare" size="pill" onClick={copyName}>
                {copied ? 'Copied' : 'Copy name'}
              </Button>
            </div>
          </div>
          {insertFailed && <ListMeta className="text-accent-ink">Couldn&rsquo;t insert — try again.</ListMeta>}
        </div>
      </div>
    </ListItem>
  )
}
