<p align="center">
  <img src=".github/assets/banner.png" alt="doop — the open-source alternative to Paper.design: humans and AI agents designing together, live" width="100%">
</p>

<p align="center">
  <a href="https://github.com/kgoedecke/doop/actions/workflows/ci.yml"><img src="https://github.com/kgoedecke/doop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-111110" alt="License: AGPL-3.0"></a>
  <a href="https://doop.design"><img src="https://img.shields.io/badge/cloud-doop.design-2743EE" alt="Doop Cloud"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-111110" alt="PRs welcome"></a>
  <a href="https://discord.com/invite/3AUfXjgVe"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

**[Doop](https://doop.design/?utm_source=github) is the open-source alternative to [Paper.design](https://paper.design) — a multiplayer
design canvas for humans _and_ AI agents.** Every design lives on a shareable **Canvas**
(`/c/<id>`) holding **Frames** — artboards that render real HTML in sandboxed iframes. People edit
in the browser; AI agents edit through the built-in **MCP server**, streaming their designs in
live. Everyone sees everything as it happens: cursors, presence, frame edits, agent status, and an
activity feed.

<p align="center">
  <img src=".github/assets/canvas.png" alt="A doop canvas: three frames of a ceramics brand — landing hero, mobile product page and brand tokens" width="100%">
</p>

- **Design with agents, not prompts-and-refresh** — connect Claude Code (or any MCP client) once,
  then watch it sketch, stream and self-review designs on your canvas, next to your cursor.
- **No model of its own** — doop runs no agent on the server, so there is no server key to fund and
  no per-task meter. Connect an MCP client and it works the comments you @mention a role in, on its
  own model ([setup](#models-doop-runs-no-agent-of-its-own)); the first-canvas welcome performance
  is scripted and runs without any of it.
- **True multiplayer** — live cursors, presence, per-frame editing indicators, undo/redo, comments
  pinned to elements, and an activity feed, all over one WebSocket room.
- **Design memory** — pin exemplar frames, capture decisions, and let the distiller propose durable
  style rules that every agent follows.
- **Private by default** — invite collaborators by email or flip on link sharing per canvas;
  agents inherit exactly their human's access.
- **Self-host in one command** — `docker compose up`, or `bun run dev` with zero configuration
  (embedded Postgres, no external services required).

## Quickstart

```bash
git clone https://github.com/kgoedecke/doop && cd doop
bun install
bun run dev
```

Doop builds and installs with [bun](https://bun.sh) (`bun.lock` is the only
lockfile); the server itself runs on Node.

- Web app: **http://localhost:4300**
- API + WebSocket + MCP server: **http://localhost:4400** (the web port proxies `/api`, `/ws`, `/mcp` to it)

Everything works with no configuration: data persists to an embedded Postgres (PGlite) in `data/pg`,
and every optional integration (SMTP, stock photos, object storage, analytics) degrades gracefully
until its variable in [.env.example](.env.example) is set. No key is needed to design — the agents you
connect over MCP bring their own model; `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` only turn on the two
server-side model calls ([image generation and the distiller](#models-doop-runs-no-agent-of-its-own)).

Or self-host the production build with Docker:

```bash
BETTER_AUTH_SECRET=$(openssl rand -hex 32) docker compose up -d   # app + Postgres on :4400
```

Production build without Docker: `bun run build && bun run start` (single server on :4400 serving
everything). Set `DATABASE_URL` to use a real Postgres — same code path as PGlite.

Prefer not to run anything? **[doop.design](https://doop.design)** is the hosted version.

## Hook up Claude Code

One command connects Claude Code (or any MCP client) to your canvas:

```bash
claude mcp add --transport http doop http://localhost:4300/mcp
```

That triggers the standard MCP OAuth flow — a browser window opens, you approve, and from then on
the agent works **as you**. Ask it to design something on your canvas id and watch it happen live.
Everything in this shot is the real flow: [CC] connected, created a frame, and is streaming the
pricing section in — presence avatar, "for Kai Moreno" attribution, the frame chip, and the live
activity feed.

<p align="center">
  <img src=".github/assets/claude-code.png" alt="Claude Code connected over MCP OAuth, streaming a pricing-section design into a frame while the humans on the canvas watch it work" width="100%">
</p>

## Watch an agent design

The first canvas after signup comes with a performance: a scripted welcome design streams into a
frame while you watch — a presence avatar, the activity feed filling in, a pulsing border on the
frame it's building.

<p align="center">
  <img src=".github/assets/agent-live.png" alt="A design streaming into a frame, live — presence avatar, activity feed and pulsing frame border" width="100%">
</p>

That welcome performance is **scripted** (`server/demo.ts`) — a pre-authored frame replayed through
the same machinery real agents use, so it runs with no configuration at all. Real work comes from an
agent you connect.

## Models: doop runs no agent of its own

Agents bring their own model. You connect an MCP client — [CC], Codex, or anything else that speaks
MCP — and it works the element comments you @mention a role in, designing on your
subscription. There is no server-side agent, no per-task meter and no server key to fund: a comment
waits for whichever agent works the role it @mentioned, and the roles are defined in
[`shared/agents.ts`](shared/agents.ts).

Two server-side features do call a provider, each only when its key is set:

- **Image generation** (`generate_image`) uses `OPENAI_API_KEY`, or the [OI] API key a caller
  connected in Settings — a connected account wins over the server's.
- **The guideline distiller** ([`server/distill.ts`](server/distill.ts)) proposes durable style rules
  from your canvas on `ANTHROPIC_API_KEY` — or, with no server key, on the model of the connected MCP
  client, borrowed through MCP sampling. The same key gates background auto-tagging.

```bash
ANTHROPIC_API_KEY=sk-ant-...   # the distiller + background auto-tagging
OPENAI_API_KEY=sk-...          # image generation
```

Everything else works with no configuration at all.

### Model accounts

Settings (Home → Settings) holds the model account a server-side feature bills instead of the
server's own key. Two kinds:

- **[OI] API key** — pay-as-you-go on the user's own account; `generate_image` prefers it over the
  server key when the caller has one connected.
- **ChatGPT subscription** — OAuth against `auth.openai.com`, then the Codex backend that
  Plus/Pro/Business plans include. Tokens live in `model_accounts` and never reach a browser.

An account also records a **model tier** — `gpt-5.6-sol` (flagship), `gpt-5.6-terra` (the default
workhorse) or `gpt-5.6-luna` (cheap and fast); `DOOP_AGENT_OPENAI_MODEL` only sets the default a user
starts on. Note that `gpt-5.4` and `gpt-5.4-mini` retire from ChatGPT-authenticated Codex on
**31 August 2026**, so pinning a 5.4 id via that env var will break the subscription path after that
date.

OpenAI registers no redirect URI for a hosted app, so connecting ChatGPT takes one of three shapes
and Doop picks the cheapest one available:

| Where Doop runs                              | Flow                                         | What the user does                                            |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Same machine as the browser (dev, self-host) | Loopback catch — Doop holds `127.0.0.1:1455` | Approve in the OpenAI tab. Nothing to copy, no setup          |
| Hosted (doop.design)                         | Device code (`/api/accounts/deviceauth/*`)   | Type a short code at `auth.openai.com/codex/device`           |
| Device codes disallowed                      | Browser redirect + paste                     | Paste the dead `localhost:1455` page's address back into Doop |

The device flow needs **device code authorization** switched on in ChatGPT → Settings → Security
(workspace members need an admin to allow it) — that is why the loopback flow, which needs no
setting at all, stays the default when Doop is local. All three end at the same server-side PKCE
exchange.

> **Before you turn this on for real users:** driving a ChatGPT subscription from a third-party
> server is not something OpenAI's terms sanction, and heavy use can get an account rate-limited or
> suspended. The API-key path is the fully supported alternative and shares all the same code.
> `CHATGPT_CONNECT_DISABLED=1` switches the subscription path off and leaves the key path.

The keys and knobs that remain:

| Variable                   | Default         | What it does                                                    |
| -------------------------- | --------------- | --------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | _unset_         | The distiller's key, and background auto-tagging                |
| `OPENAI_API_KEY`           | _unset_         | Image generation, and the fallback when no account is connected |
| `DOOP_DISTILL_MODEL`       | _unset_         | Model the distiller judges with                                 |
| `DOOP_AGENT_OPENAI_MODEL`  | `gpt-5.6-terra` | Default model tier a connected account starts on                |
| `CHATGPT_CONNECT_DISABLED` | _unset_         | `1` hides the ChatGPT flow, leaving the API-key path            |

Every other optional integration has its own section in [.env.example](.env.example).

## Accounts

The web app requires an account (better-auth, email/password — open signup). Your account
name is your identity everywhere: cursors, presence, the activity feed, and comment
attribution are all server-authoritative from the session, and the WebSocket rejects
unauthenticated joins. **Canvases are private by default**, Figma-style: only the owner
and people they invite (Share → invite by email, existing doop accounts) can open one.
The Share modal can also turn on link sharing per canvas ("anyone with the link can
edit"), which restores drop-a-link collaboration for that canvas. Your home screen lists
your own canvases plus ones shared with you (plus unowned legacy ones, claimable there).
Agents connected over MCP act under the account that approved them and get exactly that
user's access.

<p align="center">
  <img src=".github/assets/share-modal.png" alt="The share modal: invite collaborators by email, see who has access, and toggle link sharing" width="100%">
</p>

With SMTP configured (`SMTP_HOST` etc. — see [.env.example](.env.example)), signups require email
verification and "forgot password" sends real reset links. Without it, signup stays open and every
email is printed to the server log, links included — the flows still work in development.

Set `SIGNUP_EMAIL_DOMAINS=jointhetroops.com` to restrict new accounts to one email domain, or use a
comma-separated list for several domains. Matching is case-insensitive and exact; existing accounts
are unaffected. Leave it unset to keep public signup open.

Set `REQUIRE_EMAIL_VERIFICATION=false` to let people in before they verify — the link is still
emailed, it just stops gating sign-in. Admin promotion is deliberately not part of that trade:
`ADMIN_EMAILS` only ever promotes a verified address (see below).

If signup or password reset **hangs** rather than failing, the cause is almost always a host that
blocks outbound SMTP: Railway and most PaaS block 25/465/587. Resend also serves 2465/2587, so
`SMTP_PORT=2587` is the usual fix.

Env: `BETTER_AUTH_SECRET` (required in production), `TRUSTED_ORIGINS` (comma-separated,
defaults to the localhost dev origins).

### Instance admins

`ADMIN_EMAILS` (comma-separated) names the accounts that get the `admin` role, applied at
signup, on email verification, and at boot — so you can name an admin before or after they
have an account. **This requires SMTP in production**: an address only identifies someone
once they have proven they own it, and without a mailer signup is open, so anyone could sign
up as your address and take the role with it. A production instance without SMTP promotes
nobody and warns at boot; set the role directly in the database if that is your setup.
Admins get `/admin`: every canvas and account on the instance, and "view as", which hands
them a real but **read-only** 15-minute session as that user. Being an admin does not widen
canvas access itself: the gate in [`server/access.ts`](server/access.ts) is shared with MCP,
so a privileged read there would give every agent holding an admin's token the run of the
instance. View-as sessions cannot write, cannot connect agents, and record who is behind
them in `session.impersonated_by`.

### SSO (OIDC)

Optional login against an external OIDC provider (Zitadel, Okta, Authentik, Keycloak,
etc.), alongside email/password — not a replacement for it. Set `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` together to enable it; a partial set refuses
to boot rather than run with SSO half-configured. `OIDC_SCOPES` (default
`openid email profile`) and `OIDC_PROVIDER_NAME` (default `SSO`, shown on the login
button — e.g. `Zitadel`) are optional. Signing in via SSO links to an existing
email/password account when the emails match and the provider marks the email
verified, and this works even on an instance with no SMTP configured, where a
local account could otherwise never verify on its own. SSO alone never grants
the admin role, even for an address listed in `ADMIN_EMAILS` — an IdP is not
trusted as an admin-promotion source, only as an email-ownership check;
promotion still requires the normal `ADMIN_EMAILS` path (verified signup, or
`syncAdmins` at boot for an account SSO has since verified).

Env: see the OIDC block in [.env.example](.env.example).

### Sign in with Google

Optional, alongside email/password and SSO. Create an OAuth client (Web application) in
the [Google Cloud console](https://console.cloud.google.com/apis/credentials), add
`<BETTER_AUTH_URL>/api/auth/callback/google` as an authorised redirect URI, and set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` together (one without the other refuses to
boot). The login page shows a "Sign in with Google" button whenever both are set. Account
linking and admin promotion follow the same rules as SSO above; `SIGNUP_EMAIL_DOMAINS`
applies to Google (and SSO) sign-ups exactly as it does to email/password.

### Sign in with Microsoft

Same shape as Google. Register an app in [Microsoft Entra](https://entra.microsoft.com)
(App registrations, platform Web) with `<BETTER_AUTH_URL>/api/auth/callback/microsoft` as a
redirect URI, create a client secret, and set `MICROSOFT_CLIENT_ID` and
`MICROSOFT_CLIENT_SECRET` together. `MICROSOFT_TENANT_ID` (default `common`, any Microsoft
account) can be `organizations`, `consumers`, or your tenant id to make the button an
org-only door. Microsoft does not assert email ownership unless the app registration's
ID token includes the `email` and `verified_primary_email` optional claims; without them a
Microsoft sign-in still works but only links to an existing account that is already
verified. Everything else (allowlist, admin promotion) follows the SSO rules above.

## Agent auth (MCP OAuth)

The `/mcp` endpoint requires OAuth. Adding the server in Claude Code / Codex triggers
the standard MCP OAuth flow: a browser window opens, you sign in to Doop and approve,
and the client stores a bearer token. Every tool call then carries your identity —
comments you leave show "for ⟨you⟩" on the pin, and presence tooltips name the owner.
Unauthenticated calls get a 401 with `WWW-Authenticate` discovery pointers
(`/.well-known/oauth-authorization-server` + `oauth-protected-resource`), which is what
kicks off the flow. Dynamic client registration is enabled, so no manual client setup.

In production also set `BETTER_AUTH_URL` to the public origin — OAuth URLs are built on it.

## Deploy

The repo ships a production `Dockerfile` (client build + Chromium for frame screenshots).
Any container host works; Railway/Fly are the least friction:

1. Create the app from this repo (both auto-detect the Dockerfile).
2. Add a managed Postgres and set `DATABASE_URL`. **Don't skip this in real deployments** —
   the PGlite fallback is embedded/single-process and only suits a single instance with a
   persistent volume mounted at `/app/data`.
3. Set `BETTER_AUTH_SECRET` (long random string) and `BETTER_AUTH_URL` (the public origin,
   e.g. `https://doop.example.com`). Extra allowed origins: `TRUSTED_ORIGINS` (comma-separated).
4. Health check: `GET /healthz`. The server trusts one proxy hop (`trust proxy`), so
   TLS termination at the platform edge works out of the box.

Local sanity check of the exact production image:

```bash
docker build -t doop .
docker run -p 4400:4400 -e BETTER_AUTH_URL=http://localhost:4400 -e BETTER_AUTH_SECRET=dev-only doop
```

## Connect an AI agent

The MCP endpoint (streamable HTTP, stateless) is at:

```
http://localhost:4300/mcp
```

Claude Code:

```bash
claude mcp add --transport http doop http://localhost:4300/mcp
```

Generic MCP config:

```json
{ "mcpServers": { "doop": { "type": "http", "url": "http://localhost:4300/mcp" } } }
```

Then tell the agent something like:

> Work on canvas `<canvas-id>` (shown in the top bar). Call `get_canvas` to see the existing frames.
> To design, create a frame with `create_frame`, then stream the design into it with `append_frame_html`
> in ~300–500 character chunks (`start=true` on the first, `done=true` on the last) so people watch it
> build up live. Complete HTML with inline CSS. After finishing, call `get_frame_screenshot` to see it,
> fix what looks wrong, and re-check. Pick an `agent_name` and reuse it on every call.

Screenshots render in your system Chrome/Chromium via `puppeteer-core` (set `CHROME_PATH` if it isn't
auto-detected). Humans can hit the same renderer at `GET /api/frames/:id/screenshot.png?scale=2`.
For website viewing/imports, setting `CONTEXT_DEV_API_KEY` makes Context.dev acquire the rendered
HTML while Doop still sanitizes it and renders the preview locally; without the key, Doop navigates
to the public page directly in Chromium.

### Design sync: push an app's live screens onto a canvas

Server-side import can't reach apps behind SSO or a VPN. The **doop-sync snippet** flips the capture
to the user's browser: mint a write-only key in a canvas's Share dialog, drop one tag into the app —

```html
<script async src="https://your-doop-origin/doop-sync.js?key=dk_…"></script>
```

— and every distinct screen people visit lands on that canvas as a frame (one row per app), imported
once: a short grace window lets the first capture settle (scroll reveals, late images), then the frame
freezes so later visits — different viewports, other users' data, open menus — never churn it. Deleting
a frame re-imports it on the next visit; navigation counts keep accumulating regardless. Routes are
normalized (`/orders/8231` → `/orders/:id`) so each screen maps to one
frame; captures are serialized from the CSSOM (so styled-components/emotion output survives), and
same-origin webfonts and small images are inlined as data: URIs — fonts require CORS inside the
sandboxed frame, and intranet URLs would never render for viewers outside the network. Scripts are
stripped client- and server-side, input values are always dropped, and anything marked `data-doop-mask`
is redacted before upload (`data-doop-sync-ignore` excludes an element entirely). The key is the whole
credential: it can only write frames to its one canvas, so revoking it in the Share dialog cuts the
app off instantly. Endpoint: `POST /ingest/<key>` (CORS-open, no cookies).

### How streaming looks (server-side smoothing)

Agent HTML lands in the store immediately, but viewers see it through a **typewriter reveal**: the server
broadcasts the accumulated HTML at a steady rate (~500 chars/s, accelerating to clear backlogs in ~8s),
so even an agent that sends few large chunks — or a one-shot `set_frame_html` / `create_frame` with
full HTML — plays back as a smooth live stream. Mid-reveal HTML is _healed_ before broadcast: a trailing
half-written tag is dropped, an unclosed `<script>` is cut (never run half-written JS), and an unclosed
`<style>` is closed so content paints instead of blanking. Human edits from the inspector bypass the
reveal (and a human html edit cancels any open reveal — the human takes over).

While a stream/reveal is open the frame gets a pulsing dashed border and a "✦ <agent> is designing…"
chip; "finished designing" logs when the reveal completes. A stale stream auto-closes after 30s.
There is also a REST equivalent: `POST /api/frames/:id/append` with `{ html_chunk, start?, done?, actor? }`.

### How agents learn the workflow

Steering happens at three layers (the same architecture paper.design uses, plus result nudges):

1. **Server `instructions`** at MCP initialize — a compact contract: load the guide, get context
   first, stream designs, review with screenshots, keep one `agent_name`.
2. **`get_guide` tool** — the deep playbook (mandatory review checkpoints, streaming workflow,
   frame sizing, design-quality doctrine, multiplayer etiquette), loaded once per session and
   re-loadable after context compaction. Source: `server/guide.ts`.
3. **Result nudges** — `create_frame` / `set_frame_html` / final `append_frame_html` results tell
   the agent it hasn't _seen_ its design yet and to call `get_frame_screenshot` before moving on.

### MCP tools

| Tool                      | What it does                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apply_ops`               | Run a sequence of Doop edits in one round trip: create frames, write their HTML, position them, comment, update status.                                                                                                                                                                                                                                                  |
| `create_canvas`           | Create a new design canvas.                                                                                                                                                                                                                                                                                                                                              |
| `create_component`        | Save a reusable component on this canvas’s library: self-contained markup you will insert into frames (insert_component) and keep in sync across them (update_component propagates).                                                                                                                                                                                     |
| `create_page`             | Create a new page on a canvas.                                                                                                                                                                                                                                                                                                                                           |
| `create_release`          | Snapshot every frame as it is right now and return a public, permanent preview URL (/p/<canvas>/<release>). Refuses a canvas whose frames are not currently verified — `review_canvas` clears it, `force: true` overrides.                                                                                                                                               |
| `delete_canvas`           | Permanently delete this canvas with its frames, pages, guides, references and comments (owner-only).                                                                                                                                                                                                                                                                     |
| `delete_component`        | Remove a component from the library (confirm: true).                                                                                                                                                                                                                                                                                                                     |
| `delete_page`             | Deletes the page AND every frame on it.                                                                                                                                                                                                                                                                                                                                  |
| `delete_release`          | Permanently delete a frozen release and its snapshot (owner-only, confirm: true).                                                                                                                                                                                                                                                                                        |
| `duplicate_canvas`        | Copy this canvas — frames, pages, guides and references — into a new private canvas owned by you.                                                                                                                                                                                                                                                                        |
| `get_canvas`              | Get a canvas: its name, its ordered pages, and every frame with position, size and metadata (not the HTML — use get_frame for that).                                                                                                                                                                                                                                     |
| `get_component`           | Read a component’s full markup and metadata before inserting or editing it.                                                                                                                                                                                                                                                                                              |
| `get_guidelines`          | Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow.                                                                                                                                                                                                                                    |
| `get_reference`           | Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this").                                                                                                                                                                                                                                                    |
| `get_tokens`              | The canvas's design tokens — the named colors, fonts, spacing scale and radii every frame on it should use — plus the ready-to-paste :root block.                                                                                                                                                                                                                        |
| `list_canvases`           | List the connected user's design canvases with their ids, names and frame counts, newest first.                                                                                                                                                                                                                                                                          |
| `list_components`         | List the canvas’s reusable components — saved pieces (a nav bar, a pricing card) that can be inserted into any frame with insert_component and updated once for every instance with update_component.                                                                                                                                                                    |
| `list_guidelines`         | List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries.                                                                                                                                                                                                                                                           |
| `list_releases`           | Every frozen release of this canvas, newest first, with the public preview URL for each.                                                                                                                                                                                                                                                                                 |
| `publish_canvas`          | Publish this canvas to the Doop community gallery with a short description and a shelf. Refuses a canvas whose frames are not currently verified — `review_canvas` clears it, `force: true` overrides.                                                                                                                                                                   |
| `rename_canvas`           | Rename this canvas (owner-only).                                                                                                                                                                                                                                                                                                                                         |
| `rename_page`             | Rename a page.                                                                                                                                                                                                                                                                                                                                                           |
| `rename_release`          | Relabel a frozen release (owner-only) — the label a handoff URL is listed under.                                                                                                                                                                                                                                                                                         |
| `replace_in_frames`       | Rename a string across a whole canvas in one call — literal or regex, optionally narrowed by frame ids or page — reporting per frame how many matches it held and whether the replacement landed (a locked frame is stepped over, not blocking the sweep). Rehearse with `dry_run`.                                                                                      |
| `restore_release`         | Write a release’s frames back onto the live canvas, as ordinary edits: each frame is written through the same path as any other edit, so the restore is logged, streamed to the room and reversible frame by frame with get_frame_history + revert_frame. Refuses a canvas whose frames are not currently verified — `review_canvas` clears it, `force: true` overrides. |
| `save_decision`           | Record a design decision your human made while talking to YOU — style direction you carried out ("rounder corners", "less purple, more white and blue", "stop using italic serif").                                                                                                                                                                                      |
| `search_components`       | Find saved components by name or description — "pricing", "nav", "testimonial".                                                                                                                                                                                                                                                                                          |
| `set_breakpoints`         | Declare the widths this canvas designs for, by name (e.g. mobile at 390, desktop at 1280).                                                                                                                                                                                                                                                                               |
| `set_guidelines`          | Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes).                                                                                                                                                                                                                                                            |
| `set_link_access`         | Set the canvas's share-link policy (owner-only).                                                                                                                                                                                                                                                                                                                         |
| `set_review_mode`         | Turn review mode on or off (owner-only).                                                                                                                                                                                                                                                                                                                                 |
| `set_tokens`              | Define or update the canvas's design tokens: named colors, display/body/mono fonts, a px spacing scale and radii.                                                                                                                                                                                                                                                        |
| `unpublish_canvas`        | Remove this canvas from the community gallery.                                                                                                                                                                                                                                                                                                                           |
| `update_component`        | Edit a saved component once and let the change reach its instances: propagate: true (the default) re-renders every frame that carries the component and reports the frames updated and the ones skipped (with reasons — a locked frame is skipped, not blocked).                                                                                                         |
| `append_frame_html`       | Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live.                                                                                                                                                                                                                         |
| `begin_frame_edit`        | Claim a frame so no other agent writes to it while you work: other agents' writes to that frame fail with a conflict naming you until you release it with end_frame_edit, your run stops, or the lock expires.                                                                                                                                                           |
| `copy_frame`              | Copy a frame (same size and HTML) onto ANOTHER canvas.                                                                                                                                                                                                                                                                                                                   |
| `create_frame`            | Create a new frame on a canvas with an HTML design.                                                                                                                                                                                                                                                                                                                      |
| `delete_frame`            | Delete a frame from its canvas.                                                                                                                                                                                                                                                                                                                                          |
| `duplicate_frame`         | Duplicate a frame: a full copy (same size and HTML) lands 40px below-right of the original, on the same page.                                                                                                                                                                                                                                                            |
| `edit_frame_html`         | Make a targeted edit to a frame: exact find-and-replace in its HTML.                                                                                                                                                                                                                                                                                                     |
| `end_frame_edit`          | Release a frame you claimed with begin_frame_edit so other agents can write to it again.                                                                                                                                                                                                                                                                                 |
| `export_frame`            | Hand a frame to the world outside Doop.                                                                                                                                                                                                                                                                                                                                  |
| `get_frame`               | Get a frame including its full HTML content.                                                                                                                                                                                                                                                                                                                             |
| `get_frame_content`       | Read what a frame SAYS, separately from how it looks: title and meta description, the heading outline with selectors, sections with their text, nav links, calls to action with hrefs, form fields with their labels, and images with their alt text and real pixel size.                                                                                                |
| `get_frame_css`           | Read back the frame's own stylesheet (the <style data-doop-css> block), or an empty string when it has none.                                                                                                                                                                                                                                                             |
| `get_frame_history`       | List the saved versions of a frame, newest first — every durable write is snapshotted, so this is how you see what a frame looked like before an edit (yours or anyone else's) and pick a version to restore.                                                                                                                                                            |
| `get_frame_html`          | Read a bounded portion of a frame's source HTML before a targeted edit.                                                                                                                                                                                                                                                                                                  |
| `get_frame_screenshot`    | Render a frame and return a PNG screenshot of it — this is how you SEE your design.                                                                                                                                                                                                                                                                                      |
| `get_frame_version`       | Read one saved version of a frame in full, including its HTML — the document to compare against or to restore with revert_frame.                                                                                                                                                                                                                                         |
| `list_frames`             | Page through a canvas's frames without pulling their HTML: id, name, page, position, size, who last touched each one and when, plus a public image_url.                                                                                                                                                                                                                  |
| `move_frame`              | Move a frame to another page of its canvas (page by id or exact name — get_canvas lists both), optionally repositioning it with x/y in the same call.                                                                                                                                                                                                                    |
| `revert_frame`            | Restore a frame to a version from get_frame_history.                                                                                                                                                                                                                                                                                                                     |
| `run_frame_script`        | Run a short script inside a rendered frame to make the one structural change the element tools cannot express — a bulk renumber, every repeated card rewritten.                                                                                                                                                                                                          |
| `search_frames`           | Find which frames on a canvas mention something: a literal, case-insensitive substring matched against every frame name and its HTML, newest-updated first, with a few short snippets around each hit.                                                                                                                                                                   |
| `set_frame_css`           | Write the frame's own stylesheet (a <style data-doop-css> block in its head): the only place responsive rules (@media), interaction states (:hover/:focus/:active) and motion (transition/@keyframes) can live.                                                                                                                                                          |
| `set_frame_html`          | Replace the HTML design of a frame in one shot.                                                                                                                                                                                                                                                                                                                          |
| `undo_last_change`        | Undo your own last change to a frame — the one-tool "that was a mistake, put it back".                                                                                                                                                                                                                                                                                   |
| `update_frame`            | Update frame metadata: rename it or move/resize it on the canvas.                                                                                                                                                                                                                                                                                                        |
| `delete_element`          | Remove an element and its subtree from a frame.                                                                                                                                                                                                                                                                                                                          |
| `detach_component`        | Unbind one component instance from its library entry: the wrapper element and its markup stay in the frame exactly as they are, but the component no longer tracks it — later update_component calls skip this frame.                                                                                                                                                    |
| `frame_script_api`        | The exact API a frame script runs against: the doop global, its methods, and the limits (size, time, forbidden markup, blocked network).                                                                                                                                                                                                                                 |
| `get_element`             | Read a single element of a rendered frame: its computed box and styles, its attributes, its text and its markup.                                                                                                                                                                                                                                                         |
| `insert_component`        | Insert a saved component into a frame: a single wrapper element carrying the component marker is placed under parent_selector (append, prepend, or a 0-based child index), with optional per-instance prop overrides.                                                                                                                                                    |
| `insert_element`          | Insert HTML as a child of an existing element, at the start, the end, or a child index.                                                                                                                                                                                                                                                                                  |
| `inspect_frame`           | Inspect the RENDERED page instead of its source: a compact semantic element outline with each element's CSS selector, the visible text, geometry, and the computed colors, typography, radii, shadows and CSS variables actually in effect.                                                                                                                              |
| `update_elements`         | Change elements of a frame by property instead of by text: set CSS declarations, set or remove attributes, or replace an element’s text.                                                                                                                                                                                                                                 |
| `delete_asset`            | Permanently remove an uploaded asset (confirm: true).                                                                                                                                                                                                                                                                                                                    |
| `generate_image`          | Generate images from a prompt through the configured provider and store them as canvas assets with permanent /a/ URLs ready for <img src>.                                                                                                                                                                                                                               |
| `get_asset`               | Look at one asset of this canvas: image assets come back as an image you can actually see (the same way get_frame_screenshot shows a frame), with their public /a/ URL.                                                                                                                                                                                                  |
| `list_assets`             | List the image assets this canvas already has (uploads and anything its frames reference), newest first, with their public /a/ URLs.                                                                                                                                                                                                                                     |
| `list_backgrounds`        | Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — as a page of thumbnails you look at, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim.                                                                  |
| `search_icons`            | Search 200,000+ open-source UI icons (Iconify: Material, Lucide, Tabler, Phosphor, …) and get hotlinkable SVG URLs for frame HTML.                                                                                                                                                                                                                                       |
| `search_images`           | Search free stock photography (Pexels) and get back candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame's mood, palette and crop.                                                                                                                                                                                                |
| `search_logos`            | Find a company's logo by brand name or domain — returns the company's real mark as a hotlinkable URL (a thumbnail is included when possible so you can confirm the brand), plus open-source vector marks (SVG) for well-known brands.                                                                                                                                    |
| `upload_asset`            | Upload an image (png/jpg/webp/gif/svg, max 5 MB) and get back a permanent public URL to reference in frame HTML (<img src>, CSS background) — use this instead of inlining data: URIs.                                                                                                                                                                                   |
| `upload_font`             | Store a font file (woff2/woff/ttf, max 5 MB) as a canvas asset and get back a ready-to-paste @font-face block plus the permanent /a/ URL — put it in set_frame_css or the frame's own <style> and the family renders on the canvas.                                                                                                                                      |
| `add_comment`             | Leave a note pinned to one element inside a frame — use it to record what you changed and why, or to ask a human a question about a specific element.                                                                                                                                                                                                                    |
| `ask_human`               | Ask the humans on this canvas a question and WAIT for the answer (up to the wait_seconds you pass).                                                                                                                                                                                                                                                                      |
| `get_answers`             | Check whether humans answered your ask_human questions.                                                                                                                                                                                                                                                                                                                  |
| `get_comments`            | Read element-pinned comments and replies on a canvas, newest first, including author, text, frame, CSS selector, HTML snippet, parentId thread links, and claim/failure/resolution metadata.                                                                                                                                                                             |
| `claim_comment`           | Take the element comments a human @mentioned your role in, so two connected agents do not both do the same note — each one is claimed under your agent_name and its pin flips to "you are on it" for the human watching. Pass `role` (doop, ux, copy, brand, a11y, polish), because humans address work to a role; without it your agent_name decides.                   |
| `fail_comment`            | Report that you cannot carry out a comment you claimed, with the reason — the pin flips to "stopped" and the human can retry it. Use this instead of resolve_comment when the note is not actually addressed.                                                                                                                                                            |
| `get_focus`               | What every connected human on this canvas is looking at right now: the frame, the element selector and the page, with how recently each moved.                                                                                                                                                                                                                           |
| `reply_to_comment`        | Reply inside an existing element-comment thread.                                                                                                                                                                                                                                                                                                                         |
| `resolve_comment`         | Mark an element-comment thread as resolved — do this once the note it carries has actually been addressed in the design.                                                                                                                                                                                                                                                 |
| `wait_for_events`         | Block until something on this canvas needs you: a comment or @mention, a stop, or an answer to your question.                                                                                                                                                                                                                                                            |
| `audit_frame`             | Check the RENDERED frame against the accessibility rules a design review is responsible for: text contrast (WCAG ratios, computed from the real composited background), image alt text, heading order, focus order and tabindex, tap-target sizes, landmarks, form labels and the document language.                                                                     |
| `check_brand_compliance`  | Check a rendered frame against the brand rules a style guide declares in its "## Brand rules" section — palette, forbidden colors, licensed fonts, logo presence, minimum contrast.                                                                                                                                                                                      |
| `diff_frame`              | Measure how far a frame's CURRENT render is from another one, and see WHERE: a magenta-marked image plus the changed-pixel ratio.                                                                                                                                                                                                                                        |
| `fix_frame_tokens`        | Fix the values a frame drifts off the canvas tokens: a fresh lint runs, every finding within the fix tolerance is rewritten to its token (var(--color-ink), var(--space-8) — values the render resolves), and the result is applied with the element editor and written through updateFrame.                                                                             |
| `fix_frame_a11y`          | Repair the accessibility and content findings that need no judgement — the document language, a missing or empty title, controls with no hover or focus rule — through the ordinary frame write; every other finding comes back in `skipped` with the decision it needs named. Rehearse with `dry_run`, restrict with `only`.                                            |
| `get_motion_context`      | What a frame does over time, which no screenshot shows: the keyframes and media queries its stylesheet declares, which elements run transitions or animations and for how long, and whether it honors reduced motion.                                                                                                                                                    |
| `get_token_usage`         | Per-element account of which design tokens a rendered frame actually uses, and where it drifts off them: the token (or raw value) behind each element’s color, background, font, radius and spacing, plus the off-token findings the lint reports — value, nearest token, and how far away it is.                                                                        |
| `lint_frame`              | Check the RENDERED frame for values that drift off the canvas's design tokens: colors that are not one of them, fonts outside the token set, and radii or spacing off the declared scales.                                                                                                                                                                               |
| `ready_for_review`        | Run the full quality gate on a frame — token conformance, accessibility, layout and content checks at mobile, tablet and desktop widths — and RECORD the result against the exact document it checked.                                                                                                                                                                   |
| `review_frame`            | The full quality gate in one call: design-token lint, accessibility audit, and layout analysis (overflow, clipping, overlap, truncation) at mobile, tablet and desktop widths in a single render batch.                                                                                                                                                                  |
| `review_canvas`           | The canvas-wide verification sweep: one verdict for the whole design with a row per frame (verdict, blocking and advisory counts, why a frame could not be checked). Reuses stored reports that are still current; every ship path asks for it.                                                                                                                          |
| `list_canvas_proposals`   | The canvas-level change proposals and their status — the tokens, a guide doc, the breakpoints or the page set — newest first, with the payload and what it replaces.                                                                                                                                                                                                     |
| `list_change_proposals`   | List the frame-change proposals on this canvas and their status — pending, accepted, rejected, withdrawn, or stale (the frame moved on after you proposed).                                                                                                                                                                                                              |
| `propose_canvas_change`   | Propose a change to the canvas itself (kind: tokens, guidelines, breakpoints or pages) without touching it — the review-mode counterpart of set_tokens / set_guidelines / set_breakpoints / the page tools.                                                                                                                                                              |
| `propose_frame_create`    | Propose creating a new frame without touching the canvas — the review-mode counterpart of create_frame.                                                                                                                                                                                                                                                                  |
| `propose_frame_delete`    | Propose deleting a frame without touching the canvas — the review-mode counterpart of delete_frame.                                                                                                                                                                                                                                                                      |
| `propose_frame_html`      | Propose a full replacement design for a frame WITHOUT touching the canvas.                                                                                                                                                                                                                                                                                               |
| `rebase_proposal`         | Re-apply a stale patch-mode proposal onto the frame as it stands now: the edits are re-run against the current HTML, the proposal’s base is refreshed and it goes back to pending for review.                                                                                                                                                                            |
| `resolve_frame_proposal`  | Accept or reject a pending frame-change proposal.                                                                                                                                                                                                                                                                                                                        |
| `resolve_frame_proposals` | Resolve up to 50 frame-change proposals in one call — clear a review queue after reading them.                                                                                                                                                                                                                                                                           |
| `resolve_canvas_proposal` | Accept or reject a pending canvas-level proposal (owner-only). Accepting applies the payload through the ordinary setters, so the change versions, broadcasts and logs like a human edit.                                                                                                                                                                                |
| `withdraw_proposal`       | Withdraw your own pending frame-change proposal (for example when you notice a better approach before the human reviews it).                                                                                                                                                                                                                                             |
| `get_run_events`          | The run timeline, newest first: one entry per model turn, tool call, status line, error and stop, with its agent, outcome and duration.                                                                                                                                                                                                                                  |
| `cancel_job`              | Ask a running job to stop at its next unit boundary — the pages already captured stay, the rest never start.                                                                                                                                                                                                                                                             |
| `extract_design_system`   | Read a rendered page — an imported frame, an existing frame, or a live URL — and derive its design system: the palette, type families, size/weight/line-height scales, spacing and radii, each with how many elements use it.                                                                                                                                            |
| `get_job`                 | Read the state of a job started by import_site: status, how far it has got, and each page’s frame id or the reason it failed.                                                                                                                                                                                                                                            |
| `import_repo_screen`      | Bring one screen of a connected GitHub repository onto this canvas as a frame, marked doop-github-screen so it stays traceable to its route and source file.                                                                                                                                                                                                             |
| `import_site`             | Capture a public site — its homepage plus the pages it links or lists in its sitemap — as one frame per page, on a new page of the canvas.                                                                                                                                                                                                                               |
| `import_webpage`          | Import ONE public webpage into a canvas as an editable HTML snapshot.                                                                                                                                                                                                                                                                                                    |
| `list_repo_screens`       | List the screens Doop found in a connected GitHub repository — page routes, component and story files, and static HTML — each with the source file it comes from.                                                                                                                                                                                                        |
| `search_inspiration`      | Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts).                                                                                                                                                                                   |
| `view_website`            | Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas.                                                                                                                                                                                                    |
| `wait_for_jobs`           | Block until every named job settles (done or failed) or the timeout runs out — whichever first — then read each job’s state in one result instead of polling get_job in a loop.                                                                                                                                                                                          |
| `export_canvas`           | Hand a canvas to a human's machine in one piece: `manifest`, `html`, `tokens`, a `zip` archive of every frame's source (returned as a public `zip_url`), or `code` — the developer handoff (documents, React components, build specs, design system) as a file manifest plus the same stored archive.                                                                    |
| `get_pull_request_review` | Read what a reviewer said on a pull request this canvas opened: the conversation, the inline comments (with the file and line they are attached to) and the review verdicts.                                                                                                                                                                                             |
| `diff_release`            | What changed since a frozen release: per frame, whether it moved and how — a pixel ratio when both versions render at one size, a line diff when they do not — plus the frames added or removed since.                                                                                                                                                                   |
| `import_code`             | Turn an HTML document (or fragment) into a frame on this canvas — the counterpart of export_frame.                                                                                                                                                                                                                                                                       |
| `open_pull_request`       | Hand the design to a developer: write the exported frames (design/<frame-name>.html, its React component, its build spec, the design system) to a branch in a connected GitHub repo and open a pull request. Refuses a canvas whose frames are not currently verified — `review_canvas` clears it, `force: true` overrides.                                              |
| `update_pull_request`     | Re-commit the canvas onto the branch a previous handoff opened and comment the summary on its pull request — the "send the client an update" path. Refuses with `not_found` when no pull request is open for that branch pair.                                                                                                                                           |
| `comment_pull_request`    | Say something on a pull request this canvas opened: a conversation comment, or — with `in_reply_to` — an answer on one of the inline review comments, so the reply stays attached to the file and line it is about.                                                                                                                                                      |
| `get_agents`              | The design roles this canvas organises work by, and who is live on it right now: each role with what it is for, and every MCP agent currently present on the canvas. Roles are the vocabulary a human @mentions in a comment; no agent is attached to one.                                                                                                               |
| `get_capabilities`        | Which optional integrations are actually configured on this server (screenshot renderer, image/icon/logo search, website capture, GitHub), plus the current size and rate limits.                                                                                                                                                                                        |
| `get_guide`               | Read the Doop agent guide: mandatory review checkpoints, the streaming workflow, frame sizing, design-quality doctrine, and multiplayer etiquette.                                                                                                                                                                                                                       |
| `get_memory`              | What the connected account has taught Doop about its taste, kept across canvases: preferences, brand rules and working workflows.                                                                                                                                                                                                                                        |
| `remember`                | Teach Doop something durable about this account that outlives the canvas: a styling preference ("likes generous whitespace"), a brand rule ("never use pure black"), a workflow ("wants mobile-first drafts first").                                                                                                                                                     |
| `whoami`                  | The identity your tool calls run as: the account behind the connection, the agent name you are posting under, and what that means for your work.                                                                                                                                                                                                                         |

Mutating tools accept `agent_name`; the agent then appears in the presence stack (pulsing square avatar),
gets an "editing" ring + chip on the frame it touched, and its actions land in the activity feed. Agents
expire from presence after ~20s of inactivity (~60s while they have a posted status, since a status
usually means the agent is thinking between tool calls).

Agent-to-human ownership comes from the OAuth token: the bearer token identifies who approved
the connection, and that user shows up as the agent's owner in presence and on the comments it
leaves. An agent's
identity is that account **plus** the name it posts under, so two accounts running the same
`agent_name` are two agents: neither inherits the other's comment claims, stop records or presence. `whoami` reports which identity a session is running as.

### What the MCP surface guarantees

- **Errors are structured.** A failing tool returns `{ error: { code, message, retryable, details } }`
  instead of a bare string, so an agent can branch on `conflict` / `rate_limited` / `too_large` /
  `forbidden` rather than parsing prose.
- **Reads are bounded.** `get_canvas`, `list_canvases`, `get_comments` and `list_frames` page
  (`limit`/`offset`, `has_more`), and `get_frame` clamps a big document to 30 000 characters with
  `html_truncated` set. HTML writes are capped at 3 MB; `append_frame_html` streams past it.
- **Writes are recoverable and race-safe.** Every durable frame write is snapshotted
  (`get_frame_history` / `get_frame_version` / `revert_frame`); `expected_updated_at` turns a write
  built on a stale read into a `conflict` instead of a silent overwrite; `begin_frame_edit` /
  `end_frame_edit` claim a frame so a concurrent writer gets a conflict naming the holder, with
  `takeover: true` as the deliberate override.
- **Design intent is shared.** `get_tokens` / `set_tokens` hold the canvas's palette, type and scale,
  and `lint_frame` reports values that drift off them.
- **The loop can be judged.** `audit_frame` measures contrast, alt text, heading order, focus order
  and tap targets; `diff_frame` compares a render against a saved version, a reference, another frame
  or a live URL and returns a marked-up image.
- **Handoff is code, not only pixels.** `export_frame` converts a render to a React component;
  `export_canvas` produces one document, a manifest, or a ZIP of every frame's source.
- **Context can be attached, not just called.** Three MCP resources: `doop://guide`,
  `doop://canvas/{canvasId}`, `doop://canvas/{canvasId}/tokens` — all gated by the same canvas access
  check as the tools.
- **Long calls report progress.** Tools that render, import or search emit
  `notifications/progress` when the client sends a `progressToken`.

### Live agent activity

Agents are steered (instructions + guide) to call `add_comment` with what they changed and why, and
`set_frame_css`/the element tools are visible as they happen: presence shows the agent on the canvas,
its frame carries an editing indicator, and every write lands in the **Activity** tab, so you can see
what an agent is doing without watching it type.

There is no status tool and no server-side task record. An agent that wants to narrate does it in the
place the work is: a comment on the element, which the human can read, reply to and resolve.

### Stopping an agent

An MCP agent runs in its own process, on its own model — the server holds no handle on it and cannot
abort its run. What you can do is take the work away and tell it:

- **From the canvas.** The **Stop** control on a live agent's presence row in the panel records who
  stopped it, in the activity feed, and clears the work in flight.
- **What the agent sees.** An external agent learns it was stopped from a `STOPPED` block appended to
  its next tool result — MCP is pull-based, so a tool result is the only channel into it. It is then
  expected to stop touching the canvas and report what it had done so far.
- **Reversing a bad change.** `undo_last_change` / `revert_frame` are the undo path for work already
  written: a stopped agent's frames stay on the canvas, and you remove what you do not want.

An agent that goes silent mid-run (its presence TTL expires) simply drops off the canvas; nothing is
attributed to a person.

### Reading element comments through MCP

Call `get_comments({ canvas_id })` to read the canvas's retained element comments and replies
(up to 100 entries, newest first). Each entry includes its ID, frame ID, author, text, timestamp,
CSS selector, HTML snippet, and any claim, failure, or resolution metadata. Replies carry a
`parentId` pointing to their root comment.

Pass `frame_id` to read only comments on a frame belonging to that canvas, or
`include_resolved: false` to exclude resolved entries. Resolved entries are included by default
so conversation context remains available. The result is `{ comments, total, has_more }` and pages
via `limit`/`offset` (50 at a time by default) — follow `has_more` rather than assuming one page is
everything. The tool enforces the same canvas access permissions as other MCP reads; optional
`agent_name` announces presence. It does not claim comments or mark anything resolved.

Writing is a separate path: `add_comment` pins a new note to one element (`selector` from
`inspect_frame`'s `elements[].selector`, or from an existing comment), `reply_to_comment` answers
inside a thread, and `resolve_comment` closes one once the note has actually been addressed. Comments
written by an agent carry `fromKind: 'agent'`, so the canvas badges them as agent-authored.

## What's in the box

- **Infinite canvas** — wheel to pan, `⌘`/`ctrl` + wheel (or pinch) to zoom, drag the background to pan,
  zoom-to-fit; dot grid tracks the viewport.
- **Frames** — drag to move, corner handle to resize, click to select. The right-hand inspector edits
  name/position/size and the raw HTML with debounced live saves. `⌫` deletes the selected frame.
- **Multiplayer** — live cursors with name tags, presence avatars, per-frame "who's editing" indicators,
  colored flash when a remote actor changes a frame, drag positions streamed live, auto-reconnect.
- **Activity feed** — every create/edit/rename/delete, by whom (user or agent), with timestamps.
- **Sharing** — the canvas URL is the share link (`Share` button copies it).
- **Connect AI modal** — copy-paste MCP setup instructions from the app itself.

## Architecture

```
server/          Node (tsx) — one process on :4400
  index.ts       Express REST API + ws rooms + presence + static serving (prod)
  store.ts       In-memory canvas/frame state (hot path), write-through to the DB
  db/            Drizzle schema + PGlite/Postgres connection + write-through persistence
  actions.ts     Shared mutations: broadcast + activity log + agent presence
  mcp.ts         MCP server (@modelcontextprotocol/sdk), stateless streamable HTTP at /mcp
  seed.ts        Demo canvas on first run
shared/types.ts  Store + ws protocol types shared by server and client
src/             React + Vite + zustand client on :4300
  components/ui/ The component system — every styled primitive lives here
  styles.css     Design tokens, the base reset, and keyframes. Nothing else.
```

### Styling

Doop's look is a component system, not a stylesheet. `src/components/ui/` holds the
primitives — `Button`, `Input`, `Badge`, `Card`, `Panel`, `Modal`, `Menu`, `Toolbar`,
`Segmented`, `Dash*` and the rest — each a Tailwind + [CVA](https://cva.style) recipe bound
to the tokens in `styles.css`. Screens compose those; they don't re-describe borders,
shadows or type scales. If a pattern shows up twice, it belongs in `ui/`.

`src/styles.css` is deliberately small: the `:root` tokens (`--ink`, `--paper`, `--brand`…),
their `@theme inline` mapping onto Tailwind names, the base reset, and the `@keyframes`
utilities cannot express. Components reference those animations by name, so the names are
API. `--breakpoint-md` (900px) is the mobile boundary and `useIsMobile()` matches it in JS —
change them together.

Frame HTML renders in `<iframe sandbox="allow-scripts">` — scripts run, but no same-origin access and
no reach into the app. Each iframe loads a small bootstrap once; new HTML is `postMessage`d in and
**DOM-morphed in place** (`src/lib/frameRuntime.ts`), so updates and streaming ticks never white-flash
the frame with a full document reload. Changed `<script>`s re-execute; unchanged styles/fonts are
untouched. The realtime layer is plain JSON over a per-canvas WebSocket room;
REST/MCP mutations are broadcast to the room by the shared actions layer, so human and agent edits go
through identical plumbing.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and code style.
`bun run test` runs the integration suite (it boots the real server against a throwaway database);
schema changes go through drizzle migrations (`npx drizzle-kit generate` after editing
`server/db/schema.ts`). Security issues: see [SECURITY.md](SECURITY.md) — please report privately.

## License

Doop is open source under the [GNU AGPL v3](LICENSE). In short: use it, self-host it,
modify it — but if you offer a modified version as a service, you must publish your
changes under the same license.

The **doop name and logo are trademarks** and are not covered by the code license —
please rebrand derived services.
