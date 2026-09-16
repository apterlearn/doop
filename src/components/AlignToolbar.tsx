import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import { caughtStaleWrite, noteOwnWrite, recordUpdates, trackSave } from '../lib/history'
import { isReadOnly, useStore } from '../lib/store'
import { ToolbarButton, ToolbarDivider } from './ui/toolbar'

/* The multi-selection bar. It hangs off the end of the Stage's bottom toolbar
   and only exists while two or more frames are selected, so the single-frame
   canvas stays uncluttered.

   The geometry is deliberately local and boring: align uses the selection's
   bounding box, distribute keeps the first and last of the stack order in
   place and spreads the frames between them to even gaps. Locked frames take
   part in the box the rest align to — a locked frame is the natural reference
   — but never move themselves, mirroring the rule the server enforces on
   their content. Hidden frames are off the stage and so out of the maths
   entirely. */

type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom' | 'distribute-h' | 'distribute-v'

/** The order the buttons appear in: six aligns, then the two distributes. */
const MODES: AlignMode[] = ['left', 'hcenter', 'right', 'top', 'vmiddle', 'bottom', 'distribute-h', 'distribute-v']

/* Same 16px/stroke-2 recipe as ui/icons.tsx, declared here because these
   eight exist only for this bar. Each glyph is a rail plus the bars packed
   against it (or three rails, for the distribute pair). */
const glyphProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const GLYPHS: Record<AlignMode, { label: string; hint: string; paths: string[] }> = {
  left: { label: 'Align left', hint: 'Align left edges', paths: ['M4 4v16', 'M8 8h11', 'M8 16h6'] },
  hcenter: {
    label: 'Align horizontal centers',
    hint: 'Align horizontal centers',
    paths: ['M12 4v16', 'M5 8h14', 'M8 16h8'],
  },
  right: { label: 'Align right', hint: 'Align right edges', paths: ['M20 4v16', 'M5 8h11', 'M10 16h6'] },
  top: { label: 'Align top', hint: 'Align top edges', paths: ['M4 4h16', 'M8 8v11', 'M16 8v6'] },
  vmiddle: {
    label: 'Align vertical centers',
    hint: 'Align vertical centers',
    paths: ['M4 12h16', 'M8 5v14', 'M16 8v8'],
  },
  bottom: { label: 'Align bottom', hint: 'Align bottom edges', paths: ['M4 20h16', 'M8 5v11', 'M16 10v6'] },
  'distribute-h': {
    label: 'Distribute horizontally',
    hint: 'Even gaps left to right',
    paths: ['M3 4v16', 'M12 4v16', 'M21 4v16'],
  },
  'distribute-v': {
    label: 'Distribute vertically',
    hint: 'Even gaps top to bottom',
    paths: ['M4 3h16', 'M4 12h16', 'M4 21h16'],
  },
}

function Glyph({ mode }: { mode: AlignMode }) {
  return (
    <svg {...glyphProps} aria-hidden="true">
      {GLYPHS[mode].paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** One frame the mode moves, and where to. */
type Move = { id: string; patch: { x: number } | { y: number } }

/** What a mode would move. A frame the mode would leave where it is produces
 *  no move, so a click that changes nothing writes nothing and records no
 *  undo step. */
function plan(mode: AlignMode, selected: Frame[], all: Frame[]): Move[] {
  const moves: Move[] = []
  /* locked frames hold still but still define the box the rest align to — a
     locked frame is the natural reference to align against */
  const movable = selected.filter((f) => !f.locked)
  const left = Math.min(...selected.map((f) => f.x))
  const right = Math.max(...selected.map((f) => f.x + f.width))
  const top = Math.min(...selected.map((f) => f.y))
  const bottom = Math.max(...selected.map((f) => f.y + f.height))

  if (mode === 'distribute-h' || mode === 'distribute-v') {
    /* two frames are already evenly spaced; three is the first real case */
    if (movable.length < 3) return moves
    const pos = mode === 'distribute-h' ? 'x' : 'y'
    const size = mode === 'distribute-h' ? 'width' : 'height'
    /* the stack order is the sort position (z ascending, ties by array order,
       exactly what the Stage paints): the first frame keeps its leading edge
       and the last keeps its trailing one, and the frames between them are
       spread to one even gap each */
    const arrayOrder = new Map(all.map((f, i) => [f.id, i]))
    const line = [...movable].sort((a, b) => a.z - b.z || (arrayOrder.get(a.id) ?? 0) - (arrayOrder.get(b.id) ?? 0))
    const first = line[0]!
    const last = line[line.length - 1]!
    const span = last[pos] + last[size] - first[pos]
    const used = line.reduce((n, f) => n + f[size], 0)
    const gap = (span - used) / (line.length - 1)
    let cursor = first[pos]
    for (const f of line) {
      const next = Math.round(cursor)
      if (next !== f[pos]) moves.push({ id: f.id, patch: pos === 'x' ? { x: next } : { y: next } })
      cursor += f[size] + gap
    }
    return moves
  }

  const onX = mode === 'left' || mode === 'hcenter' || mode === 'right'
  for (const f of movable) {
    const value =
      mode === 'left'
        ? left
        : mode === 'right'
          ? right - f.width
          : mode === 'hcenter'
            ? left + (right - left - f.width) / 2
            : mode === 'top'
              ? top
              : mode === 'bottom'
                ? bottom - f.height
                : top + (bottom - top - f.height) / 2
    const next = Math.round(value)
    if (next !== (onX ? f.x : f.y)) moves.push({ id: f.id, patch: onX ? { x: next } : { y: next } })
  }
  return moves
}

export function AlignToolbar() {
  const selectedIds = useStore((s) => s.selectedIds)
  const canvas = useStore((s) => s.canvas)
  /* the whole bar is a write: every button moves frames. A viewer who cannot
     write gets no bar at all rather than eight dead controls */
  const readOnly = useStore(isReadOnly)
  if (selectedIds.length < 2 || readOnly) return null
  const selected = (canvas?.frames ?? []).filter((f) => selectedIds.includes(f.id) && !f.hidden)
  const movableCount = selected.filter((f) => !f.locked).length

  function apply(mode: AlignMode) {
    const s = useStore.getState()
    const all = s.canvas?.frames ?? []
    const picked = all.filter((f) => s.selectedIds.includes(f.id) && !f.hidden)
    const updates: { frameId: string; before: { x: number; y: number }; after: { x: number } | { y: number } }[] = []
    for (const { id, patch } of plan(mode, picked, all)) {
      const before = all.find((f) => f.id === id)
      if (!before) continue
      updates.push({ frameId: id, before: { x: before.x, y: before.y }, after: patch })
      useStore.getState().patchFrameLocal(id, patch)
      /* fire-and-forget, like every other geometry write: the local patch has
         already painted, and a failure leaves the frame where the server
         still has it. The frame's own updatedAt rides along as the
         precondition, so a frame someone else moved since the alignment was
         read is left alone instead of pulled back into the selection's line. */
      trackSave(
        api
          .updateFrame(id, patch, { expectedUpdatedAt: before.updatedAt })
          .then(noteOwnWrite)
          .catch((err: unknown) => {
            const conflict = caughtStaleWrite(err)
            if (conflict) console.error(conflict.error)
          }),
      )
    }
    /* the whole alignment is one undo step, exactly as a group drag is */
    recordUpdates(updates)
  }

  return (
    <>
      <ToolbarDivider />
      {MODES.map((mode) => {
        const spread = mode === 'distribute-h' || mode === 'distribute-v'
        return (
          <ToolbarButton
            key={mode}
            aria-label={GLYPHS[mode].label}
            title={GLYPHS[mode].hint}
            /* an align needs one frame that can move; a distribute needs
               three (two are already evenly spaced) */
            disabled={movableCount < (spread ? 3 : 1)}
            className="disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={() => apply(mode)}
          >
            <Glyph mode={mode} />
          </ToolbarButton>
        )
      })}
    </>
  )
}
