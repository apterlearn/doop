import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { createAsset, deleteAsset, framesReferencingAsset, getAsset, listAssets } from '../server/assets.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Canvas, release and asset lifecycle over MCP. These are the owner's
   administrative tools — rename, copy, configure, destroy — plus the two
   artifact deletes, and copy_frame moving a design between canvases. Releases
   live in the database and an asset's references are read from the frames
   table, so this file drives the real PGlite cluster and the real asset store
   and therefore runs alone. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-lifecycle-'))

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

const OWNER_ID = 'lifecycle-owner'
const MEMBER_ID = 'lifecycle-member'
const OUTSIDER_ID = 'lifecycle-outsider'

/* 1x1 transparent png — a real sniffable image, so createAsset accepts it */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A tool payload as the tests read it. The JSON is unvalidated by definition
 *  (it is whatever the tool serialized), so leaves stay `unknown` and every
 *  read goes through one of the narrowers below rather than a cast. */
type Payload = Record<string, unknown>

function obj(value: unknown): Payload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {}
}

function list(value: unknown): Payload[] {
  return Array.isArray(value) ? (value as Payload[]) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The typed code of a refused call — `''` when the call succeeded. */
function errorCode(parsed: Payload): string {
  return str(obj(parsed.error).code)
}

async function connect(ownerName: string, ownerId: string) {
  const server = buildMcpServer(ownerName, ownerId)
  const client = new Client({ name: `doop-lifecycle-${ownerId}`, version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Payload = {}
  try {
    const decoded: unknown = JSON.parse(raw)
    parsed = obj(decoded)
  } catch {
    /* a schema refusal arrives as a plain string, not our JSON payload */
  }
  return { parsed, raw, isError: result.isError }
}

let counter = 0
let canvas: Canvas
let frame: Frame

beforeEach(() => {
  counter += 1
  vi.restoreAllMocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
    plans: new Map(),
  })
  canvas = store.createCanvas(`Lifecycle ${counter}`, OWNER_ID)
  frame = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>hi</h1>', width: 800, height: 600 }, 'Owner')!
})

describe('canvas lifecycle', () => {
  it('reports the canvas policy on get_canvas', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      const view = await callTool(owner.client, 'get_canvas', { canvas_id: canvas.id })
      expect(view.isError).toBeFalsy()
      expect(view.parsed.review_mode).toBe(false)
      expect(view.parsed.link_access).toBe('none')
    } finally {
      await owner.close()
    }
  })

  it('renames a canvas for its owner and refuses a member', async () => {
    /* a member can reach the canvas — so this is the owner rule refusing them,
       not the access gate */
    canvas.memberIds = [MEMBER_ID]
    const owner = await connect('Owner', OWNER_ID)
    const member = await connect('Member', MEMBER_ID)
    try {
      const renamed = await callTool(owner.client, 'rename_canvas', {
        canvas_id: canvas.id,
        name: '  Checkout flow  ',
        agent_name: 'Claude',
      })
      expect(renamed.isError).toBeFalsy()
      expect(renamed.parsed).toEqual({ ok: true, name: 'Checkout flow' })
      expect(store.getCanvas(canvas.id)?.name).toBe('Checkout flow')

      const refused = await callTool(member.client, 'rename_canvas', {
        canvas_id: canvas.id,
        name: 'Hijacked',
        agent_name: 'Bob',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(store.getCanvas(canvas.id)?.name).toBe('Checkout flow')
    } finally {
      await owner.close()
      await member.close()
    }
  })

  it('copies a canvas with its frames into the caller’s account', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      const copied = await callTool(owner.client, 'duplicate_canvas', {
        canvas_id: canvas.id,
        name: 'Checkout copy',
        agent_name: 'Claude',
      })
      expect(copied.isError).toBeFalsy()
      const copy = obj(copied.parsed.canvas)
      const copyId = str(copy.id)
      expect(copyId).not.toBe(canvas.id)
      expect(copy).toMatchObject({ name: 'Checkout copy', frameCount: 1, guidelinesCount: 0 })

      /* the copy is reachable through the same account, and it holds the design */
      const view = await callTool(owner.client, 'get_canvas', { canvas_id: copyId })
      expect(view.isError).toBeFalsy()
      const frames = list(view.parsed.frames)
      expect(frames.map((f) => f.name)).toEqual(['Hero'])
      /* fresh ids: the copy is a new canvas, not a second handle on the source */
      expect(frames[0]!.id).not.toBe(frame.id)
      expect(store.getCanvas(copyId)?.frames[0]?.html).toBe('<h1>hi</h1>')
    } finally {
      await owner.close()
    }
  })

  it('refuses to copy a canvas for a share-link visitor', async () => {
    /* link access is enough to design on the canvas but not to lift it into
       another account — the copy outlives the visit. A member may copy it:
       that is the REST duplicate route's rule (hasDurableCanvasAccess), and
       the MCP tool deliberately mirrors it. */
    canvas.linkAccess = 'edit'
    canvas.memberIds = [MEMBER_ID]
    const outsider = await connect('Outsider', OUTSIDER_ID)
    const member = await connect('Member', MEMBER_ID)
    try {
      const refused = await callTool(outsider.client, 'duplicate_canvas', {
        canvas_id: canvas.id,
        agent_name: 'Eve',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')

      const allowed = await callTool(member.client, 'duplicate_canvas', {
        canvas_id: canvas.id,
        agent_name: 'Bob',
      })
      expect(allowed.isError).toBeFalsy()
      expect(str(obj(allowed.parsed.canvas).ownerId)).toBe(MEMBER_ID)
    } finally {
      await outsider.close()
      await member.close()
    }
  })

  it('flips review mode on and off, and refuses agent writes while it is on', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      const on = await callTool(owner.client, 'set_review_mode', {
        canvas_id: canvas.id,
        on: true,
        agent_name: 'Claude',
      })
      expect(on.isError).toBeFalsy()
      expect(on.parsed).toEqual({ ok: true, review_mode: true })
      expect(store.getCanvas(canvas.id)?.reviewMode).toBe(true)

      const view = await callTool(owner.client, 'get_canvas', { canvas_id: canvas.id })
      expect(view.parsed.review_mode).toBe(true)

      /* review mode is the whole point of the flag: a direct write is refused
         and the agent is told the path that works instead */
      const write = await callTool(owner.client, 'set_frame_html', {
        frame_id: frame.id,
        html: '<h1>changed</h1>',
        agent_name: 'Claude',
      })
      expect(write.isError).toBe(true)
      expect(write.raw).toContain('propose_frame_html')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')

      const off = await callTool(owner.client, 'set_review_mode', {
        canvas_id: canvas.id,
        on: false,
        agent_name: 'Claude',
      })
      expect(off.parsed).toEqual({ ok: true, review_mode: false })
      expect(store.getCanvas(canvas.id)?.reviewMode).toBeUndefined()
    } finally {
      await owner.close()
    }
  })

  it('refuses a review-mode change from a member', async () => {
    canvas.memberIds = [MEMBER_ID]
    const member = await connect('Member', MEMBER_ID)
    try {
      const refused = await callTool(member.client, 'set_review_mode', {
        canvas_id: canvas.id,
        on: true,
        agent_name: 'Bob',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(store.getCanvas(canvas.id)?.reviewMode).toBeUndefined()
    } finally {
      await member.close()
    }
  })

  it('sets and clears the share-link policy', async () => {
    canvas.memberIds = [MEMBER_ID]
    const owner = await connect('Owner', OWNER_ID)
    const member = await connect('Member', MEMBER_ID)
    try {
      const open = await callTool(owner.client, 'set_link_access', {
        canvas_id: canvas.id,
        mode: 'edit',
        agent_name: 'Claude',
      })
      expect(open.isError).toBeFalsy()
      expect(open.parsed).toEqual({ ok: true, link_access: 'edit' })
      expect(store.getCanvas(canvas.id)?.linkAccess).toBe('edit')

      const view = await callTool(owner.client, 'get_canvas', { canvas_id: canvas.id })
      expect(view.parsed.link_access).toBe('edit')

      const refused = await callTool(member.client, 'set_link_access', {
        canvas_id: canvas.id,
        mode: 'none',
        agent_name: 'Bob',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')

      const closed = await callTool(owner.client, 'set_link_access', {
        canvas_id: canvas.id,
        mode: 'none',
        agent_name: 'Claude',
      })
      expect(closed.parsed).toEqual({ ok: true, link_access: 'none' })
      expect(store.getCanvas(canvas.id)?.linkAccess).toBeUndefined()
    } finally {
      await owner.close()
      await member.close()
    }
  })

  it('deletes a canvas only with confirm, only for the owner', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      /* confirm is a required literal, so a call without it never reaches the
         handler — either way nothing is destroyed */
      const unconfirmed = await callTool(owner.client, 'delete_canvas', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
      })
      expect(unconfirmed.isError).toBe(true)
      expect(store.getCanvas(canvas.id)).toBeDefined()

      canvas.memberIds = [MEMBER_ID]
      const member = await connect('Member', MEMBER_ID)
      try {
        const refused = await callTool(member.client, 'delete_canvas', {
          canvas_id: canvas.id,
          confirm: true,
          agent_name: 'Bob',
        })
        expect(refused.isError).toBe(true)
        expect(errorCode(refused.parsed)).toBe('forbidden')
        expect(store.getCanvas(canvas.id)).toBeDefined()
      } finally {
        await member.close()
      }

      const name = canvas.name
      const deleted = await callTool(owner.client, 'delete_canvas', {
        canvas_id: canvas.id,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(deleted.isError).toBeFalsy()
      expect(deleted.parsed).toEqual({ ok: true, deleted: name })
      expect(store.getCanvas(canvas.id)).toBeUndefined()

      const after = await callTool(owner.client, 'get_canvas', { canvas_id: canvas.id })
      expect(after.isError).toBe(true)
      expect(errorCode(after.parsed)).toBe('not_found')
    } finally {
      await owner.close()
    }
  })
})

describe('release and asset lifecycle', () => {
  it('renames a release and deletes it once the gallery is not pinned to it', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      const created = await callTool(owner.client, 'create_release', {
        canvas_id: canvas.id,
        name: 'v1',
        agent_name: 'Claude',
      })
      expect(created.isError).toBeFalsy()
      const releaseId = str(created.parsed.release_id)

      const renamed = await callTool(owner.client, 'rename_release', {
        canvas_id: canvas.id,
        release_id: releaseId,
        name: 'v1 final',
        agent_name: 'Claude',
      })
      expect(renamed.isError).toBeFalsy()
      expect(renamed.parsed).toEqual({ ok: true, name: 'v1 final' })
      expect((await persist.getRelease(releaseId))?.name).toBe('v1 final')

      const wrongCanvas = await callTool(owner.client, 'delete_release', {
        canvas_id: 'some-other-canvas',
        release_id: releaseId,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(wrongCanvas.isError).toBe(true)
      expect(errorCode(wrongCanvas.parsed)).toBe('not_found')

      /* publishing pins the listing to this snapshot: deleting it would leave
         the gallery entry with nothing to show */
      const published = await callTool(owner.client, 'publish_canvas', {
        canvas_id: canvas.id,
        category: 'other',
        release_id: releaseId,
        agent_name: 'Claude',
      })
      expect(published.isError).toBeFalsy()

      const pinned = await callTool(owner.client, 'delete_release', {
        canvas_id: canvas.id,
        release_id: releaseId,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(pinned.isError).toBe(true)
      expect(errorCode(pinned.parsed)).toBe('conflict')
      expect(str(obj(pinned.parsed.error).message)).toContain('unpublish_canvas')
      expect(await persist.getRelease(releaseId)).toBeDefined()

      await callTool(owner.client, 'unpublish_canvas', { canvas_id: canvas.id, agent_name: 'Claude' })
      const gone = await callTool(owner.client, 'delete_release', {
        canvas_id: canvas.id,
        release_id: releaseId,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(gone.isError).toBeFalsy()
      expect(gone.parsed).toEqual({ ok: true, deleted: 'v1 final' })
      expect(await persist.getRelease(releaseId)).toBeUndefined()
    } finally {
      await owner.close()
    }
  })

  it('refuses a release delete from a member', async () => {
    const owner = await connect('Owner', OWNER_ID)
    const created = await callTool(owner.client, 'create_release', {
      canvas_id: canvas.id,
      name: 'v1',
      agent_name: 'Claude',
    })
    const releaseId = str(created.parsed.release_id)
    canvas.memberIds = [MEMBER_ID]
    const member = await connect('Member', MEMBER_ID)
    try {
      const refused = await callTool(member.client, 'delete_release', {
        canvas_id: canvas.id,
        release_id: releaseId,
        confirm: true,
        agent_name: 'Bob',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(await persist.getRelease(releaseId)).toBeDefined()
    } finally {
      await owner.close()
      await member.close()
    }
  })

  it('refuses to delete an asset frames still point at, and forces it on request', async () => {
    const asset = await createAsset(PNG, { canvasId: canvas.id, uploadedBy: 'Owner' })
    const holder = store.createFrame(
      canvas.id,
      { name: 'With image', html: `<img src="/a/${asset.id}.png" alt="">` },
      'Owner',
    )!
    /* the frame row is written fire-and-forget: wait for the read to see it
       rather than for a duration */
    await vi.waitFor(async () => expect(await framesReferencingAsset(canvas.id, asset.id)).toEqual([holder.id]), {
      timeout: 5000,
    })

    const owner = await connect('Owner', OWNER_ID)
    try {
      const refused = await callTool(owner.client, 'delete_asset', {
        canvas_id: canvas.id,
        asset_id: asset.id,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('conflict')
      expect(str(obj(refused.parsed.error).message)).toContain(holder.id)
      expect(await getAsset(asset.id)).not.toBeNull()

      const forced = await callTool(owner.client, 'delete_asset', {
        canvas_id: canvas.id,
        asset_id: asset.id,
        confirm: true,
        force: true,
        agent_name: 'Claude',
      })
      expect(forced.isError).toBeFalsy()
      expect(forced.parsed).toEqual({ ok: true, deleted: asset.id, referenced_by: [holder.id] })
      expect(await getAsset(asset.id)).toBeNull()
    } finally {
      await owner.close()
    }
  })

  it('deletes an unreferenced asset, but not one belonging to another canvas', async () => {
    const mine = await createAsset(PNG, { canvasId: canvas.id, uploadedBy: 'Owner' })
    const elsewhere = await createAsset(PNG, { canvasId: 'some-other-canvas', uploadedBy: 'Owner' })
    const owner = await connect('Owner', OWNER_ID)
    try {
      const foreign = await callTool(owner.client, 'delete_asset', {
        canvas_id: canvas.id,
        asset_id: elsewhere.id,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(foreign.isError).toBe(true)
      expect(errorCode(foreign.parsed)).toBe('not_found')
      expect(await getAsset(elsewhere.id)).not.toBeNull()

      const unconfirmed = await callTool(owner.client, 'delete_asset', {
        canvas_id: canvas.id,
        asset_id: mine.id,
        agent_name: 'Claude',
      })
      expect(unconfirmed.isError).toBe(true)
      expect(await getAsset(mine.id)).not.toBeNull()

      const deleted = await callTool(owner.client, 'delete_asset', {
        canvas_id: canvas.id,
        asset_id: mine.id,
        confirm: true,
        agent_name: 'Claude',
      })
      expect(deleted.isError).toBeFalsy()
      expect(deleted.parsed).toEqual({ ok: true, deleted: mine.id, referenced_by: [] })
      expect(await getAsset(mine.id)).toBeNull()
      /* the refusal left the other canvas's asset alone — put it back so the
         test does not leave bytes behind */
      await deleteAsset(elsewhere.id)
    } finally {
      await owner.close()
    }
  })
})

describe('copy_frame', () => {
  it('lands the frame on another canvas, on the page it names', async () => {
    const target = store.createCanvas('Target', OWNER_ID)
    store.createPage(target.id, 'Second')
    const owner = await connect('Owner', OWNER_ID)
    try {
      const copied = await callTool(owner.client, 'copy_frame', {
        frame_id: frame.id,
        to_canvas_id: target.id,
        name: 'Hero copy',
        page: 'Second',
        x: 10,
        y: 20,
        agent_name: 'Claude',
      })
      expect(copied.isError).toBeFalsy()
      expect(copied.parsed.copied_to).toBe(target.id)

      const view = await callTool(owner.client, 'get_canvas', { canvas_id: target.id })
      const frames = list(view.parsed.frames)
      expect(frames.map((f) => f.name)).toEqual(['Hero copy'])
      const landed = frames[0]!
      expect(landed.id).not.toBe(frame.id)
      expect(landed.page).toBe('Second')
      expect(landed.x).toBe(10)
      expect(landed.y).toBe(20)
      /* the copy is full fidelity and the source is untouched */
      expect(store.getFrame(str(landed.id))?.html).toBe('<h1>hi</h1>')
      expect(store.getCanvas(canvas.id)?.frames.map((f) => f.id)).toEqual([frame.id])
    } finally {
      await owner.close()
    }
  })

  it('carries the source frame’s asset references over to the destination canvas', async () => {
    /* the copy keeps the /a/ URL in its HTML, so the destination canvas's asset
       listing has to see it — the borrowed-asset case the ledger is built for.
       Nothing has to be reconciled by hand: the frame's refs are projected by
       the same write path every other frame goes through. */
    const target = store.createCanvas('Target', OWNER_ID)
    const asset = await createAsset(PNG, { canvasId: canvas.id, uploadedBy: 'Owner' })
    store.updateFrame(frame.id, { html: `<img src="/a/${asset.id}.png" alt="">` }, 'Owner')
    const owner = await connect('Owner', OWNER_ID)
    try {
      const copied = await callTool(owner.client, 'copy_frame', {
        frame_id: frame.id,
        to_canvas_id: target.id,
        agent_name: 'Claude',
      })
      expect(copied.isError).toBeFalsy()
      await vi.waitFor(
        async () => {
          const { assets: listed } = await listAssets(target.id)
          expect(listed.map((a) => a.id)).toContain(asset.id)
        },
        { timeout: 5000 },
      )
      /* the bytes are real (disk storage is bound to the process cwd), so the
         test puts its own asset back */
      await deleteAsset(asset.id)
    } finally {
      await owner.close()
    }
  })

  it('refuses a destination the caller cannot reach', async () => {
    const target = store.createCanvas('Target', OWNER_ID)
    /* the source is reachable through the share link, the destination is not */
    canvas.linkAccess = 'edit'
    const outsider = await connect('Outsider', OUTSIDER_ID)
    try {
      const refused = await callTool(outsider.client, 'copy_frame', {
        frame_id: frame.id,
        to_canvas_id: target.id,
        agent_name: 'Eve',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('not_found')
      expect(store.getCanvas(target.id)?.frames).toEqual([])
    } finally {
      await outsider.close()
    }
  })

  it('refuses a review-mode destination', async () => {
    const target = store.createCanvas('Target', OWNER_ID)
    store.setReviewMode(target.id, true)
    const owner = await connect('Owner', OWNER_ID)
    try {
      const refused = await callTool(owner.client, 'copy_frame', {
        frame_id: frame.id,
        to_canvas_id: target.id,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect(refused.raw).toContain('review mode')
      expect(store.getCanvas(target.id)?.frames).toEqual([])
    } finally {
      await owner.close()
    }
  })
})
