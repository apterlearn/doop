import { useState } from 'react'
import type { Component } from '../../shared/types'
import { api, ApiError, type ComponentPatch, type ComponentUpdateResult } from '../lib/api'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'

/* One library entry, opened whole. A row carries the summary only — the markup
   every instance is rendered from never reaches the list — so this is the one
   place a human reads and edits what the component actually is.

   Saving sends the fields that differ from what was opened, and nothing else:
   the markup is the field that reaches past the library (the server rewrites
   each frame holding an instance from it), so an untouched body must not
   travel, or a rename would replay markup onto every instance.

   The dialog writes nothing itself and holds no copy of the library: it hands
   the server's per-frame outcome back to the panel, which owns the row list. */

/** The largest size a component may declare, mirroring the server's own cap. */
const MAX_SIZE = 20_000

/** A size field, read the way the inspector's pixel fields are: a whole
 *  number, at least 1, or nothing at all. */
function pixels(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(Math.round(n), MAX_SIZE)
}

export function ComponentEditorDialog({
  component,
  onClose,
  onSaved,
}: {
  component: Component
  onClose: () => void
  /** the server's per-frame outcome, so the panel can say what propagated */
  onSaved: (result: ComponentUpdateResult) => void
}) {
  /* the fields are seeded once, from the record as it was fetched: this dialog
     edits a snapshot, so a broadcast landing mid-edit cannot move the ground
     under the cursor */
  const [name, setName] = useState(component.name)
  const [description, setDescription] = useState(component.description ?? '')
  const [width, setWidth] = useState(String(Math.round(component.width)))
  const [height, setHeight] = useState(String(Math.round(component.height)))
  const [html, setHtml] = useState(component.html)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nextName = name.trim()
  const nextDescription = description.trim()
  const nextWidth = pixels(width)
  const nextHeight = pixels(height)

  /* Only what differs. A description the server would store as nothing is
     sent empty on purpose — that is how the field is cleared. */
  const patch: ComponentPatch = {}
  if (nextName !== component.name) patch.name = nextName
  if (nextDescription !== (component.description ?? '')) patch.description = nextDescription
  if (nextWidth !== null && nextWidth !== component.width) patch.width = nextWidth
  if (nextHeight !== null && nextHeight !== component.height) patch.height = nextHeight
  if (html !== component.html) patch.html = html

  const changed = Object.keys(patch).length > 0
  /* both are the fields the dialog itself can judge; anything else the server
     would say is reported in its own words below */
  const problem = !nextName
    ? 'A component needs a name.'
    : nextWidth === null || nextHeight === null
      ? 'The width and the height are whole numbers, at least 1.'
      : null

  async function save() {
    if (saving || !changed || problem) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.updateComponent(component.id, patch)
      onSaved(result)
      onClose()
    } catch (err) {
      /* the dialog stays open with the edits intact — the markup in the box is
         the only copy of what the user has written so far */
      console.error(err)
      setError(
        err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t save the component.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal size="lg" onClose={onClose}>
      <>
        <ModalEyebrow>Component library</ModalEyebrow>
        <ModalTitle className="mt-1.5">Edit “{component.name}”</ModalTitle>
        <ModalLede>
          The library entry itself, not the frames instancing it. Changing the markup rewrites every frame holding an
          instance; name, description and size change only the entry, and a field left as it was is not sent at all.
        </ModalLede>

        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Field className="sm:col-span-2" label="Name" labelVariant="form" htmlFor="component-edit-name">
            <Input
              id="component-edit-name"
              autoFocus
              value={name}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            label="Description"
            labelVariant="form"
            htmlFor="component-edit-description"
            hint="One line on what this is for — agents read it when they pick a component to instance."
          >
            <Input
              id="component-edit-description"
              value={description}
              disabled={saving}
              placeholder="Optional"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {/* the same mono pixel fields the inspector edits a frame's size in */}
          <Field label="Width" labelVariant="form" htmlFor="component-edit-width">
            <Input
              id="component-edit-width"
              variant="mono"
              inputSize="sm"
              className="max-md:min-h-10"
              inputMode="numeric"
              value={width}
              disabled={saving}
              onChange={(e) => setWidth(e.target.value)}
            />
          </Field>
          <Field label="Height" labelVariant="form" htmlFor="component-edit-height">
            <Input
              id="component-edit-height"
              variant="mono"
              inputSize="sm"
              className="max-md:min-h-10"
              inputMode="numeric"
              value={height}
              disabled={saving}
              onChange={(e) => setHeight(e.target.value)}
            />
          </Field>
        </div>

        <Field
          className="mt-3.5"
          label="Markup"
          labelVariant="form"
          htmlFor="component-edit-html"
          hint="Saving a changed markup rewrites the frames carrying an instance of this component — each one is re-rendered from this body, so an edit made inside a frame on that instance is replaced. A frame an agent holds the lock on keeps its markup and is reported back instead."
        >
          <Textarea
            id="component-edit-html"
            rows={12}
            spellCheck={false}
            disabled={saving}
            className="max-h-[46vh] overflow-y-auto bg-[#17171b] p-3 font-mono text-[11.5px] leading-[1.55] text-[#e9e9ee] [tab-size:2] md:text-[11.5px]"
            value={html}
            onChange={(e) => setHtml(e.target.value)}
          />
        </Field>

        {error && (
          <Note className="mt-2.5 block" tone="error" size="sm">
            {error}
          </Note>
        )}
        {problem && !error && (
          <Note className="mt-2.5 block" tone="muted" size="sm">
            {problem}
          </Note>
        )}

        <ModalActions>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving || !changed || !!problem} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}
