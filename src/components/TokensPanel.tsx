import { useState } from 'react'
import type { DesignTokens } from '../../shared/types'
import { cssForTokens } from '../../shared/tokens'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { PanelBody } from './ui/panel'

/* The Tokens tab: the canvas's palette, type and scales, editable by hand.
   These are bound into every frame at render time (never stored inside one),
   so a change here restyles the whole canvas at once. */

const sectionHead = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint'
const row = 'flex items-center gap-2'
const smallField = 'h-7 font-mono text-[12px]'
const removeButton = 'shrink-0 text-[13px] leading-none text-ink-faint hover:text-accent-ink'

/** A numeric list (spacing, radii, sizes, weights, leading) as comma-separated
 *  text: the scale is short, and one field is faster to edit than N rows. */
function ScaleField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string
  value: number[] | undefined
  hint: string
  onChange: (next: number[]) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={sectionHead}>{label}</span>
      <Input
        variant="mono"
        inputSize="sm"
        className={smallField}
        defaultValue={(value ?? []).join(', ')}
        placeholder={hint}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/[,\s]+/)
              .map((part) => Number.parseFloat(part))
              .filter((n) => Number.isFinite(n)),
          )
        }
      />
    </label>
  )
}

export function TokensPanel() {
  const canvas = useStore((s) => s.canvas)
  const canvasId = canvas?.id
  const stored = canvas?.tokens
  const signature = JSON.stringify(stored ?? null)
  const [draft, setDraft] = useState<DesignTokens | undefined>(stored)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /* A stable signature of what the server holds: the draft resets when an
     agent (or another tab) changes the tokens, but not on every render.
     Adjusted during render rather than in an effect, so the panel never paints
     a stale draft against the new server state. */
  const [synced, setSynced] = useState(signature)
  if (synced !== signature) {
    setSynced(signature)
    setDraft(stored)
    setError(null)
  }

  if (!canvasId) return null

  const draftOf = (): DesignTokens => draft ?? { colors: {}, updatedAt: 0, updatedBy: '' }
  const patch = (next: Partial<DesignTokens>) => setDraft({ ...draftOf(), ...next })

  const colors = Object.entries(draftOf().colors ?? {})
  const fonts = draftOf().fonts ?? {}

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.setTokens(canvasId, draftOf())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save the tokens')
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.setTokens(canvasId, null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not clear the tokens')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PanelBody className="flex flex-col gap-4 py-3">
      <p className="px-4 text-[12px] leading-[1.5] text-ink-soft">
        Every frame on this canvas renders with these values bound in — palette, type, spacing, radii and shadows. One
        change restyles the whole canvas; no frame HTML is rewritten.
      </p>

      <section className="flex flex-col gap-2 px-4">
        <span className={sectionHead}>Colors</span>
        {colors.map(([name, value]) => (
          <div key={name} className={row}>
            <Input
              variant="mono"
              inputSize="sm"
              className={cn(smallField, 'w-[38%]')}
              defaultValue={name}
              onBlur={(e) => {
                const next = e.target.value.trim()
                if (!next || next === name) return
                const entries = colors.map(([k, v]) => [k === name ? next : k, v] as const)
                patch({ colors: Object.fromEntries(entries) })
              }}
            />
            <Input
              variant="mono"
              inputSize="sm"
              className={smallField}
              defaultValue={value}
              onChange={(e) => patch({ colors: { ...draftOf().colors, [name]: e.target.value } })}
            />
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 rounded-full border border-line"
              style={{ background: value }}
            />
            <button
              type="button"
              className={removeButton}
              aria-label={`Remove color ${name}`}
              onClick={() => {
                const next = { ...draftOf().colors }
                delete next[name]
                patch({ colors: next })
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => patch({ colors: { ...draftOf().colors, [`color-${colors.length + 1}`]: '#000000' } })}
        >
          Add color
        </Button>
      </section>

      <section className="flex flex-col gap-2 px-4">
        <span className={sectionHead}>Fonts</span>
        {(['display', 'body', 'mono'] as const).map((key) => (
          <label key={key} className={row}>
            <span className="w-[38%] text-[12px] text-ink-soft">{key}</span>
            <Input
              variant="mono"
              inputSize="sm"
              className={smallField}
              defaultValue={fonts[key] ?? ''}
              placeholder="Inter"
              onChange={(e) => patch({ fonts: { ...fonts, [key]: e.target.value } })}
            />
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-2 px-4">
        <span className={sectionHead}>Type scale</span>
        <ScaleField
          label="Sizes (px)"
          value={draftOf().type?.size}
          hint="14, 16, 20"
          onChange={(size) => patch({ type: { ...draftOf().type, size } })}
        />
        <ScaleField
          label="Weights"
          value={draftOf().type?.weight}
          hint="400, 700"
          onChange={(weight) => patch({ type: { ...draftOf().type, weight } })}
        />
        <ScaleField
          label="Line heights"
          value={draftOf().type?.leading}
          hint="1.2, 1.5"
          onChange={(leading) => patch({ type: { ...draftOf().type, leading } })}
        />
      </section>

      <section className="flex flex-col gap-2 px-4">
        <span className={sectionHead}>Space &amp; shape</span>
        <ScaleField
          label="Spacing (px)"
          value={draftOf().spacing}
          hint="4, 8, 16, 24"
          onChange={(spacing) => patch({ spacing })}
        />
        <ScaleField label="Radii (px)" value={draftOf().radii} hint="0, 8, 16" onChange={(radii) => patch({ radii })} />
        <label className="flex flex-col gap-1">
          <span className={sectionHead}>Shadows (one per line)</span>
          <textarea
            className="min-h-[64px] w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-ink"
            defaultValue={(draftOf().shadows ?? []).join('\n')}
            placeholder="0 1px 2px rgba(0,0,0,.2)"
            onChange={(e) =>
              patch({
                shadows: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      </section>

      {error && <p className="px-4 text-[12.5px] text-accent-ink">{error}</p>}

      <div className="flex items-center gap-2 px-4">
        <Button size="sm" disabled={saving} onClick={save}>
          Save tokens
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={clear}>
          Clear
        </Button>
      </div>

      {draft && (
        <details className="px-4 pb-2">
          <summary className="cursor-pointer text-[11.5px] text-ink-faint">CSS variables</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-paper-deep p-2.5 font-mono text-[11px] text-ink-soft">
            {cssForTokens(draft)}
          </pre>
        </details>
      )}
    </PanelBody>
  )
}
