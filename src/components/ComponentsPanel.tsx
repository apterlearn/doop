import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import type { ComponentSummary } from '../../shared/types'
import { isReadOnly, useStore } from '../lib/store'
import { api } from '../lib/api'
import { COMPONENT_DRAG_MIME, stageCenterWorld } from '../lib/frameClipboard'
import { recordCreate } from '../lib/history'
import { posthog } from '../lib/posthog'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { SearchIcon } from './ui/icons'
import { ListHint, ListItem, ListMeta, ListSection, ListTitle } from './ui/list'

/* The Components tab: the canvas's component library. A component is one
   definition an agent instances into frames instead of redrawing, so this
   lists what exists, how big it is and how widely it is used — enough to see
   that a library is forming, and what is in it. */

/** Row thumbnails are 64px tall; a component is as wide as it declares. */
const thumb = 'h-16 w-16 shrink-0 rounded-[8px] border border-line bg-white object-cover object-top'

const variantTag =
  'shrink-0 rounded-full border border-current px-[7px] py-px font-mono text-[9px] uppercase text-accent-ink'

/* the filter field, at the Layers rail's size: a hairline shell the input
   sits in, so the icon and the caret read as one control */
const searchRow =
  'mx-3 mt-2.5 mb-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-ink-faint focus-within:border-ink'

/** A component's markup size, at the scale a library row is read at. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** Catch this panel's instance counts up after an instance was placed. Only
 *  the server counts instances (it walks the canvas's frames) and a frame
 *  creation broadcasts no component update, so the two places that place one
 *  — the Insert button and a drop on the canvas — ask again. Deliberately not
 *  awaited and its failure only logged: the frame is on the canvas by then,
 *  and a count that lands a beat late beats a row claiming the insert
 *  failed. Creating a *component* needs none of this: that broadcast exists,
 *  and the store folds it in. */
export function refreshComponents(canvasId: string) {
  void api
    .listComponents(canvasId)
    .then((list) => useStore.getState().setComponents(list))
    .catch(console.error)
}

export function ComponentsPanel() {
  const components = useStore((s) => s.components)
  /* a share-link visitor and an admin's "view as" session have no path to a
     frame write, so the rows below lose their Insert and their drag; what is
     left is the library itself, which is worth reading either way */
  const readOnly = useStore(isReadOnly)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  /* There is no category on a component — the record carries a name, a
     description and a size — so the filter is a text match over what a row
     actually shows, not a taxonomy the data does not have. */
  const shown = useMemo(
    () =>
      q
        ? components.filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
        : components,
    [components, q],
  )

  return (
    <PanelBody className="flex flex-col py-2">
      <ListSection>
        <span>Components</span>
        <span>{components.length}</span>
      </ListSection>
      {readOnly && <ListHint>Read only — sign in to place a component on this canvas.</ListHint>}
      {components.length > 0 && (
        <label className={searchRow}>
          <SearchIcon width={13} height={13} className="flex-none" />
          <Input
            variant="bare"
            inputSize="auto"
            className="h-full text-[12.5px] md:text-[12.5px]"
            placeholder="Search components"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {components.length === 0 ? (
        <ListHint>
          No components yet. A component is a reusable piece of design — a button, a card, a nav bar — that agents
          instance into frames instead of drawing it again, so every screen shares one definition.
        </ListHint>
      ) : shown.length === 0 ? (
        <ListHint>Nothing matches “{query.trim()}”.</ListHint>
      ) : (
        shown.map((c) => <ComponentRow key={c.id} component={c} />)
      )}
    </PanelBody>
  )
}

/** One component: its thumbnail, its name and size, and how many frames hold
 *  an instance. A row has two actions: insert an instance of the component as
 *  a new frame — centered in the view, on the page being watched, and tracking
 *  the library entry from then on — or copy its name for an agent to
 *  reference. The row itself drags: dropping it on the canvas places the
 *  instance where it landed instead of in the middle of the view. Both of
 *  those are frame writes, so a read-only viewer gets the row without them:
 *  the name still copies, which writes nothing. */
function ComponentRow({ component: c }: { component: ComponentSummary }) {
  /* the variant's parent, when it is still in the library */
  const parentName = useStore((s) => s.components.find((x) => x.id === c.variantOf)?.name)
  /* a viewer reads the row — thumbnail, name, size, usage — and is offered
     neither way to place an instance: both the drag and Insert are frame
     writes, and the server refuses them on a ticket or a borrowed session */
  const readOnly = useStore(isReadOnly)
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

  /* what makes the drag a component drag: the id under a MIME only this app
     claims, which is what lets the Stage tell a library row from a file or a
     text selection. The text/plain copy is the fallback for anything that
     does not know the custom type. */
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(COMPONENT_DRAG_MIME, c.id)
    e.dataTransfer.setData('text/plain', c.id)
    e.dataTransfer.effectAllowed = 'copy'
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
         shows it, so this only catches up the row's own count */
      refreshComponents(component.canvasId)
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
    <ListItem
      className={`gap-1.5 py-2.5${readOnly ? '' : ' cursor-grab active:cursor-grabbing'}`}
      draggable={!readOnly}
      onDragStart={readOnly ? undefined : onDragStart}
      title={readOnly ? undefined : 'Drag onto the canvas to place it, or Insert to center it in the view'}
    >
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
              {!readOnly && (
                <Button variant="bare" size="pill" onClick={insert} disabled={inserting}>
                  {inserting ? 'Inserting…' : 'Insert'}
                </Button>
              )}
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
