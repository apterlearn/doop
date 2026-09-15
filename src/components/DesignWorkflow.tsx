import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { DesignWorkflowStatus } from '../lib/api'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Note } from './ui/note'

/**
 * "Design this frame with a model pair I picked."
 *
 * The design workflow runs on the server: an implementer model writes a frame
 * from a brief, a deterministic review plus a judge model critique it, and the
 * implementer iterates until the judge passes. Both models come from the one
 * [OI]-compatible endpoint the operator configured, so the list below is
 * whatever that provider serves right now — a live list, not a fixed set of
 * tiers, which is why these are selects rather than chips.
 */

export function useDesignWorkflow(): {
  status: DesignWorkflowStatus | null
  refresh: () => void
  set: (next: DesignWorkflowStatus) => void
} {
  const [status, setStatus] = useState<DesignWorkflowStatus | null>(null)
  const refresh = useCallback(() => {
    api.designWorkflow().then(setStatus, () => {})
  }, [])
  useEffect(refresh, [refresh])
  return { status, refresh, set: setStatus }
}

/* the panel's row: the model-account row recipe, minus the "this provider is
   the connected one" tint — there is no connection here to tint */
const dwRow =
  'flex gap-[14px] border-b border-line-soft px-[22px] py-[18px] last:border-b-0 max-md:gap-3 max-md:px-4 max-md:py-[17px]'
/* pickers left, Save right, sharing one line — the model account's action row,
   bottom-aligned because these fields carry their labels above them */
const actionsRow =
  'mt-[18px] flex flex-wrap items-end justify-between gap-5 max-md:flex-col max-md:items-stretch max-md:gap-[10px]'
/* the model pickers: the paste-the-redirect field recipe from ModelAccount */
const maInput = 'rounded-[10px] border-ink px-3 py-[10px] font-mono focus:ring-0 md:text-xs'
/* the lines under the controls — one voice for a muted note, an error, or the
   provider being unreachable */
const dwNote = 'mt-[10px] block'
/* buttons in the responsive action rows centre their label once stacked */
const rowBtn = 'max-md:justify-center'

export function DesignWorkflowPanel() {
  const { status, refresh, set } = useDesignWorkflow()
  /* null while untouched, so the pickers track the server's pair until you
     change one — the same draft rule the account pane's fields use */
  const [draft, setDraft] = useState<{ implementer: string; judge: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!status) return null

  const implementer = draft?.implementer ?? status.implementerModel
  const judge = draft?.judge ?? status.judgeModel
  const dirty = implementer !== status.implementerModel || judge !== status.judgeModel
  /* the workflow is off until the server has an endpoint to call */
  const off = !status.configured
  const providerNote = status.modelsError ? `Could not reach the model provider — ${status.modelsError}` : ''

  const fail = (e: unknown) => {
    if (e instanceof ApiError) {
      setError(String(e.body.error ?? e.message.replace(/^\d+\s*/, '')))
      return
    }
    setError(e instanceof Error ? e.message : 'That did not work — try again')
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      set(await api.setDesignWorkflow(implementer.trim(), judge.trim()))
      setDraft(null)
    } catch (e) {
      fail(e)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const setImplementer = (next: string) => setDraft({ implementer: next, judge })
  const setJudge = (next: string) => setDraft({ implementer, judge: next })

  /* a stored id can outlive its entry in the provider's list — it still has to
     be selectable, or the picker would silently show a different model */
  const picker = (label: string, value: string, placeholder: string, onChange: (next: string) => void) => {
    const fieldId = `design-workflow-${label.toLowerCase()}`
    const listId = `${fieldId}-models`
    const ids = status.models.map((m) => m.id)
    const options = value && !ids.includes(value) ? [value, ...ids] : ids
    return (
      <Field label={label} labelVariant="form" htmlFor={fieldId} className="min-w-0 flex-1 sm:max-w-[280px]">
        {/* A provider can serve hundreds of models (surplus lists 406), so the
            list is a datalist, not a <select>: you type "kimi" and the browser
            filters, instead of scrolling the whole catalogue. It also makes the
            free-text path below the same control rather than a second one — an
            id the provider does not list is still a value the server accepts. */}
        <Input
          id={fieldId}
          className={maInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={busy || off}
          spellCheck={false}
          autoComplete="off"
          {...(options.length ? { list: listId } : {})}
        />
        {options.length > 0 && (
          <datalist id={listId}>
            {options.map((modelId) => (
              <option key={modelId} value={modelId} />
            ))}
          </datalist>
        )}
      </Field>
    )
  }

  return (
    <div className="flex flex-col">
      <section className={dwRow}>
        <div className="min-w-0 flex-1">
          <div className={actionsRow}>
            {picker('Implementer', implementer, 'deepseek-v4.1-flash', setImplementer)}
            {picker('Judge', judge, 'kimi-k3', setJudge)}
            <Button
              variant="primary"
              className={rowBtn}
              onClick={save}
              disabled={busy || off || !dirty || !implementer.trim() || !judge.trim()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>

          {off && <Note className={dwNote}>Design workflow off — set DESIGN_LLM_BASE_URL on the server.</Note>}
          {providerNote && <Note className={dwNote}>{providerNote}</Note>}
          {error && (
            <Note tone="error" size="sm" className={dwNote}>
              {error}
            </Note>
          )}
        </div>
      </section>
    </div>
  )
}
