import type { Canvas } from '../shared/types.ts'

/**
 * Canvas access, Figma-style: private by default. The owner always has
 * access; invited members (canvas_members) have the access their role grants;
 * everyone else gets in only through the owner's share link (linkAccess),
 * and only as far as the link's mode allows. Ownerless (pre-auth/legacy)
 * canvases stay open so they can be claimed.
 *
 * Every canvas-scoped surface — REST, the WS join, MCP tools — must gate
 * through this one helper.
 */

/** What a caller may do with a canvas. Ordered, weakest first: an intent
 *  covers everything below it, so `intentAtLeast` is the whole rule. */
export type CanvasIntent = 'view' | 'comment' | 'edit'

/** What the owner granted an invited member. `editor` is the column's own
 *  default, so every membership that predates roles keeps full access. */
export type CanvasRole = 'viewer' | 'commenter' | 'editor' | 'admin'

export function isCanvasRole(value: unknown): value is CanvasRole {
  return value === 'viewer' || value === 'commenter' || value === 'editor' || value === 'admin'
}

const INTENT_RANK: Record<CanvasIntent, number> = { view: 1, comment: 2, edit: 3 }

/** Does `have` cover `need`? edit ⊃ comment ⊃ view. */
export function intentAtLeast(have: CanvasIntent, need: CanvasIntent): boolean {
  return INTENT_RANK[have] >= INTENT_RANK[need]
}

/**
 * canvas_members.role, as the gate reads it.
 *
 * The roles live here rather than on the Canvas object on purpose: shared/
 * types.ts is the frozen wire contract and carries `memberIds` only, and a
 * membership detail does not belong in every payload that ships a canvas.
 * There is one reader of this map (canvasAccess) and the routes that change a
 * role write through it, so it cannot disagree with itself.
 */
const memberRoles = new Map<string, Map<string, CanvasRole>>()

/** Load roles at boot, from the rows hydrate() read. An unknown or missing
 *  role reads as 'editor', the same default the column carries. */
export function initMemberRoles(rows: { canvasId: string; userId: string; role: string }[]): void {
  for (const row of rows) setMemberRole(row.canvasId, row.userId, isCanvasRole(row.role) ? row.role : 'editor')
}

export function setMemberRole(canvasId: string, userId: string, role: CanvasRole): void {
  let byUser = memberRoles.get(canvasId)
  if (!byUser) memberRoles.set(canvasId, (byUser = new Map()))
  byUser.set(userId, role)
}

export function clearMemberRole(canvasId: string, userId: string): void {
  const byUser = memberRoles.get(canvasId)
  if (!byUser) return
  byUser.delete(userId)
  if (byUser.size === 0) memberRoles.delete(canvasId)
}

/** A member's role. Anything unrecorded reads as 'editor' — the column's own
 *  default, and what every membership meant before roles existed. Two callers,
 *  one meaning: the gate below, and the people list the share modal renders. */
export function memberRole(canvasId: string, userId: string): CanvasRole {
  return memberRoles.get(canvasId)?.get(userId) ?? 'editor'
}

/**
 * Instance admins. Deliberately NOT consulted by canAccessCanvas: that gate
 * is shared with MCP, so an admin branch there would hand every agent holding
 * an admin's OAuth token read/write on every canvas in the instance. Admins
 * get their own routes (server/admin.ts), and reach a specific canvas by
 * impersonating its owner — which goes through the gate below as that owner,
 * leaving session.impersonatedBy behind as the audit trail.
 */
export function isAdmin(user: { role?: string | null } | undefined): boolean {
  return user?.role === 'admin'
}

/** The share link's mode, when the link is live. An expired link is nothing at
 *  all rather than a weaker grant, and 'none'/unset means the same. */
export function linkIntent(canvas: Canvas, opts: { now?: number } = {}): CanvasIntent | null {
  const mode = canvas.linkAccess
  if (mode !== 'view' && mode !== 'comment' && mode !== 'edit') return null
  if (canvas.linkExpiresAt !== undefined && canvas.linkExpiresAt <= (opts.now ?? Date.now())) return null
  return mode
}

/** What this caller may do here, or null for no access at all. The one gate:
 *  REST, the ws join and MCP all resolve through it. Owner ⇒ 'edit'; invited
 *  member ⇒ their role; anyone else ⇒ the link's mode while the link is live.
 *  A member's role is never widened by the link: an owner who set someone to
 *  viewer meant it, whatever the link says. */
export function canvasAccess(userId: string | undefined, canvas: Canvas, opts?: { now?: number }): CanvasIntent | null {
  if (!canvas.ownerId) return 'edit'
  if (userId) {
    if (canvas.ownerId === userId) return 'edit'
    if (canvas.memberIds?.includes(userId)) {
      /* a member's role in, an intent out */
      const role = memberRole(canvas.id, userId)
      return role === 'viewer' ? 'view' : role === 'commenter' ? 'comment' : 'edit'
    }
  }
  return linkIntent(canvas, opts ?? {})
}

/** Kept in its original shape and meaning — "may this caller reach the canvas
 *  at all" — now expressed through the intent gate, so the two cannot drift. */
export function canAccessCanvas(userId: string | undefined, canvas: Canvas): boolean {
  return canvasAccess(userId, canvas) !== null
}

/** Durable access only: the owner and invited members — NOT link visitors,
 *  whatever the link's mode. Gates anything that would outlive the visit
 *  itself, like design-sync keys: a bearer secret minted or read through a
 *  share link would keep writing frames long after the owner turns the link
 *  off. Callers pair this with an 'edit' intent check, so a viewer-role member
 *  cannot mint one either. */
export function hasDurableCanvasAccess(userId: string | undefined, canvas: Canvas): boolean {
  if (!userId || !canvas.ownerId) return false
  return canvas.ownerId === userId || !!canvas.memberIds?.includes(userId)
}
