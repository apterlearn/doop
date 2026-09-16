import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { Component, ComponentSummary } from '../../shared/types'
import { isReadOnly, useStore } from '../lib/store'
import { api, ApiError, type ComponentUpdateResult } from '../lib/api'
import { COMPONENT_DRAG_MIME, stageCenterWorld } from '../lib/frameClipboard'
import { recordCreate } from '../lib/history'
import { posthog } from '../lib/posthog'
import { ComponentEditorDialog } from './ComponentEditorDialog'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { Input } from './ui/input'
import { SearchIcon } from './ui/icons'
import { ListHint, ListItem, ListMeta, ListSection, ListTitle } from './ui/list'
import { Toast } from './ui/toast'

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

/** Catch the panel up after a row's write. A row is a summary and carries no
 *  canvasId of its own, so the canvas comes from the store — the library this
 *  panel is listing is the one open on it. */
function refreshPanel() {
  const canvasId = useStore.getState().canvas?.id
  if (canvasId) refreshComponents(canvasId)
}

/** The server's per-frame outcome as one line: how many frames took the new
 *  markup, and how many kept theirs — with the reasons for those on the
 *  toast's own tooltip. An edit that carried no markup reaches no frame, and
 *  says only that the entry changed. */
function propagated(result: ComponentUpdateResult): { text: string; detail?: string } {
  const took = result.updated.length
  const kept = result.skipped.length
  if (!took && !kept) return { text: 'Component updated' }
  return {
    text: kept
      ? `Updated — ${took} frame${took === 1 ? '' : 's'} re-rendered, ${kept} kept their markup`
      : `Updated — ${took} frame${took === 1 ? '' : 's'} re-rendered`,
    ...(kept ? { detail: result.skipped.map((s) => `${s.name} — ${s.reason}`).join('\n') } : {}),
  }
}

export function ComponentsPanel() {
  const components = useStore((s) => s.components)
  /* a share-link visitor and an admin's "view as" session have no path to a
     frame write, so the rows below lose their Insert and their drag; what is
     left is the library itself, which is worth reading either way */
  const readOnly = useStore(isReadOnly)
  const [query, setQuery] = useState('')
  /* the panel's one line about what a row's write did — an edit's propagation,
     a deletion. A row is what unmounts on a delete, and the propagation is not
     the row's to keep, so the message lives here */
  const [toast, setToast] = useState<{ text: string; detail?: string } | null>(null)
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

  /** What a row's write did, said once, for as long as it is worth reading: a
   *  propagation lists its skipped frames on the toast's own tooltip, so this
   *  one lingers longer than a plain confirmation. */
  function showToast(text: string, detail?: string) {
    setToast({ text, detail })
    window.setTimeout(() => setToast((current) => (current?.text === text ? null : current)), detail ? 6000 : 2400)
  }

  return (
    <>
      <PanelBody className="flex flex-col py-2">
        <ListSection>
          <span>Components</span>
          <span>{components.length}</span>
        </ListSection>
        {readOnly && <ListHint>Read only — sign in to place, edit or delete a component on this canvas.</ListHint>}
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
          shown.map((c) => <ComponentRow key={c.id} component={c} onToast={showToast} />)
        )}
      </PanelBody>
      {/* the row's writes are reported here rather than in the row, which the
          delete removes */}
      {toast && <Toast title={toast.detail}>{toast.text}</Toast>}
    </>
  )
}

/** One component: its thumbnail, its name and size, and how many frames hold
 *  an instance. A writer gets five things from a row: Insert places an
 *  instance as a new frame — centered in the view, on the page being watched,
 *  and tracking the library entry from then on — double-clicking the name (or
 *  Rename) edits that name in place, Edit opens the whole entry, Copy name
 *  hands the name to an agent to reference, and Delete ends the entry. The row
 *  itself drags: dropping it on the canvas places the instance where it landed
 *  instead of in the middle of the view. Every one of those but the name copy
 *  is a write, so a read-only viewer gets the row without them: the name still
 *  copies, which writes nothing. */
function ComponentRow({
  component: c,
  onToast,
}: {
  component: ComponentSummary
  /** the panel owns the one line about what a write did — the row that wrote
   *  is often the row the write removed */
  onToast: (text: string, detail?: string) => void
}) {
  /* the variant's parent, when it is still in the library */
  const parentName = useStore((s) => s.components.find((x) => x.id === c.variantOf)?.name)
  /* a viewer reads the row — thumbnail, name, size, usage — and is offered
     none of the writes: the drag, Insert, rename, edit and delete all reach
     the server, which refuses them on a ticket or a borrowed session */
  const readOnly = useStore(isReadOnly)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [insertFailed, setInsertFailed] = useState(false)
  /* the last refusal, in the server's words — a rename the canvas will not
     take, a component deleted from under the row */
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [opening, setOpening] = useState(false)
  /* the full record the editor needs: the row only has the summary */
  const [editing, setEditing] = useState<Component | null>(null)
  const [confirming, setConfirming] = useState(false)
  /* the server's reason for refusing a delete while frames still hold
     instances; set, it is what the second confirmation is about */
  const [refusal, setRefusal] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  /* Whether the drag that is starting began on a control. The browser drags
     the nearest draggable ancestor of whatever was pressed, so without this a
     press on a button would drag the row out from under the pointer. The row
     clears it as the press arrives (capture, before any control's own
     handler), and the control marks itself. */
  const fromControl = useRef(false)

  const copyName = () => {
    navigator.clipboard.writeText(c.name).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, console.error)
  }

  /** Whatever went wrong, in the server's own words when it has any — a
   *  refusal names the frames still holding an instance, and a status code
   *  would not. */
  function report(err: unknown, fallback: string) {
    console.error(err)
    setError(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : fallback)
  }

  /* what makes the drag a component drag: the id under a MIME only this app
     claims, which is what lets the Stage tell a library row from a file or a
     text selection. The text/plain copy is the fallback for anything that
     does not know the custom type. */
  const onDragStart = (e: DragEvent) => {
    if (fromControl.current) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData(COMPONENT_DRAG_MIME, c.id)
    e.dataTransfer.setData('text/plain', c.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  /** A rename is one field, so it commits in place: the row keeps showing the
   *  name the server holds until the server takes the new one, and a refusal
   *  leaves that name on screen with the server's words under it. */
  const rename = async (next: string) => {
    setRenaming(false)
    const name = next.trim()
    if (!name || name === c.name) return
    setError(null)
    try {
      await api.updateComponent(c.id, { name })
      /* the server broadcasts the new record, so the row's own name arrives on
         the wire; this only keeps the list in step with it */
      refreshPanel()
    } catch (err) {
      report(err, 'Couldn’t rename that component.')
    }
  }

  /** The editor edits a component whole, and a row carries no markup: the same
   *  fetch Insert makes, then the dialog. */
  const openEditor = async () => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      setEditing(await api.getComponent(c.id))
    } catch (err) {
      report(err, 'Couldn’t open that component.')
    } finally {
      setOpening(false)
    }
  }

  /** Delete the library entry. The server refuses while frames still hold an
   *  instance, and that refusal is not an error to report: it is the guard
   *  asking for a second, explicit decision, which is what `force` is. Either
   *  way the instances keep their markup and simply stop being bound to a
   *  library entry. */
  const remove = async (force: boolean) => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteComponent(c.id, force ? { force: true } : {})
      setConfirming(false)
      setRefusal(null)
      onToast(`Deleted “${c.name}”`)
      refreshPanel()
    } catch (err) {
      setConfirming(false)
      if (err instanceof ApiError && err.status === 409)
        setRefusal(
          typeof err.body.error === 'string' ? err.body.error : 'Frames still hold an instance of this component.',
        )
      else report(err, 'Couldn’t delete that component.')
    } finally {
      setDeleting(false)
    }
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
    <>
      {/* the field takes the pointer while a rename is open, so the row stops
          being draggable for as long as it is on screen */}
      <ListItem
        className={`gap-1.5 py-2.5${readOnly || renaming ? '' : ' cursor-grab active:cursor-grabbing'}`}
        draggable={!readOnly && !renaming}
        onDragStart={readOnly || renaming ? undefined : onDragStart}
        onPointerDownCapture={() => {
          fromControl.current = false
        }}
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
              {renaming ? (
                <InlineRename
                  initial={c.name}
                  onCommit={(next) => void rename(next)}
                  onCancel={() => setRenaming(false)}
                />
              ) : (
                <ListTitle
                  className="truncate"
                  title={readOnly ? undefined : 'Double-click to rename'}
                  onDoubleClick={readOnly ? undefined : () => setRenaming(true)}
                >
                  {c.name}
                </ListTitle>
              )}
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
              {/* a press anywhere in here is a press on a control, not the
                  start of a drag of the row */}
              <div
                onPointerDown={() => {
                  fromControl.current = true
                }}
                className="flex flex-wrap items-center justify-end gap-1"
              >
                {!readOnly && (
                  <>
                    <Button variant="bare" size="pill" onClick={insert} disabled={inserting}>
                      {inserting ? 'Inserting…' : 'Insert'}
                    </Button>
                    <Button variant="bare" size="pill" onClick={() => setRenaming(true)}>
                      Rename
                    </Button>
                    <Button
                      variant="bare"
                      size="pill"
                      disabled={opening}
                      title="Edit this library entry — its markup, its name, its size"
                      onClick={() => void openEditor()}
                    >
                      {opening ? 'Opening…' : 'Edit'}
                    </Button>
                  </>
                )}
                <Button variant="bare" size="pill" onClick={copyName}>
                  {copied ? 'Copied' : 'Copy name'}
                </Button>
                {!readOnly && (
                  <Button
                    variant="bare-danger"
                    size="pill"
                    disabled={deleting}
                    title="Delete this library entry"
                    onClick={() => setConfirming(true)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
            {insertFailed && <ListMeta className="text-accent-ink">Couldn&rsquo;t insert — try again.</ListMeta>}
            {error && <ListMeta className="text-accent-ink">{error}</ListMeta>}
          </div>
        </div>
      </ListItem>
      {/* Both dialogs portal out of the rail, so neither is clipped by the
          panel's scroll box nor by the row it is anchored to */}
      {editing && (
        <ComponentEditorDialog
          component={editing}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            const outcome = propagated(result)
            onToast(outcome.text, outcome.detail)
            /* the markup reached its frames through the ordinary frame-write
               path, so the canvas already shows it; this only catches the
               row's own size and usage up */
            refreshPanel()
          }}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Delete “${c.name}”?`}
        description="The library entry goes for good. Every frame holding an instance stops being bound to it — the markup stays on the canvas as ordinary design."
        confirmLabel="Delete component"
        destructive
        onConfirm={() => void remove(false)}
      />
      {/* the delete the server refused, asked a second time and said plainly:
          the reason above, and what forcing past it means below */}
      <ConfirmDialog
        open={refusal !== null}
        onOpenChange={(open) => !open && setRefusal(null)}
        title={`Delete “${c.name}” anyway?`}
        description={
          <>
            {refusal} Deleting it anyway leaves those frames exactly as they are — they simply stop being bound to a
            library entry, so a later edit to the component no longer reaches them.
          </>
        }
        confirmLabel="Delete anyway"
        destructive
        onConfirm={() => void remove(true)}
      />
    </>
  )
}

/** Renaming happens in the row: the field replaces the name, ↵ or a click away
 *  commits it. Escape drops the edit, and its own blur must not then commit
 *  what Escape just discarded — nor commit a second time after ↵. The Layers
 *  rail renames a layer through the same field; this is it for a component
 *  name. */
function InlineRename({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  /* the field has had its say — committed or dropped — so the blur that
     follows an unmount cannot say it again */
  const settled = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  return (
    <Input
      ref={ref}
      variant="bare"
      inputSize="auto"
      autoFocus
      className="h-[22px] w-full rounded-[5px] border border-ink bg-paper px-1 text-[12.5px] font-semibold md:text-[12.5px]"
      value={draft}
      aria-label="Component name"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          settled.current = true
          onCommit(draft.trim())
        }
        if (e.key === 'Escape') {
          settled.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        if (!settled.current) onCommit(draft.trim())
      }}
    />
  )
}
