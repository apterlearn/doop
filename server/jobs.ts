import { nanoid } from 'nanoid'

/**
 * Background jobs: work that outlives one tool call.
 *
 * A multi-page site import takes tens of seconds per page. Blocking a tool
 * call for that is what makes an agent time out mid-capture, so the call
 * returns a job id and the work continues; the agent polls `get_job`. Jobs are
 * in-process and deliberately short-lived: a restart drops them, and a dropped
 * job is recoverable by running the import again, which is the honest trade for
 * not persisting a queue nobody asked for.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  id: string
  kind: string
  canvasId: string
  /** the account that started it: a job is only visible to its starter */
  ownerId?: string
  agentName?: string
  status: JobStatus
  /** units of work expected and completed, for "how far did it get" */
  total: number
  completed: number
  /** per-unit results, filled as the job runs */
  results: { label: string; ok: boolean; detail?: string; frameId?: string }[]
  error?: string
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, Job>()
const settled = new Map<string, Promise<Job | undefined>>()
const TTL_MS = 30 * 60 * 1000

/** Drop finished jobs nobody has looked at in half an hour. Called on every job
 *  creation, so the map cannot grow without a request to grow it. */
function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    const since = now - (job.finishedAt ?? job.startedAt)
    if (since <= TTL_MS) continue
    if (job.status === 'done' || job.status === 'failed') {
      jobs.delete(id)
      settled.delete(id)
    } else {
      /* a running job past the TTL is stuck: fail it rather than leak it */
      job.status = 'failed'
      job.error = 'the job stalled and was dropped'
      job.finishedAt = now
    }
  }
}

/**
 * Create a job and run `work` in the background. The returned job is the
 * caller's handle; `work` reports units through `recordUnit` and the module
 * owns the terminal state, including a throw.
 */
export function startJob(
  input: { kind: string; canvasId: string; ownerId?: string; agentName?: string; total: number },
  work: (job: Job) => Promise<void>,
): Job {
  sweep()
  const job: Job = {
    id: nanoid(10),
    kind: input.kind,
    canvasId: input.canvasId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    status: 'queued',
    total: input.total,
    completed: 0,
    results: [],
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  const done = (async () => {
    try {
      job.status = 'running'
      await work(job)
      return finishJob(job.id)
    } catch (e) {
      return finishJob(job.id, e instanceof Error ? e.message : 'the job failed')
    }
  })()
  settled.set(job.id, done)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

/** Resolves when the job reaches a terminal state. */
export function jobSettled(id: string): Promise<Job | undefined> {
  const pending = settled.get(id)
  if (pending) return pending
  const job = jobs.get(id)
  return Promise.resolve(job)
}

/** Record one finished unit. */
export function recordUnit(
  id: string,
  result: { label: string; ok: boolean; detail?: string; frameId?: string },
): Job | undefined {
  const job = jobs.get(id)
  /* a job the sweep already failed is over: a late unit must not revive it */
  if (!job || job.status === 'done' || job.status === 'failed') return undefined
  job.status = 'running'
  job.results.push(result)
  job.completed += 1
  return job
}

export function finishJob(id: string, error?: string): Job | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  /* the sweep can fail a stalled job while its work is still running: the
     terminal state stands, and a late finish does not overwrite it */
  if (job.status === 'done' || job.status === 'failed') return job
  job.status = error ? 'failed' : 'done'
  if (error) job.error = error
  job.finishedAt = Date.now()
  return job
}
