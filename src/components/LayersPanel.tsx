import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { isReadOnly, useStore, visibleFrames } from '../lib/store'
import { api } from '../lib/api'
import { setFrameStackOrder } from '../lib/frameOrder'
import { getIdentity } from '../lib/identity'
import { caughtStaleWrite, deleteFramesTracked, noteOwnWrite, recordUpdate } from '../lib/history'
import { ancestorsOf, buildLayerTree, elementHtml, filterLayers, renameElement, type LayerNode } from '../lib/layers'
import { deleteLayer, duplicateLayer, replaceLayerHtml } from '../lib/layerEdits'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { LayerKindIcon } from './LayerKindIcon'
import { FrameContextMenu } from './FrameContextMenu'
import { Panel, PanelBody, PanelHeader } from './ui/panel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip } from './ui/tooltip'
import { Toast } from './ui/toast'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { MenuHint } from './ui/menu'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  LayersIcon,
  LockIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
  SearchIcon,
  UnlockIcon,
} from './ui/icons'

/* the tree indents 18px per level; frame rows sit at depth 0 */
const INDENT = 18

const railBtn = 'shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink'
const sectionBtn = 'size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink'
const editorChip = 'inline-flex flex-none items-center gap-[3px] rounded-full px-1.5 text-[9.5px] font-bold text-white'

function rowKey(frameId: string, selector: string) {
  return `${frameId}|${selector}`
}

/* one parse per frame html, shared between the search filter and the rows —
   keyed by id and checked against the html, so a drag (a new frame object,
   same html) never re-parses */
const treeCache = new Map<string, { html: string; tree: LayerNode[] }>()
function frameTree(frame: Frame): LayerNode[] {
  const hit = treeCache.get(frame.id)
  if (hit && hit.html === frame.html) return hit.tree
  const tree = buildLayerTree(frame.html)
  treeCache.set(frame.id, { html: frame.html, tree })
  return tree
}

/** One visible line of the tree. The list is flat so the arrow keys can walk
 *  it, and every element row knows its parent for ←. */
type VisibleRow =
  | { kind: 'frame'; key: string; frame: Frame; open: boolean; empty: boolean }
  | { kind: 'node'; key: string; frame: Frame; node: LayerNode; depth: number; open: boolean; parentKey: string }

function visibleRows(frames: Frame[], query: string, expanded: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = []
  for (const frame of frames) {
    const tree = query ? filterLayers(frameTree(frame), query) : null
    if (query && !frame.name.toLowerCase().includes(query) && tree?.length === 0) continue
    const open = !!query || expanded.has(frame.id)
    const nodes = open ? (tree ?? frameTree(frame)) : []
    rows.push({ kind: 'frame', key: frame.id, frame, open, empty: open && nodes.length === 0 })
    const walk = (list: LayerNode[], depth: number, parentKey: string) => {
      for (const node of list) {
        const key = rowKey(frame.id, node.selector)
        const nodeOpen = node.children.length > 0 && (!!query || expanded.has(key))
        rows.push({ kind: 'node', key, frame, node, depth, open: nodeOpen, parentKey })
        if (nodeOpen) walk(node.children, depth + 1, key)
      }
    }
    walk(nodes, 1, frame.id)
  }
  return rows
}

/** The Layers rail: every frame on the page being viewed, opening into the
 *  element tree of its HTML. Selection runs both ways — a row selects the
 *  element in the frame, a click in the frame highlights its row. */
export function LayersPanel({ onAddFrame }: { onAddFrame: () => void }) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  /* the tree lists the page being viewed, like the stage — front-to-back, so
     the topmost frame is the rail's first row. Reversing before the (stable)
     sort makes a z tie fall the stage's way: the later array item paints in
     front, so it reads first here too. */
  const frames = useMemo(
    () =>
      visibleFrames({ canvas, activePageId })
        .slice()
        .reverse()
        .sort((a, b) => b.z - a.z),
    [canvas, activePageId],
  )
  const selectedId = useStore((s) => s.selectedId)
  const selectedElement = useStore((s) => s.selectedElement)
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  /* the tree stays a tree for a viewer — selecting, folding and searching all
     work — but every edit it offers (adding, reordering, locking, hiding,
     deleting, renaming) is gone */
  const readOnly = useStore(isReadOnly)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  /* the rail's own status line: a deleted frame leaves the tree with nothing
     else to say it happened, and the panel has no other toast to ride on */
  const [toast, setToast] = useState<string | null>(null)
  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }
  function deleteFrameRow(frame: Frame) {
    /* the count is the server's answer, not the size of the request: a frame
       somebody else already removed is not one more the user just trashed */
    deleteFramesTracked([frame])
      .then((n) => {
        if (n > 0) showToast(`${n} frame${n === 1 ? '' : 's'} moved to trash — undo with ⌘Z`)
      })
      .catch(console.error)
  }
  /* a frame drag in flight: which row is moving, and which edge of which row
     the pointer is over. The refs carry the same facts for the handlers —
     dragstart, dragover and drop can land in one task, before React has
     re-rendered the callbacks — while the state only paints the drag */
  const dragFrom = useRef<string | null>(null)
  const dragEdge = useRef<{ id: string; edge: 'before' | 'after' } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  function endDrag() {
    dragFrom.current = null
    dragEdge.current = null
    setDragId(null)
    setDropAt(null)
  }

  /* the selected frame opens on its own, and a selection made inside a frame
     opens every row above it — derived from the selection during render, not
     in an effect, so the tree is right on the first paint */
  const [seenFrame, setSeenFrame] = useState(selectedId)
  if (seenFrame !== selectedId) {
    setSeenFrame(selectedId)
    if (selectedId) setExpanded((prev) => new Set(prev).add(selectedId))
  }
  const [seenElement, setSeenElement] = useState(selectedElement)
  if (seenElement !== selectedElement) {
    setSeenElement(selectedElement)
    if (selectedElement) {
      const { frameId, selector } = selectedElement
      const frame = frames.find((f) => f.id === frameId)
      const above = frame ? (ancestorsOf(frameTree(frame), selector) ?? []) : []
      setExpanded((prev) => {
        const next = new Set(prev).add(frameId)
        for (const node of above) next.add(rowKey(frameId, node.selector))
        return next
      })
    }
  }

  function setOpen(key: string, open: boolean) {
    setExpanded((prev) => {
      if (prev.has(key) === open) return prev
      const next = new Set(prev)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /* a frame dragged onto another's half lands on that side of it, and the
     whole page goes out as one front-to-back order — the rail's own order is
     what the write wants, so no geometry is involved */
  function dropFrame(fromId: string, targetId: string, edge: 'before' | 'after') {
    if (fromId === targetId) return
    const ids = frames.map((f) => f.id)
    const from = ids.indexOf(fromId)
    const target = ids.indexOf(targetId)
    if (from < 0 || target < 0) return
    ids.splice(from, 1)
    /* the target's index moves with the removal when it sat behind the source */
    ids.splice((from < target ? target - 1 : target) + (edge === 'after' ? 1 : 0), 0, fromId)
    if (ids.every((id, i) => id === frames[i]?.id)) return
    const pageId = activePageId ?? frames[0]?.pageId
    if (!pageId) return
    /* the module logs its own failures: a lost write is a late paint, never
       lost work, since the server's broadcast settles every client */
    void setFrameStackOrder(pageId, ids)
  }

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => visibleRows(frames, q, expanded), [frames, q, expanded])
  const currentKey = selectedElement ? rowKey(selectedElement.frameId, selectedElement.selector) : selectedId

  /* a layer row opens the element properties panel; a frame row closes it
     and leaves the frame's own inspector to the frame-name click */
  function activate(row: VisibleRow) {
    const s = useStore.getState()
    s.select(row.frame.id)
    s.setSelectedElement(row.kind === 'node' ? { frameId: row.frame.id, selector: row.node.selector } : null)
    s.setElementPanelOpen(row.kind === 'node')
  }

  /* ↑↓ walk the visible rows, ←→ close and open them, ⌫ deletes what is
     selected, ↵ flies to the frame — the panel is a tree, so it drives like one */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const index = rows.findIndex((r) => r.key === currentKey)
    const row = index >= 0 ? rows[index] : undefined
    const step = (dir: 1 | -1) => {
      const next = rows[index < 0 ? (dir === 1 ? 0 : rows.length - 1) : index + dir]
      if (next) activate(next)
    }
    switch (e.key) {
      case 'ArrowDown':
        step(1)
        break
      case 'ArrowUp':
        step(-1)
        break
      case 'ArrowRight':
        if (row && !row.open) setOpen(row.key, true)
        else step(1)
        break
      case 'ArrowLeft':
        if (row?.open) setOpen(row.key, false)
        else if (row?.kind === 'node') {
          const parent = rows.find((r) => r.key === row.parentKey)
          if (parent) activate(parent)
        }
        break
      case 'Enter':
        if (row) useStore.getState().requestFlyTo(row.frame.id)
        break
      case 'Backspace':
      case 'Delete':
        /* no row is deleted for a viewer: the key falls through unhandled
           rather than deleting something the server would refuse anyway */
        if (readOnly) return
        if (row?.kind === 'frame') deleteFrameRow(row.frame)
        else if (row) deleteLayer(row.frame, row.node.selector)
        break
      default:
        return
    }
    /* the canvas listens on window for the same keys and deletes the whole
       selected frame — this handler already deleted what was asked for */
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <>
      <Panel className="left-3 inset-y-3 w-[300px]">
        <PanelHeader>
          <span className="rounded-sm bg-paper-deep px-2 py-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.09em] text-ink">
            Layers
          </span>
          <Tooltip label="Collapse panel" side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className={railBtn}
              aria-label="Collapse panel"
              onClick={() => setLayersOpen(false)}
            >
              <PanelCollapseIcon width={13} height={13} />
            </Button>
          </Tooltip>
        </PanelHeader>
        <label className="mx-3 mt-2.5 mb-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-ink-faint focus-within:border-ink">
          <SearchIcon width={13} height={13} className="flex-none" />
          <Input
            variant="bare"
            inputSize="auto"
            className="h-full text-[12.5px] md:text-[12.5px]"
            placeholder="Search layers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="flex items-center justify-between py-1 pr-2 pl-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          <span>Frames · {frames.length}</span>
          <span className="flex gap-0.5">
            <Tooltip label="Collapse all" side="bottom">
              <Button
                variant="bare"
                size="icon-sm"
                className={sectionBtn}
                aria-label="Collapse all"
                onClick={() => setExpanded(new Set())}
              >
                <CollapseAllIcon width={12} height={12} />
              </Button>
            </Tooltip>
            {readOnly ? (
              <span className="self-center pr-1 text-ink-faint" title="Read only — sign in to edit this canvas">
                Read only
              </span>
            ) : (
              <Tooltip label="New frame" side="bottom" align="end">
                <Button
                  variant="bare"
                  size="icon-sm"
                  className={sectionBtn}
                  aria-label="New frame"
                  onClick={onAddFrame}
                >
                  <PlusIcon width={12} height={12} />
                </Button>
              </Tooltip>
            )}
          </span>
        </div>
        <PanelBody className="px-2 pb-2 outline-none" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
          {frames.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">
              {readOnly
                ? 'No frames on this page.'
                : 'No frames yet. Press + to add one, or ask the agent for a design.'}
            </div>
          )}
          {frames.length > 0 && rows.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">Nothing matches “{query.trim()}”.</div>
          )}
          {rows.map((row) =>
            row.kind === 'frame' ? (
              <FrameRow
                key={row.key}
                row={row}
                selected={row.frame.id === selectedId && !selectedElement}
                current={row.frame.id === selectedId}
                dragging={row.frame.id === dragId}
                dropEdge={dropAt?.id === row.frame.id ? dropAt.edge : null}
                onDragStart={() => {
                  dragFrom.current = row.frame.id
                  setDragId(row.frame.id)
                }}
                onDragOverRow={(edge) => {
                  dragEdge.current = { id: row.frame.id, edge }
                  setDropAt((prev) =>
                    prev?.id === row.frame.id && prev.edge === edge ? prev : { id: row.frame.id, edge },
                  )
                }}
                onDropRow={() => {
                  const from = dragFrom.current
                  const at = dragEdge.current
                  if (from) dropFrame(from, row.frame.id, at?.id === row.frame.id ? at.edge : 'before')
                  endDrag()
                }}
                onDragEnd={endDrag}
                onToggle={() => setOpen(row.key, !row.open)}
                onActivate={() => activate(row)}
              />
            ) : (
              <NodeRow
                key={row.key}
                row={row}
                selected={row.key === currentKey}
                onToggle={() => setOpen(row.key, !row.open)}
                onActivate={() => activate(row)}
              />
            ),
          )}
        </PanelBody>
        <footer className="flex flex-none items-center justify-between gap-2 whitespace-nowrap border-t border-line-soft px-3 py-[9px] font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move · <Kbd>←</Kbd>
            <Kbd>→</Kbd> fold
          </span>
          <span>
            <Kbd>↵</Kbd> fly to frame
          </span>
        </footer>
      </Panel>
      {toast && <Toast>{toast}</Toast>}
    </>
  )
}

/** The collapsed rail: a narrow column at the panel's spot with the expand
 *  control and the Layers mark carrying the frame count, as in the design. */
export function LayersRailToggle() {
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const count = visibleFrames({ canvas, activePageId }).length
  return (
    <nav
      aria-label="Layers panel"
      className="absolute left-3 top-3 z-[35] flex w-12 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card"
    >
      <Tooltip label="Expand panel" side="right">
        <Button
          variant="bare"
          size="icon-sm"
          className="size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink"
          aria-label="Expand panel"
          onClick={() => setLayersOpen(true)}
        >
          <PanelExpandIcon width={16} height={16} />
        </Button>
      </Tooltip>
      <span className="my-0.5 h-px w-6 bg-line-soft" />
      <Tooltip label={`Layers · ${count} ${count === 1 ? 'frame' : 'frames'}`} side="right">
        <Button
          variant="bare"
          size="icon-sm"
          className="relative size-[34px] rounded-lg bg-brand/[0.06] text-brand hover:bg-brand/10 hover:text-brand"
          aria-label={`Layers — ${count} frames`}
          onClick={() => setLayersOpen(true)}
        >
          <LayersIcon width={16} height={16} />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface bg-brand px-[3px] font-mono text-[8px] font-medium text-white">
              {count}
            </span>
          )}
        </Button>
      </Tooltip>
    </nav>
  )
}

function FrameRow({
  row,
  selected,
  current,
  dragging,
  dropEdge,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd,
  onToggle,
  onActivate,
}: {
  row: Extract<VisibleRow, { kind: 'frame' }>
  selected: boolean
  /** the frame is selected, whether or not an element inside it is */
  current: boolean
  /** this row is the one being dragged */
  dragging: boolean
  /** which side of this row a drop would land on */
  dropEdge: 'before' | 'after' | null
  onDragStart: () => void
  onDragOverRow: (edge: 'before' | 'after') => void
  onDropRow: () => void
  onDragEnd: () => void
  onToggle: () => void
  onActivate: () => void
}) {
  const { frame } = row
  const stream = useStore((s) => s.streams[frame.id])
  const presences = useStore((s) => s.presences)
  const readOnly = useStore(isReadOnly)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter(
    (p) => p.activeFrameId === frame.id && p.clientId !== me && p.name !== stream?.name,
  )
  /* Drag is the reorder, so a viewer's rows start no drag and take no drop —
     without the handlers, a drag from anywhere else cannot raise a drop
     indicator over them either. */
  const drag: Pick<RowProps, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDrop' | 'onDragEnd'> = readOnly
    ? {}
    : {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = 'move'
          /* a drag with no data set is cancelled by some browsers */
          e.dataTransfer.setData('text/plain', frame.id)
          onDragStart()
        },
        onDragOver: (e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const box = e.currentTarget.getBoundingClientRect()
          onDragOverRow(e.clientY < box.top + box.height / 2 ? 'before' : 'after')
        },
        onDrop: (e) => {
          e.preventDefault()
          onDropRow()
        },
        onDragEnd,
      }
  /* Paste from this menu lands mid-stage rather than under the rail */
  const pasteAt = useRef({ x: 0, y: 0 })
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Row
            depth={0}
            caret={<Caret open={row.open} present />}
            onCaret={onToggle}
            icon={<FrameIcon width={13} height={13} />}
            label={frame.name}
            className={cn(
              'font-semibold',
              current && !selected && 'text-brand [&_[data-icon]]:text-brand',
              /* a hidden frame still owns its row, so the row says so */
              frame.hidden && 'text-ink-faint',
              dropEdge === 'before' && 'shadow-[inset_0_2px_0_var(--brand)]',
              dropEdge === 'after' && 'shadow-[inset_0_-2px_0_var(--brand)]',
              dragging && 'opacity-40',
            )}
            selected={selected}
            {...drag}
            onClick={onActivate}
            onDoubleClick={() => useStore.getState().requestFlyTo(frame.id)}
            onContextMenu={() => {
              pasteAt.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
              if (!useStore.getState().selectedIds.includes(frame.id)) onActivate()
            }}
            trailing={
              <>
                {stream && (
                  <span className={editorChip} style={{ background: stream.color }}>
                    <AgentIcon name={stream.name} size={8} color="#fff" />
                    designing…
                  </span>
                )}
                {editors.map((p) => (
                  <span key={p.clientId} className={editorChip} style={{ background: p.color }}>
                    {p.kind === 'agent' ? <AgentIcon name={p.name} size={8} color="#fff" /> : '✎'}
                    {p.name}
                  </span>
                ))}
                <FrameFlags frame={frame} />
              </>
            }
          />
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={pasteAt} />
      </ContextMenu>
      {row.empty && <div className="py-1 pl-[42px] text-[11.5px] text-ink-faint">empty frame</div>}
    </>
  )
}

/* The row's padlock and eye. They sit inside the row's click target, so their
   own clicks stop there — toggling a frame's state must not also select it.
   Of the tree's keys, ↵ (fly to) and ⌫ (delete) must not fire while a toggle
   has focus, either; the arrow keys still walk the tree from here. */
function FrameFlags({ frame }: { frame: Frame }) {
  /* both buttons write a frame property, so a viewer is offered neither — the
     row then carries only the frame's name and its presence chips */
  const readOnly = useStore(isReadOnly)
  const flag = 'shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink'
  if (readOnly) return null
  return (
    <span
      className="flex flex-none items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation()
      }}
    >
      <Tooltip label={frame.locked ? 'Unlock frame' : 'Lock frame'} side="left">
        <Button
          variant="bare"
          size="icon-sm"
          className={cn(flag, 'size-5 rounded-[5px]', frame.locked && 'text-ink')}
          aria-label={frame.locked ? 'Unlock frame' : 'Lock frame'}
          aria-pressed={frame.locked}
          onClick={() => toggleFrameFlag(frame, 'locked')}
        >
          {frame.locked ? <LockIcon width={12} height={12} /> : <UnlockIcon width={12} height={12} />}
        </Button>
      </Tooltip>
      <Tooltip label={frame.hidden ? 'Show frame' : 'Hide frame'} side="left">
        <Button
          variant="bare"
          size="icon-sm"
          className={cn(flag, 'size-5 rounded-[5px]', frame.hidden && 'text-ink')}
          aria-label={frame.hidden ? 'Show frame' : 'Hide frame'}
          aria-pressed={frame.hidden}
          onClick={() => toggleFrameFlag(frame, 'hidden')}
        >
          {frame.hidden ? <EyeOffIcon width={12} height={12} /> : <EyeIcon width={12} height={12} />}
        </Button>
      </Tooltip>
    </span>
  )
}

/* Lock and visibility are two more frame properties, so they save like any
   other frame edit: the row flips at once, the write follows, and the pair
   lands in undo with everything else. The row's own copy is the version the
   write preconditions on — someone else's newer frame refuses the toggle
   rather than have it flipped out from under them. */
function toggleFrameFlag(frame: Frame, key: 'locked' | 'hidden') {
  const before = key === 'locked' ? { locked: frame.locked } : { hidden: frame.hidden }
  const after = key === 'locked' ? { locked: !frame.locked } : { hidden: !frame.hidden }
  recordUpdate(frame.id, before, after)
  useStore.getState().patchFrameLocal(frame.id, after)
  api
    .updateFrame(frame.id, after, { expectedUpdatedAt: frame.updatedAt })
    .then(noteOwnWrite)
    .catch((err: unknown) => {
      const conflict = caughtStaleWrite(err)
      if (conflict) console.error(conflict.error)
    })
}

/* The row's name lives on the element itself, so renaming is an html edit
   like duplicate or delete: it saves through the frame and lands in undo. */
function renameLayer(frame: Frame, selector: string, name: string) {
  const html = renameElement(frame.html, selector, name)
  if (html === null) return
  const outer = elementHtml(html, selector)
  if (outer !== null) replaceLayerHtml(frame, selector, outer)
}

function NodeRow({
  row,
  selected,
  onToggle,
  onActivate,
}: {
  row: Extract<VisibleRow, { kind: 'node' }>
  selected: boolean
  onToggle: () => void
  onActivate: () => void
}) {
  const { frame, node } = row
  const readOnly = useStore(isReadOnly)
  const hasChildren = node.children.length > 0
  /* the row being renamed swaps its label for the field */
  const [renaming, setRenaming] = useState(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Row
          depth={row.depth}
          caret={<Caret open={row.open} present={hasChildren} />}
          onCaret={hasChildren ? onToggle : undefined}
          icon={<LayerKindIcon kind={node.kind} />}
          label={
            renaming ? (
              <InlineRename
                initial={node.label}
                onCommit={(name) => {
                  setRenaming(false)
                  if (name !== node.label) renameLayer(frame, node.selector, name)
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              node.label
            )
          }
          detail={renaming ? undefined : node.detail}
          selected={selected}
          onClick={onActivate}
          onDoubleClick={readOnly ? undefined : () => setRenaming(true)}
          onContextMenu={onActivate}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const html = elementHtml(frame.html, node.selector)
            if (html) navigator.clipboard.writeText(html).catch(console.error)
          }}
        >
          Copy HTML
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => navigator.clipboard.writeText(node.selector).catch(console.error)}>
          Copy selector
        </ContextMenuItem>
        {/* Rename, Duplicate and Delete all rewrite the frame's html; a viewer
            keeps the two copies and is offered none of them */}
        {!readOnly && (
          <>
            <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
            <ContextMenuItem onSelect={() => duplicateLayer(frame, node.selector)}>Duplicate</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem tone="danger" onSelect={() => deleteLayer(frame, node.selector)}>
              Delete element
              <MenuHint>⌫</MenuHint>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Renaming happens in the row: the field replaces the label, ↵ or a click
 *  away commits it. Escape drops the edit, and its own blur must not then
 *  commit what Escape just discarded. */
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
  const cancelled = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  return (
    <Input
      ref={ref}
      variant="bare"
      inputSize="auto"
      autoFocus
      className="h-[22px] w-full rounded-[5px] border border-ink bg-paper px-1 font-mono text-[11.5px] md:text-[11.5px]"
      value={draft}
      aria-label="Layer name"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(draft.trim())
        if (e.key === 'Escape') {
          cancelled.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onCommit(draft.trim())
      }}
    />
  )
}

/* Radix's context-menu trigger (asChild) hands its own handlers and data
   attributes down through these props, so everything unknown is spread onto
   the div and our handlers compose with, rather than replace, its own. */
type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> & {
  depth: number
  caret: ReactNode
  onCaret?: () => void
  icon: ReactNode
  /** the row's name; a renaming row swaps in the field */
  label: ReactNode
  detail?: string
  selected: boolean
  trailing?: ReactNode
  onClick: () => void
}

function Row({
  depth,
  caret,
  onCaret,
  icon,
  label,
  detail,
  selected,
  className,
  trailing,
  onClick,
  ...rest
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null)
  /* a selection made in the frame may sit far down the tree — bring it into view */
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      {...rest}
      ref={ref}
      role="treeitem"
      aria-selected={selected}
      className={cn(
        'flex h-[26px] cursor-default select-none items-center gap-1 whitespace-nowrap rounded-md pr-1.5 text-[12.5px] text-ink hover:bg-paper-deep',
        selected && 'bg-brand text-white hover:bg-brand [&_[data-icon]]:text-white/85',
        className,
      )}
      style={{ ...rest.style, paddingLeft: 6 + depth * INDENT }}
      onClick={onClick}
    >
      <span
        data-icon
        className={cn('grid size-3.5 flex-none place-items-center text-ink-faint', onCaret && 'cursor-pointer')}
        onClick={(e) => {
          if (!onCaret) return
          e.stopPropagation()
          onCaret()
        }}
      >
        {caret}
      </span>
      <span data-icon className="grid size-4 flex-none place-items-center text-ink-faint">
        {icon}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
        {label}
        {detail && <span className={cn('text-ink-faint', selected && 'text-white/85')}>{detail}</span>}
      </span>
      {trailing && <span className="flex flex-none items-center gap-1">{trailing}</span>}
    </div>
  )
}

function Caret({ open, present }: { open: boolean; present: boolean }) {
  if (!present) return null
  return open ? <ChevronDownIcon width={11} height={11} /> : <ChevronRightIcon width={11} height={11} />
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-0.5 inline-block rounded-[5px] border border-line bg-paper px-1 font-mono text-[9.5px] leading-[15px] text-ink-soft">
      {children}
    </kbd>
  )
}
