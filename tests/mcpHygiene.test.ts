import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'

/* The three calls that clean up after the conversation: rewriting a note you
   wrote (edit_comment), giving back a claim you can no longer work
   (unclaim_comment), and taking back a question you no longer need answered
   (withdraw_question). Each one is its record's owner acting on it — the
   author, the claimant, the asker — so what these cases pin is that ownership
   is enforced at the surface as well as in the action: the act lands, the
   refusal names whose record it is under `forbidden`, and the payload says
   where the record now stands without a second read.

   The database is real here (PGlite in a temp directory, as the server boots
   it) because each of the three writes its record back through persist. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-mcp-hygiene-'))
const OWNER_ID = 'hygiene-owner'

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** A connection of its own per case: the account's MCP session — and with it
 *  the canvas a call that omits `canvas_id` inherits — is keyed by the client
 *  id, so a shared one would hand a later case the canvas an earlier one
 *  worked on. */
let connections = 0

async function connect(clientId = `hygiene-${(connections += 1)}`) {
  const server = buildMcpServer('Test Owner', OWNER_ID, clientId)
  const client = new Client({ name: 'doop-mcp-hygiene-test', version: '1.0.0' })
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

/** The tool's payload, whether it arrived structured or as the text block. */
async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, unknown>, isError: result.isError }
}

/** The typed code of a refused call — `''` when the call carried no payload. */
function errorCode(parsed: Record<string, unknown>): string {
  const error = parsed.error
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}

/** A field of the refusal's payload — the record's owner, say. */
function errorField(parsed: Record<string, unknown>, key: string): unknown {
  const error = parsed.error
  if (!error || typeof error !== 'object' || !(key in error)) return undefined
  return (error as Record<string, unknown>)[key]
}

const human: Actor = { name: 'alice', kind: 'user', color: '#000000' }
const claude: Actor = { name: 'Claude', kind: 'agent', color: '#E8432E' }

let counter = 0
let canvas: Canvas
let hero: Frame

beforeEach(() => {
  counter += 1
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  /* one canvas per case, made the way the app makes one — a note, a claim and
     a question are all keyed by the canvas they belong to */
  canvas = store.createCanvas(`Hygiene ${counter}`, OWNER_ID)
  hero = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>hero</h1>', width: 800, height: 600 }, 'Owner')!
})

describe('edit_comment', () => {
  it('rewrites the author’s own note, and refuses another agent', async () => {
    const note = actions.addElementComment(
      hero.id,
      { selector: 'h1', snippet: '<h1>hero</h1>', text: 'tighten this headline' },
      claude,
    )!
    const { client, close } = await connect()
    try {
      const edited = await callTool(client, 'edit_comment', {
        comment_id: note.id,
        text: 'tighten this headline and cut the subhead',
        agent_name: 'Claude',
      })
      expect(edited.isError).toBeFalsy()
      /* the same note: the id is the one that was there, and the payload says
         what it now reads and where it stands */
      expect(edited.parsed).toEqual({
        ok: true,
        id: note.id,
        text: 'tighten this headline and cut the subhead',
        state: 'open',
      })
      expect(actions.findComment(note.id)?.text).toBe('tighten this headline and cut the subhead')

      const refused = await callTool(client, 'edit_comment', {
        comment_id: note.id,
        text: 'mine now',
        agent_name: 'Rival',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(errorField(refused.parsed, 'author')).toBe('Claude')
      expect(String(errorField(refused.parsed, 'message'))).toContain('Claude')
      /* refused is refused: the note still says what its author left */
      expect(actions.findComment(note.id)?.text).toBe('tighten this headline and cut the subhead')

      /* an unknown id is a lookup failure, not an ownership one */
      const missing = await callTool(client, 'edit_comment', { comment_id: 'nope', text: 'x', agent_name: 'Claude' })
      expect(missing.isError).toBe(true)
      expect(errorCode(missing.parsed)).toBe('not_found')

      /* an edit to nothing is refused on its own terms: the note it found has
         no new text to store, which is not the same as not existing */
      const emptied = await callTool(client, 'edit_comment', { comment_id: note.id, text: '   ', agent_name: 'Claude' })
      expect(emptied.isError).toBe(true)
      expect(errorCode(emptied.parsed)).toBe('invalid_input')
      expect(actions.findComment(note.id)?.text).toBe('tighten this headline and cut the subhead')
    } finally {
      await close()
    }
  })
})

describe('unclaim_comment', () => {
  it('gives back the claimant’s note, and refuses anyone else', async () => {
    /* a human's note addressed to the role Claude works, claimed through the
       tool the claim belongs to — the state this release exists for */
    const note = actions.addElementComment(
      hero.id,
      { selector: 'h1', snippet: '<h1>hero</h1>', text: '@Doop tighten this headline' },
      human,
    )!
    const { client, close } = await connect()
    try {
      const claimed = await callTool(client, 'claim_comment', {
        canvas_id: canvas.id,
        role: 'doop',
        agent_name: 'Claude',
      })
      expect(claimed.isError).toBeFalsy()
      expect(actions.findComment(note.id)?.claimedBy).toBe('Claude')

      const refused = await callTool(client, 'unclaim_comment', { comment_id: note.id, agent_name: 'Rival' })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(errorField(refused.parsed, 'claimant')).toBe('Claude')
      expect(actions.findComment(note.id)?.claimedBy).toBe('Claude')

      const released = await callTool(client, 'unclaim_comment', { comment_id: note.id, agent_name: 'Claude' })
      expect(released.isError).toBeFalsy()
      expect(released.parsed).toEqual({ ok: true, id: note.id, state: 'open' })
      /* the pin goes back to "nobody is on it", the failure marker untouched */
      expect(actions.findComment(note.id)?.claimedBy).toBeUndefined()

      /* a note nobody holds has nothing to release — the other half of the
         same refusal, and it names that too */
      const again = await callTool(client, 'unclaim_comment', { comment_id: note.id, agent_name: 'Claude' })
      expect(again.isError).toBe(true)
      expect(errorCode(again.parsed)).toBe('forbidden')
      expect(String(errorField(again.parsed, 'message'))).toContain('not claimed')
    } finally {
      await close()
    }
  })
})

describe('withdraw_question', () => {
  it('closes the asker’s question, and refuses another agent', async () => {
    const asked = actions.askQuestion(canvas.id, { text: 'Which palette direction?', waitSeconds: 0 }, claude)!
    const { client, close } = await connect()
    try {
      const refused = await callTool(client, 'withdraw_question', { question_id: asked.id, agent_name: 'Rival' })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('forbidden')
      expect(errorField(refused.parsed, 'asker')).toBe('Claude')
      expect(actions.findQuestion(asked.id)?.status).toBe('open')

      const withdrawn = await callTool(client, 'withdraw_question', { question_id: asked.id, agent_name: 'Claude' })
      expect(withdrawn.isError).toBeFalsy()
      expect(withdrawn.parsed).toEqual({ ok: true, question_id: asked.id, status: 'withdrawn' })
      /* closed to answering: the question settled as it stands */
      expect(actions.findQuestion(asked.id)?.status).toBe('withdrawn')

      /* a question already settled comes back with the status it holds */
      const settled = await callTool(client, 'withdraw_question', { question_id: asked.id, agent_name: 'Claude' })
      expect(settled.parsed).toEqual({ ok: true, question_id: asked.id, status: 'withdrawn' })

      const missing = await callTool(client, 'withdraw_question', { question_id: 'nope', agent_name: 'Claude' })
      expect(missing.isError).toBe(true)
      expect(errorCode(missing.parsed)).toBe('not_found')
    } finally {
      await close()
    }
  })
})
