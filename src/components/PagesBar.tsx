import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'

/** The page tab strip above the stage: one tab per sub-canvas page, showing
 *  only that page's frames underneath. Pure client-side switching (REST only
 *  mutates pages themselves); the server broadcasts the list over ws. */
export function PagesBar() {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const pages = canvas?.pages ?? []
  if (!canvas || pages.length === 0) return null
  const c = canvas
  const active = pages.find((p) => p.id === activePageId) ?? pages[0]!

  async function addPage() {
    const page = await api.createPage(c.id, `Page ${pages.length + 1}`)
    useStore.getState().setActivePage(page.id)
  }

  return (
    <div className="relative z-30 flex h-11 flex-none items-end gap-1 overflow-x-auto border-b border-line bg-surface px-3">
      {pages.map((page) => {
        const count = canvas.frames.filter((f) => f.pageId === page.id).length
        const isActive = page.id === active.id
        return (
          <ContextMenu key={page.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => useStore.getState().setActivePage(page.id)}
                className={cn(
                  'flex h-9 min-w-0 max-w-[180px] items-center gap-1.5 rounded-t-[7px] border border-b-0 px-3 font-mono text-[11px] font-medium tracking-[0.04em] transition-colors',
                  isActive
                    ? 'border-line bg-paper text-ink'
                    : 'border-transparent text-ink-faint hover:bg-paper-deep hover:text-ink',
                )}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{page.name}</span>
                <span className={cn('text-[9.5px]', isActive ? 'text-ink-faint' : 'text-ink-faint/70')}>{count}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setRenamingId(page.id)}>Rename</ContextMenuItem>
              <ContextMenuItem
                disabled={page.position === 0}
                onSelect={() => void api.updatePage(page.id, { position: page.position - 1 })}
              >
                Move left
              </ContextMenuItem>
              <ContextMenuItem
                disabled={page.position === pages.length - 1}
                onSelect={() => void api.updatePage(page.id, { position: page.position + 1 })}
              >
                Move right
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  void api.duplicatePage(page.id).then((result) => {
                    useStore.getState().setActivePage(result.page.id)
                  })
                }
              >
                Duplicate
              </ContextMenuItem>
              <ContextMenuItem tone="danger" disabled={pages.length < 2} onSelect={() => setDeleteTarget(page.id)}>
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
            {renamingId === page.id && (
              <InlineRename
                initial={page.name}
                onCommit={(name) => {
                  if (name !== page.name) void api.updatePage(page.id, { name })
                  setRenamingId(null)
                }}
                onCancel={() => setRenamingId(null)}
              />
            )}
          </ContextMenu>
        )
      })}
      <Button
        variant="bare"
        size="icon-sm"
        className="mb-1.5 ml-1 text-ink-faint hover:bg-paper-deep hover:text-ink"
        aria-label="Add page"
        onClick={() => void addPage()}
      >
        +
      </Button>
      {deleteTarget && (
        <DeletePageModal
          pageName={pages.find((p) => p.id === deleteTarget)?.name ?? 'page'}
          frameCount={canvas.frames.filter((f) => f.pageId === deleteTarget).length}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            void api.deletePage(deleteTarget)
            setDeleteTarget(null)
          }}
        />
      )}
    </div>
  )
}

/** The tab's label swaps to this input while renaming; Enter or blur commits
 *  (trimmed, ≤80 chars), Escape cancels. */
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
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const clean = draft.trim().slice(0, 80) || initial
  return (
    <Input
      ref={ref}
      variant="bare"
      autoFocus
      className="h-9 max-w-[180px] rounded-t-[7px] border-b border-ink bg-paper px-3 py-0 font-mono text-[11px] font-medium tracking-[0.04em]"
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(clean)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(clean)}
    />
  )
}

function DeletePageModal({
  pageName,
  frameCount,
  onCancel,
  onConfirm,
}: {
  pageName: string
  frameCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal size="sm" onClose={onCancel}>
      <ModalEyebrow>Delete page</ModalEyebrow>
      <ModalTitle>
        Delete “{pageName}” and its {frameCount} {frameCount === 1 ? 'frame' : 'frames'}?
      </ModalTitle>
      <ModalLede>This cannot be undone — every frame on the page is deleted with it.</ModalLede>
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          Delete
        </Button>
      </ModalActions>
    </Modal>
  )
}
