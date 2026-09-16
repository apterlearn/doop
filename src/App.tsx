import { useEffect, useRef, useState } from 'react'
import { Home } from './pages/Home'
import { Community } from './pages/Community'
import { Settings } from './pages/Settings'
import { CanvasPage } from './pages/CanvasPage'
import { AuthPage } from './pages/AuthPage'
import { Admin } from './pages/Admin'
import { authClient } from './lib/auth'
import { setName } from './lib/identity'
import { posthog, syncReplayForUser, suspendAnalyticsWhileImpersonating } from './lib/posthog'
import { useMe } from './lib/me'
import { adminApi, api, ApiError, type PublicCanvas } from './lib/api'
import { useStore } from './lib/store'
import { Button } from './components/ui/button'
import { AuthScreen } from './components/ui/screen'
import { Wordmark } from './components/ui/wordmark'
import { GuestPasswordPrompt } from './components/GuestBar'
import { InviteAccept } from './components/InviteAccept'
import { DesktopTabs, ShellDragBar } from './components/DesktopTabs'
import { setTabsUser } from './lib/desktop'
import { isDesktopShell } from './lib/shell'

export function navigate(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function App() {
  const [path, setPath] = useState(location.pathname)
  const { data: session, isPending } = authClient.useSession()
  const me = useMe(session?.user.id)
  const identifiedUserId = useRef<string | null>(null)

  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* Reaching /admin mid "view as" — usually the Back button, since /admin
     stays in history when impersonation starts — can only mean "return to
     being the admin": the borrowed session has no admin access, so rendering
     the page would show its not-found screen. End the impersonation and
     arrive as the admin instead. */
  const returningToAdmin = !!me?.impersonating && path.startsWith('/admin')
  useEffect(() => {
    if (!returningToAdmin) return
    adminApi
      .stopImpersonating()
      .then(() => location.assign('/admin'))
      .catch(() => location.assign('/'))
  }, [returningToAdmin])

  /* The session is the auth boundary: this covers both successful login and
     restoring an existing session after a page refresh. */
  useEffect(() => {
    const user = session?.user
    if (!user) {
      if (identifiedUserId.current) {
        posthog.reset()
        identifiedUserId.current = null
      }
      return
    }
    /* Wait for /api/me before identifying anyone. Impersonation swaps the
       session cookie, so `user` here is the person being VIEWED — identifying
       them would write an admin's support session into that customer's
       profile and replay timeline. Only /api/me can tell the two apart. */
    if (!me) return
    if (me.impersonating) {
      suspendAnalyticsWhileImpersonating()
      identifiedUserId.current = null
      return
    }

    if (identifiedUserId.current === user.id) return
    if (identifiedUserId.current) posthog.reset()
    posthog.identify(user.id, { email: user.email, name: user.name })
    syncReplayForUser(user.email)
    identifiedUserId.current = user.id
  }, [session?.user, me])

  /* the account name is the identity shown on cursors and in the feed */
  useEffect(() => {
    if (session?.user?.name) setName(session.user.name)
  }, [session?.user?.name])

  /* A borrowed "view as" session is read-only. The banner says so to the
     admin; the store flag is how the canvas's own affordances find out, since
     nothing else in the app can tell an impersonated session from a real one. */
  useEffect(() => {
    useStore.getState().setImpersonating(!!me?.impersonating)
  }, [me])

  /* An invitation link is signed out for most people who receive it, and the
     sign-in form comes first. AuthPage already knows how to come back to a
     deep link — it resumes ?redirect_to after signing in or signing up — so
     the invite records itself there before the form renders, and a new
     account lands on the invitation instead of its own first canvas. */
  useEffect(() => {
    if (isPending || session || !/^\/invite\//.test(path)) return
    const url = new URL(location.href)
    if (url.searchParams.get('redirect_to') === path) return
    url.searchParams.set('redirect_to', path)
    history.replaceState(null, '', url)
  }, [path, session, isPending])

  /* the desktop tab strip is per-account state: restore this user's tabs,
     and clear the strip the moment the session goes away */
  useEffect(() => {
    if (!isPending) setTabsUser(session?.user?.id ?? null)
  }, [isPending, session?.user?.id])

  if (isPending)
    return (
      <>
        <ShellDragBar />
        <AuthScreen />
      </>
    )

  const canvasId = path.match(/^\/c\/([^/]+)/)?.[1]
  const inviteToken = path.match(/^\/invite\/([^/]+)/)?.[1]

  /* Signed out, a share link is the one path that does NOT land on the form:
     /c/<id> opens the canvas itself when the owner's link allows it, which is
     the whole point of a view or comment link. Everything else — /admin, an
     interrupted MCP OAuth resume, an invitation (which authenticates first,
     then comes back to its own URL) — keeps today's rule. */
  if (!session) {
    if (canvasId) return <GuestCanvas canvasId={canvasId} key={canvasId} />
    return (
      <>
        <ShellDragBar />
        <AuthPage />
      </>
    )
  }

  /* /admin waits for /api/me: before it answers we can't tell an admin from
     a borrowed "view as" session, and rendering Admin in the latter flashes
     its not-found screen. Also blank while the effect above swaps the
     session back and reloads. */
  if (path.startsWith('/admin') && (!me || returningToAdmin)) return <div className="auth-page" />

  const page = inviteToken ? (
    /* an invitation somebody opened while signed in: the token is the
       capability, the panel accepts or declines it */
    <InviteAccept token={inviteToken} key={inviteToken} />
  ) : canvasId ? (
    <CanvasPage canvasId={canvasId} key={canvasId} />
  ) : path.startsWith('/admin') ? (
    <Admin />
  ) : path.startsWith('/settings') ? (
    <Settings />
  ) : path.startsWith('/community') ? (
    <Community />
  ) : (
    <Home />
  )

  /* The banner is not decoration: an impersonated session looks exactly like
     being signed in as that person, and forgetting you are in one is how
     support tools cause incidents. */
  return me?.impersonating ? (
    <>
      <ImpersonationBanner name={session.user.name} />
      {/* --app-inset is the contract with fixed-position screens: the canvas
          workspace is `fixed inset-0` and ignores this padding, so it offsets
          itself by the same variable instead of hardcoding the banner height */}
      <div className="h-dvh overflow-auto pt-14 [--app-inset:56px] sm:pt-10 sm:[--app-inset:40px]">{page}</div>
    </>
  ) : isDesktopShell() ? (
    /* the desktop shell's tab strip uses the same --app-inset contract as
       the banner: fixed screens (the canvas workspace) offset themselves */
    <>
      <DesktopTabs path={path} />
      <div className="h-dvh overflow-auto pt-10 [--app-inset:40px]">{page}</div>
    </>
  ) : (
    page
  )
}

/** One question, asked of the server: may this visitor read this canvas, with
 *  or without a password? It returns the answer rather than acting on it, so
 *  the effect that opens a share link can ask without setting any state of its
 *  own, and the retry after a wrong password shares the same reading. */
async function attemptLink(canvasId: string, password?: string): Promise<{ opened?: PublicCanvas; code?: string }> {
  try {
    return { opened: await api.openPublicCanvas(canvasId, password) }
  } catch (err) {
    return { code: err instanceof ApiError ? String(err.body.code ?? '') : '' }
  }
}

/* The share-link visitor's path through the app: try the link, then either
   hand over to the canvas (read-only, on the ticket the link minted), ask for
   the password the owner set, or fall back to the sign-in form exactly as
   every other signed-out URL does. There is no session anywhere in here — the
   ticket is the whole capability. */
function GuestCanvas({ canvasId }: { canvasId: string }) {
  const [phase, setPhase] = useState<'opening' | 'password' | 'canvas' | 'closed'>('opening')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function apply(result: { opened?: PublicCanvas; code?: string }, password?: string) {
    if (result.opened) {
      useStore.getState().setGuestSession({
        ticket: result.opened.ticket,
        access: result.opened.access,
        canvas: result.opened.canvas,
      })
      setPhase('canvas')
      return
    }
    /* `password_required` is the one answer worth a retry: the link is real,
       the visitor just has not proved they were sent it. A link that is off, a
       canvas that is gone, and an unreachable server all land on the sign-in
       form — the page this URL showed before share links could be read. */
    if (result.code === 'password_required') {
      setPhase('password')
      if (password) setError('That password is not right.')
      return
    }
    setPhase('closed')
  }

  /* the retry after a wrong password comes from a click, so it may show its
     own progress and clear the previous failure */
  async function unlock(password: string) {
    setBusy(true)
    setError(null)
    try {
      apply(await attemptLink(canvasId, password), password)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let live = true
    void attemptLink(canvasId).then((result) => live && apply(result))
    /* leaving the share link drops the capability with it — the ticket never
       outlives the URL it came from */
    return () => {
      live = false
      useStore.getState().setGuestSession(null)
    }
  }, [canvasId])

  if (phase === 'canvas') {
    const canvas = (
      <CanvasPage
        canvasId={canvasId}
        key={canvasId}
        onSignIn={() => {
          /* the form appears at the same URL, so signing in lands right back
             on this canvas — now as a real session, which is what turns the
             read-only view into an editable one */
          useStore.getState().setGuestSession(null)
          setPhase('closed')
        }}
      />
    )
    /* the desktop shell's overlay title bar needs its drag handle and its
       --app-inset (the contract the fixed canvas layer offsets itself by),
       exactly as the signed-in branch supplies them — without the tab strip,
       which is an account's own state */
    return isDesktopShell() ? (
      <>
        <ShellDragBar />
        <div className="h-dvh overflow-auto pt-10 [--app-inset:40px]">{canvas}</div>
      </>
    ) : (
      canvas
    )
  }
  if (phase === 'password') return <GuestPasswordPrompt onUnlock={unlock} error={error} busy={busy} />
  if (phase === 'opening')
    return (
      <AuthScreen>
        <div className="flex flex-col items-center gap-3 text-center">
          <Wordmark />
          <p className="text-[13px] text-ink-soft">Opening the shared canvas…</p>
        </div>
      </AuthScreen>
    )
  return (
    <>
      <ShellDragBar />
      <AuthPage />
    </>
  )
}

function ImpersonationBanner({ name }: { name: string }) {
  const [leaving, setLeaving] = useState(false)
  return (
    <div className="fixed inset-x-0 top-0 z-[900] flex min-h-14 items-center justify-between gap-2 border-b border-accent-ink px-2.5 py-[7px] text-[11.5px] leading-tight text-accent-ink backdrop-blur-[6px] [background:repeating-linear-gradient(-45deg,rgba(208,52,31,0.16)_0_10px,rgba(208,52,31,0.08)_10px_20px)] sm:h-10 sm:min-h-0 sm:justify-center sm:gap-4 sm:text-[13px]">
      <span>
        Viewing as <strong>{name}</strong> — read only, expires after 15 minutes.
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          /* the cookie swaps back to the admin's own session; reload rather
             than reconcile every piece of per-user state in memory */
          adminApi
            .stopImpersonating()
            .then(() => location.assign('/admin'))
            .catch(() => location.assign('/'))
        }}
      >
        {leaving ? 'Leaving…' : 'Stop viewing'}
      </Button>
    </div>
  )
}
