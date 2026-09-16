import { Modal, ModalLede, ModalTitle } from './ui/modal'

/* The canvas keyboard cheat sheet: `?` opens it, Escape (or `?`) closes it.
   One row per shortcut that actually exists on the canvas today, grouped the
   way the work is grouped — pick things, make frames, edit, look around. */

const GROUP_HEADING = 'font-mono text-[10px] font-[650] uppercase tracking-[0.14em] text-ink-faint'

/** [keys, what it does] — in the canvas's own vocabulary (frame, page). */
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Selection',
    rows: [
      ['⌫', 'Delete'],
      ['Esc', 'Deselect'],
      ['⌘A', 'Select all'],
      ['⌘C', 'Copy'],
      ['⌘V', 'Paste'],
      ['⌘D', 'Duplicate'],
      ['↑ ↓ ← →', 'Nudge (⇧ = 10px)'],
      ['⌘]', 'Bring forward'],
      ['⌘[', 'Send backward'],
    ],
  },
  {
    title: 'Frames',
    rows: [
      ['F', 'New frame'],
      ['T', 'Text frame'],
    ],
  },
  {
    title: 'Edit',
    rows: [
      ['⌘Z', 'Undo'],
      ['⌘⇧Z / ⌘Y', 'Redo'],
      ['⌘F', 'Find and replace'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['⌘0', 'Zoom to fit'],
      ['⌘+ / ⌘−', 'Zoom'],
      ['Space', 'Pan'],
      ['?', 'Shortcut sheet'],
    ],
  },
]

/** `?` on the canvas: every shortcut in one list. Closes on Escape, on `?`
 *  again (the page's own handler), or on a click outside. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal size="md" onClose={onClose}>
      <>
        <ModalTitle>Keyboard shortcuts</ModalTitle>
        <ModalLede>On Windows and Linux, read ⌘ as Ctrl. Space pans, ⌘-bracket reorders.</ModalLede>
        {GROUPS.map((group) => (
          <section key={group.title} className="mt-5">
            <h3 className={GROUP_HEADING}>{group.title}</h3>
            <dl className="mt-1.5">
              {group.rows.map(([keys, what]) => (
                <div
                  key={what}
                  className="flex items-center justify-between gap-4 border-b border-line-soft py-[5px] last:border-0"
                >
                  <dt className="text-[13px] text-ink">{what}</dt>
                  <dd className="flex-none">
                    <kbd className="rounded-[5px] border border-line bg-paper px-1 font-mono text-[9.5px] leading-[15px] text-ink-soft">
                      {keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </>
    </Modal>
  )
}
