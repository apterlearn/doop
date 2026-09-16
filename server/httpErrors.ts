import type express from 'express'
import { nanoid } from 'nanoid'

/**
 * Request identity, and the one place an unhandled error becomes a response.
 *
 * Mounting — both lines belong in server/index.ts, and nowhere else:
 *
 *   import { errorHandler, requestId } from './httpErrors.ts'
 *   app.use(requestId())     // first: right after `const app = express()`
 *   app.use(errorHandler())  // last: after every route and the static/SPA handler
 *
 * requestId() has to be first so /relay, /i/, /a/, /u/ and the ws upgrade all
 * carry an id, and errorHandler() has to be last so it is the handler Express
 * reaches when a route throws or calls next(err). Nothing else changes: a
 * route that answers 500 itself keeps its own body.
 */

/** The response header the id travels in, in both directions: a proxy that
 *  mints its own id has ours correlate with its log line for the same hop. */
const REQUEST_ID_HEADER = 'x-request-id'

/** The longest caller-supplied id we will echo. Short enough to keep a log
 *  line readable, long enough for a uuid or a trace id. */
const MAX_REQUEST_ID = 64

declare global {
  namespace Express {
    interface Request {
      /** This request's correlation id, set by requestId(). Optional in the
       *  type because only a mounted requestId() has filled it in — a handler
       *  that logs it should fall back, and errorHandler does. */
      id?: string
    }
  }
}

/** Stamp every request with an id, on the request and on the response. */
export function requestId(): express.RequestHandler {
  return (req, res, next) => {
    const supplied = req.get(REQUEST_ID_HEADER) ?? ''
    /* A supplied id is used only when it can go into a header and a log line
       verbatim — printable, single-line, bounded. Anything else is replaced
       rather than sanitized: a mangled id correlates with nothing. */
    const usable = supplied.length > 0 && supplied.length <= MAX_REQUEST_ID && /^[\x20-\x7e]+$/.test(supplied)
    const id = usable ? supplied : nanoid(12)
    req.id = id
    res.setHeader(REQUEST_ID_HEADER, id)
    next()
  }
}

/**
 * The last middleware in the chain: log the failure with the id that ties it
 * to the request, and answer the client without the stack.
 *
 * A 4xx an error carries is answered as itself with the error's own message —
 * the repo throws those deliberately, for a caller to read (GithubWriteError
 * throws with `status`, and Node/body-parser errors with `statusCode`).
 * Anything else is a bug and gets the same opaque answer for every caller:
 * `internal error` plus the id, so a person reporting it can be pointed at
 * the log line while the internals stay on the server.
 */
export function errorHandler(): express.ErrorRequestHandler {
  return (err, req, res, next) => {
    const id = req.id ?? 'no-request-id'
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error(`[error] ${id} ${req.method} ${req.originalUrl} — ${message}`, stack ?? err)

    /* a response already on the wire cannot be rewritten: hand it to
       Express's own handler, which destroys the connection instead of
       appending a JSON body to a half-sent one */
    if (res.headersSent) return next(err)

    /* Outside 4xx/5xx is not a status we answer with: a 200 on an error path
       is a bug, not an instruction, and it would answer "success" with an
       error body. */
    const carried = err as { status?: unknown; statusCode?: unknown } | null
    const carriedStatus = carried?.status ?? carried?.statusCode
    const status =
      typeof carriedStatus === 'number' && carriedStatus >= 400 && carriedStatus <= 599 ? carriedStatus : 500

    res.status(status).json({
      error: status === 500 ? 'internal error' : message,
      requestId: id,
    })
  }
}
