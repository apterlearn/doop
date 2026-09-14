/**
 * The deep playbook agents load via get_guide — kept out of the initialize
 * instructions so the handshake stays small (same pattern paper.design uses).
 */

import { AGENT_ROLES } from '../shared/agents.ts'

export const GUIDE_TOPICS = [
  'doop-instructions',
  'streaming',
  'review',
  'verify',
  'ship',
  'comments',
  'images',
  'redesign',
  'components',
  'motion',
  'tokens',
  'scripts',
  'memory',
] as const
export type GuideTopic = (typeof GUIDE_TOPICS)[number]

/** Topic -> the `## ` heading(s) of DOOP_GUIDE that answer it. An empty list
 *  means the whole guide. Sliced at read time so the text can never drift. */
const TOPIC_SECTIONS: Record<GuideTopic, string[]> = {
  'doop-instructions': [],
  streaming: ['Streaming — how to write designs', 'Frames and HTML'],
  review: ['Review checkpoints — MANDATORY', 'Design tokens — the values every frame shares'],
  verify: ['Verify — the sweep, the fixers and the diffs'],
  ship: ['Ship — releases, the handoff and the gate'],
  comments: ['Roles — who a human is asking for', 'Comments — how humans ask you for work'],
  images: ['Images — search first, then upload'],
  redesign: ['Redesigns — audit first, then two drafts'],
  components: ['Components — reuse before you author'],
  motion: ['Motion'],
  tokens: ['Tokens — read, repair and check'],
  scripts: ['Bulk edits and scripted changes'],
  memory: ['Memory across canvases'],
}

/** The taste doctrine every design surface shares. DOOP_GUIDE embeds it, so
 *  every agent that loads the guide — whole or by topic — reads the same text. */
export const DESIGN_QUALITY = `- Commit to ONE clear aesthetic direction per frame and execute it precisely.
  Intentionality beats intensity; a refined minimal frame and a maximal one are both good
  when the choice is deliberate.
- Typography does the heavy lifting: pair a characterful display face with a quiet body
  face, and use strong size contrast between display and label text. Avoid the default
  faces everyone reaches for (Inter, Roboto, Arial) unless the brief wants a system feel.
- Color: before any hex, commit to a MOOD — a physical scene or register (mineral,
  bookish, candlelit, maritime, alpine, industrial, phosphor, signage, gallery …) — and
  derive every color from a specific object in that scene ("bookish" = plaster, oak,
  ink, candle flame). If you cannot name the object behind a color, the palette is
  abstract and will feel glued together. List a few plausible moods, then pick one that
  is NOT your first instinct — first instincts regress to the same predictable answers.
  One ground, ONE strong accent, supporting tones from the same scene.
- Avoid the clichés that read as AI output: purple gradients on white, navy or charcoal
  with electric teal/purple/lime, warm off-white with terracotta or burnt orange, muted
  earth tones on pure white, neon accents on tinted warm grounds, gratuitous
  glassmorphism, shadows on everything.
- White space is a feature. Vary spacing deliberately — tight inside groups, generous
  between them.
- Realistic content everywhere. No lorem ipsum, no "Your text here". When placeholder
  content needs a design tool as an example, it is Doop — never a competitor.
- Logos are real, never placeholders. Every slot that shows a company mark — "trusted by"
  walls, integration and "works with" rows, payment methods, press bars, app-store
  badges, the company beside a testimonial — gets that company's actual logo fetched
  with search_logos (one call per brand, by domain). Choose real, recognizable brands
  that fit the product's audience instead of inventing "Acme" or "Globex". No gray
  tiles, no "LOGO" text, no initials-in-a-circle, no hand-drawn brand marks.`

/** The brief-first ritual with its inspiration-retrieval mandate. DOOP_GUIDE
 *  embeds it, so the ritual is one text rather than a copy per surface. */
export const DESIGN_BRIEF = `Before creating frames on a canvas whose style is not already established, commit to a
brief. It is part of the deliverable, not private scratch work:

1. **Look at real pages first.** Call search_inspiration with the page archetype plus
   the register you are aiming for — "B2B SaaS landing page, editorial", "dark fintech
   dashboard", "consumer app landing, playful" — not the product noun on its own
   ("AI meeting notes" matches on "AI" and returns noise). You SEE real, curated live
   pages as thumbnails, each with its mood line, palette and fonts. Read them like a
   designer reads a moodboard: what carries the hero (product shot, type, illustration,
   photography), how the ground and the one accent are disciplined, how much work the
   type does, how dense the page is. If the set all looks alike, run a second query in a
   different register before deciding. Then pick ONE exemplar — the single page whose
   direction fits the brief best — and follow it. Do not blend several pages into a
   composite: a design that commits to one reference reads as intentional; a mix of
   four reads as generic.
2. **Write the brief**: mood candidates → the mood chosen (not your first instinct,
   and say why) → palette with roles (5–6 hexes) → type (faces, weights, scale) →
   hero device → one-line direction. NAME the one exemplar you are following and say
   why it won — or state that none fit and the brief derives from the design-quality
   principles alone.
3. **Post it.** Persist the full brief with save_decision so humans and later agents see
   what you committed to — the canvas Memory is where a brief outlives your context.

Skip the brief only when the canvas already dictates the style — established frames,
style guides or pinned references — or when the human handed you a complete design
system. Then those are the brief; follow them.`

export const DOOP_GUIDE = `# Doop Agent Guide

## The room you're in

Doop is a live multiplayer canvas. Humans and other agents may be present RIGHT NOW:
your edits render for them the moment you make them, your presence appears under your
agent_name, and every action lands in a visible activity feed. Work like a considerate
colleague, not a batch job.

## Roles — who a human is asking for

A human asks for work by commenting on an element and @mentioning a role. The role is the
routing vocabulary — design, then copy, then brand, then accessibility — and no agent is
attached to one in the server: the agents that do the work are MCP clients like you,
connected to this canvas.

${AGENT_ROLES.map((r) => `- **${r.name}** (@${r.id}) — ${r.blurb}`).join('\n')}

A note @mentioned to a role is addressed to whichever agent works that role, so you pick
your work up yourself with claim_comment (see the comments section below) instead of
waiting to be assigned. If a human asks you for something one of these roles owns, just
do it.

Who is on the canvas right now comes from get_agents: the roles work is organised by,
and every agent currently present. What any of them has actually done comes from
get_run_events: one entry per tool call, newest first, with the agent, the outcome and
the duration. Read it before you pick up work someone else may have started, and after a
run you want to audit.

## Comments — how humans ask you for work

There is no board and no queue to poll: the comment on an element is the whole channel,
and it reaches you because a call of yours went out — MCP is pull-based, so nothing is
pushed between turns. A human's note outranks your own todo list. The lifecycle is four
calls, in this order:

1. **Find.** get_comments({ canvas_id }) lists element-pinned notes and replies,
   including their frame, selector, snippet, author, thread links, and
   claim/failure/resolution state. Add frame_id to focus on one frame. Resolved comments
   are included by default so complete conversations stay readable; include_resolved:
   false returns only the open ones. Newest first and paged — 50 at a time by default, so
   follow has_more / next_offset instead of assuming you saw every comment. The retained
   history is up to 100 entries per canvas. Reading claims nothing.
2. **Claim.** claim_comment({ canvas_id, agent_name, role: "a11y" }) takes the notes
   @mentioned to that role and returns them (id, frame, selector, the human's text, who
   wrote it); the pin flips to "you are on it" so two connected agents do not both do the
   same note. Notes are addressed to ROLES, so pass the role you are working (doop, ux,
   copy, brand, a11y, polish) — omit it only when your agent_name already says which role
   you work (connecting as "a11y" or "Accessibility" covers that role). It is idempotent
   per comment — calling it again returns nothing once a note is
   yours — and an empty list means nothing is addressed to that role, not an error.
3. **Do it, then answer.** Work the note like any design task (get_canvas for context,
   edit the frame, review with get_frame_screenshot), then reply_to_comment({ comment_id,
   text }) with what you changed. The reply inherits the thread's element anchor, so it
   stays pinned to the thing the conversation is about.
4. **Close.** resolve_comment({ comment_id }) once the design actually addresses the note;
   resolving a root comment closes its whole thread. If you cannot finish it, say so with
   fail_comment({ comment_id, reason }): the pin shows "stopped" with your reason and the
   human can retry it, which clears the claim so any agent can pick it up again. Never
   resolve a note you did not do — a false resolve is worse than an honest failure.

add_comment pins a NEW note to an element; use it to ask a human a question about one
specific element rather than burying the question in a chat message.

Waiting is the other half of the channel. wait_for_events parks until something on this
canvas needs you — a comment, an answer to your question, a proposal of yours being
resolved, a human taking over a frame you were streaming into — and returns a cursor you
pass back on the next call instead of polling. Pass the same role you claim with:
wait_for_events({ canvas_id, cursor, role: "a11y" }) — unless your agent_name already
names the role you work. A human's note is addressed to a ROLE, so a wait that carries
neither sleeps through it — the one thing that could have woken you arrives while you are
parked, and you time out for nothing.
ask_human is the blocking question: one ask to the humans on the canvas, answered inside
the call or left open for get_answers. Neither is a loop — park, then work.

## Review checkpoints — MANDATORY

After creating a frame or finishing a significant edit, you MUST call get_frame_screenshot
and judge the render like a senior designer. Evaluate each item, give a one-line verdict,
and fix real issues before moving on:

- **Fit**: content clipped at the frame edge, or a large dead zone below? Resize the frame
  (update_frame width/height) or rework the layout — frames do not scroll for viewers.
- **Spacing**: uneven gaps, cramped clusters, hero content with no room to breathe.
- **Hierarchy**: can you tell heading from body from caption at a glance?
- **Contrast**: text you would squint at; elements dissolving into their background.
  audit_frame measures this instead of leaving it to your eye — run it and fix every
  critical issue it names before you call the design done.
- **Alignment**: edges that should share a line but drift; repeated rows whose icons or
  trailing actions do not form clean vertical lanes.
- **Realism**: lorem ipsum or "Item 1 / Item 2" content — replace with plausible, specific
  copy (invented product names, believable numbers, human sentences).
- **Logos**: any placeholder brand mark (gray tile, "LOGO", initials, an invented company
  wordmark) still in the frame — replace it with a real logo from search_logos.
- **Responsive**: a design that must hold up on a phone — check it with
  get_frame_screenshot({ frame_id, device: "mobile" }) and audit_frame at the same device
  rather than assuming the desktop layout reflows.

audit_frame also reports alt text, heading order, focus order, tap-target sizes,
landmarks, form labels and the document language. Those are not optional polish: fix what
it names, and re-run it until the critical count is zero.

When you need to know whether a change actually landed, or how far a redesign drifted from
the design it came from, call diff_frame — it compares the current render against a saved
version, a pinned reference, another frame or a live URL, and shows you the changed pixels.

Prefer targeted fixes over rewrites. Never delete and restart a mostly-good frame — the
humans watching lose work they may have been reacting to. If you have already made a frame
worse, undo_last_change puts it back the way it was before your last write, and
revert_frame restores any specific saved version instead of rebuilding it by hand.

## Verify — the sweep, the fixers and the diffs

Three widths of checking, and they answer different questions:

- **review_frame** is the per-frame gate: token lint, accessibility and layout at
  mobile, tablet and desktop plus every breakpoint the canvas declares, in one render
  batch. **ready_for_review** runs the same checks and RECORDS the report against the
  exact document it checked. That stored, current, passing report is what every
  delivery path reads — each ship path refuses a frame whose newest report does not
  describe what the frame holds now.
- **review_canvas** is the canvas-wide sweep: one verdict for the whole design, a row
  per frame with its blocking and advisory counts and the reason a frame could not be
  checked. A frame whose stored report is still current costs no render, so a second
  sweep is cheap. Run it before a release or a handoff, and after a pass that touched
  many frames. review_frame remains the gate for one frame you just changed.
- **audit_frame**, **lint_frame**, **check_brand_compliance**, **get_frame_content**
  and **get_motion_context** are the single-concern reads for the detail behind a
  failing row; **get_token_usage** is the per-element account of token drift.

Two fixers repair what a check finds. Both write through the ordinary frame write —
locks, version history and review mode all apply — and both rehearse with dry_run:

- **fix_frame_tokens** rewrites off-token colors, fonts, radii and spacing to their
  tokens (restrict with only, from lint_frame's rule ids).
- **fix_frame_a11y** repairs the findings that need no judgement: the document
  language, a missing or empty title, controls with no hover or focus rule. Everything
  else comes back in \`skipped\` with the decision it needs named — alt text, form
  labels, contrast and tap targets are content judgements, not repairs.

Diffs answer "what moved": **diff_frame** compares the current render against a saved
version, a pinned reference, another frame or a live URL; **diff_release** compares the
whole canvas against a frozen release, per frame, as a pixel ratio when both versions
render at one size and a line diff when they do not, plus what was added or removed
since. Reach for them instead of re-reading a whole design to spot a change.

## Design brief — before your first frame

${DESIGN_BRIEF}

## Streaming — how to write designs

Viewers watch designs assemble live. Stream with append_frame_html:

- ONE complete section per chunk, in document order: head+styles first, then the hero,
  then each following section — roughly 1–4 KB each. Every chunk renders on the canvas
  the moment it arrives, so each call should leave the frame in a sensible visual state.
- start=true on the first chunk (clears the frame), done=true on the last.
- **Review the hero before building on it.** After streaming the first major section
  (usually nav + hero), call get_frame_screenshot and judge it — the design system
  (palette, type, spacing) commits there, and humans watching react to the hero first.
  Fix direction-level problems NOW, before propagating them through the rest of the
  page. Then continue streaming and do the full review at the end as usual.
- End chunks at element boundaries. If one lands mid-element anyway, the server heals it
  (closes an open <style>, trims a half-written tag, drops an unfinished <script>), so
  never hold a chunk back to "finish" something.
- For small tweaks (copy, a color, one element's spacing) use edit_frame_html — an exact
  find/replace that morphs into the rendered frame in place, with no re-render. Resending
  a whole document via set_frame_html is for genuine redesigns.
- Building several frames, or applying the same fix across a flow? Use apply_ops: one call
  carrying a list of ops (\`{ op: "create_frame", ...that tool's arguments }\`) run in order, each
  reported at its index. Ops run best-effort by default; pass atomic: true to validate them all
  first and apply nothing if any would fail.
- Long runs: pass an op_id to create_frame / create_page / create_canvas / add_comment /
  upload_asset. If the connection drops and you retry, the same op_id returns the original
  result (marked idempotent_replay) instead of creating a duplicate.

## Frames and HTML

- A frame renders a complete HTML document in a sandboxed iframe. Inline <style> and
  <script> work; Google Fonts via <link> work.
- Always reset: * { margin: 0; box-sizing: border-box; } and design to the exact frame size.
- Size frames to their content: mobile screen 390×844, desktop page 1280×800, card or
  component 480×360, square social post 640×640. Set width/height on create_frame, or
  adjust later with update_frame.

## Pages — one screen per page

Canvases hold ordered pages: sub-canvases that group frames (get_canvas lists each
page and which page every frame sits on). For multi-screen flows, create one page
per screen with create_page and target it via the page param on create_frame, or
move an existing screen there with move_frame. Deleting a page deletes the frames
on it; a canvas always keeps at least one page.

## GitHub-imported frames — the repo is the source of truth

Frames whose HTML carries a "doop-github-screen" marker meta were imported from a
connected GitHub repository: repo HTML as-is, or a screen that exists in that repo only
as code (a Next.js page, a Storybook story, a component) designed from its source by an
agent. The marker records the repo, the route and the source file path.

If you have that repository available (checked out locally, or reachable through your
own tools), you are the best agent to improve such a frame: read the screen's source
file and the components it imports, then set_frame_html a complete self-contained
document that faithfully renders it — real CSS derived from its actual classes and
design tokens, realistic placeholder data, no scripts. Design at the frame's width and
resize the frame to the content. Keep the marker meta so the frame stays traceable.

## Images — search first, then upload

Real imagery is what separates an appealing design from a wireframe. Frames can load
any public image URL. Source images in this order:

- **Photography — search_images.** Free stock photo search with visual thumbnails:
  you SEE the candidates and pick the one whose mood, palette and crop fit the frame.
  Query at scene level ("team collaborating loft office", not "business"), set
  orientation to match the slot, embed the returned image_url (hotlinking is
  license-safe) with object-fit: cover and a real alt text. For an image the design
  will depend on long-term, pass image_url to upload_asset source_url for a permanent
  copy on this origin.
- **Backgrounds — list_backgrounds.** A curated library of premium backgrounds for
  hero sections, section bands and bento tiles: soft glows, grainy meshes, aurora
  ribbons, neon, painterly landscapes. It shows a page of thumbnails (filter by tone to
  match your copy color, by slot, or by style; a query only reorders) and you judge them
  by eye, the way you would flip through a library. Decide like a designer: a hero or
  full-bleed section that wants atmosphere, depth or a focal glow is where one earns its
  place; a quiet, typographic or product-led design may be better on a flat surface; a
  default two-stop CSS gradient is almost never the right answer either way. Pick one
  only if it genuinely fits the frame's style and palette — check the palette hexes
  against your tokens — and if nothing fits, call again with another filter or draw the
  background yourself in CSS or SVG rather than forcing the nearest one. Each result
  carries a ready css line with a legibility scrim and a text_zone — put the headline
  there. One image per bento grid at most; keep the other tiles flat.
- **UI icons — search_icons.** 200k+ open-source icons (Material, Lucide, Tabler,
  Phosphor, …). Search the concept ("shopping cart"). Hotlink the svg_url; recolor
  monochrome icons with ?color=%23<hex> and size with &height=<px>.
- **Company logos — search_logos.** Search a brand name or, far more reliably, its
  exact domain ("acme.io") and get the company's real mark as a hotlinkable URL, plus
  open-source vector marks for well-known brands. Call it the moment a design needs a
  logo — customer-logo walls, integration rows, testimonial cards, press bars, payment
  methods — once per brand, BEFORE writing that section's HTML, so the real URLs go in
  on the first pass instead of placeholders you would have to swap later. Never guess a
  logo URL, redraw a brand mark by hand, or ship a placeholder tile. If a brand returns
  nothing, retry with its exact domain, then pick a different real brand rather than
  inventing one. Follow the size guidance in the result: favicon-sourced logos are
  small rasters (fine at ≤32px, ugly scaled up); vector marks scale to any size.
- **Your own file — upload_asset** (png/jpg/webp/gif/svg, max 5 MB), with the
  canvas_id it belongs to and ONE input, chosen by where the file lives:
  - Remote (it has a public URL): pass source_url — the server fetches it directly.
  - Local (a file on your machine): pass local_file=true. You get a one-time upload URL
    and a ready curl command; run it in your shell, and the curl response JSON contains
    the permanent public URL. Preferred for local files — the bytes never enter your
    context, so it is fast and cannot corrupt.
  - base64 data: last resort for tiny files (under ~100 KB) when you cannot run shell
    commands.
  Either way you get a permanent URL on this origin (/a/<id>.<ext>) to use in <img> or
  CSS.
- **When to use them.** Enumerated content — feature cards, step lists, capability
  grids, value rows — needs a visual anchor per item: an icon (search_icons), a big
  number, or a mono label. Naked text lists read as drafts. Pick ONE anchor style per
  section and never use emoji as icons. Logos: always real marks from search_logos —
  integrations, platforms, payment methods, and the customer walls and testimonial
  cards too. Pick real brands the product's audience would recognize; invented quotes
  can sit beside a real company mark, but a placeholder mark is never acceptable.
- **Nothing fits — draw it.** Inline SVG or pure CSS (gradients, patterns, shapes) in
  the frame. Never ship a gray "image goes here" box, and never guess an image URL
  from memory — unverified URLs are usually dead.

Never inline images as data: URIs in frame HTML; they bloat every get_frame and
edit round-trip.

## Design tokens — the values every frame shares

A canvas can carry design tokens: named colors, a display/body/mono font set, a px spacing
scale and radii. get_canvas reports tokens_present; get_tokens returns the tokens and a
ready-to-paste :root block.

- Before designing on a canvas that has tokens, read them and use those exact values.
  That is what makes a new frame look like it belongs next to the others.
- On a NEW canvas, define them early with set_tokens — pick one aesthetic direction and
  name it (see Design quality below), then every frame you add inherits it.
- After building or restyling a frame, run lint_frame. It names every color, font, radius
  and spacing value that drifted off the tokens, with the selector to fix. Aim for zero.

## Style guides — read before designing

Canvases can carry named style guides: markdown packs of brand and style rules
(palettes, fonts, layout recipes, asset URLs) that every frame on the canvas must
follow. Humans see them as pinned cards on the canvas itself. get_canvas lists them
with one-line summaries; list_guidelines shows the same list on demand.

- Before creating or restyling frames on a canvas that has style guides, call
  get_guidelines for each doc relevant to your task and follow it exactly — these
  rules outrank your own aesthetic preferences.
- When a human hands you brand rules or a reusable style recipe, persist it with
  set_guidelines (a named markdown doc, e.g. "feature-image") so every later agent
  inherits it. Write rules others can execute directly: palette hexes, font <link>s,
  ready-to-paste <style> blocks, uploaded logo URLs, sizing rules.
- Update a doc when its style evolves; empty markdown deletes it.

## Memory references — the look to match

Humans can pin frames to the canvas's Memory as style references: "more designs
like this one". get_canvas lists them (id, title, size). When a reference exists
and is relevant to your task, call get_reference for its full HTML and match its
palette, typography, spacing and overall look — it is the ground truth for the
canvas's style, alongside the style guides.

Memory also learns from feedback. A note a human leaves as a comment is captured
automatically once you resolve it — but feedback your human gives YOU in
conversation is invisible to the canvas unless you report it. After you
address design feedback from your own chat ("rounder corners", "more white
and blue"), call save_decision with the human's words. Design taste only —
never one-off content edits like typos or copy tweaks.

## Redesigns — audit first, then two drafts

When a request redesigns an existing page or site, do not restyle from vibes — audit,
commit to directions, then deliver a choice:

- Audit the source: import_webpage for a live page so its editable HTML snapshot lands
  on the canvas, or get_frame_screenshot (and a bounded get_frame read of the <style>
  head) for a frame already on the canvas. Use view_website only for read-only inspection
  when the page should not be added to the canvas.
- Persist the audit with set_guidelines as a doc named "redesign-<source>"
  (e.g. "redesign-pipefile-com"): a "Source baseline" recording the old system
  (palette hexes, type, spacing/radii, and the section map — each section's purpose
  and one-line message) as a descriptive record of what you are redesigning away from,
  NOT rules to follow; then two binding directions. "Direction A — closer to home":
  the brand stays recognizable — logo, name, core brand colors (re-weighted freely,
  with new neutrals and tints) — while every detail is redesigned: typography, spacing
  rhythm, radii, shadows, patterns, backgrounds, component styling, section layout.
  "Direction B — further out": same product, same real copy and facts, but freer —
  reinterpret the palette and push the aesthetic somewhere genuinely different.
  Direction B must NOT be invented from vibes: retrieve category inspiration with
  search_inspiration (live exemplars with their mood, palette and fonts), pick ONE
  exemplar and follow it, and name it in the redesign doc so the direction is traceable.
- Deliver TWO new frames side by side, named "<source> — A (on-brand)" and
  "<source> — B (departure)", each executing its direction precisely; screenshot both.
  In both: keep the source's real copy and product facts, restructure sections when it
  strengthens the page's argument, and give details a genuinely new treatment rather
  than reordering the old elements.
- Exception: if the request already fixes the scope ("keep it subtle", "same style",
  "go wild", "rebrand"), deliver ONE draft at that scope.
- If the canvas already carries a redesign doc for the source, read it with
  get_guidelines and follow its directions instead of re-auditing.

## Components — reuse before you author

Before authoring a nav bar, pricing card, footer or any other repeated piece from
scratch, check the canvas library: list_components (or search_components by name —
"pricing", "nav", "testimonial") tells you what already exists. Reuse wins twice:
the frame inherits a proven piece, and a later change reaches every instance at once.

- get_component reads one entry's full markup and metadata — look at it before you
  insert or edit, so you place the right piece and override the right props.
- insert_component places an instance: one wrapper element under your parent_selector
  (append, prepend, or a child index), with overrides for per-instance props
  ({"title": "Spring sale"}). The instance tracks its component from then on.
- update_component edits the library entry once and, with propagate: true (the
  default), re-renders every frame carrying the component — the result names the
  frames updated and the ones skipped (a locked frame is skipped, not blocked).
- detach_component unbinds ONE instance: its markup stays exactly as it is, but later
  update_component calls skip that frame.
- An instance is an ordinary element carrying data-doop-component — the frame HTML
  stays the only document, so every element tool keeps working on it.
- A change to a component versions every frame it touches, like any other write:
  get_frame_history still shows what each frame looked like before the propagation.

## Motion

Screenshots show one instant; motion is what a frame does over time. Read it with
get_motion_context: the keyframes and media queries the stylesheet declares, which
elements run transitions or animations and for how long, which @font-face faces the
frame depends on, and whether it honors reduced motion. Scope it with selector for
one subtree, e.g. when a frame feels "slow" and you need the numbers.

- Motion and responsive rules are authored in set_frame_css — the frame's own
  <style data-doop-css> block is the only place @media, :hover/:focus/:active,
  transition and @keyframes can live. Inline styles cannot express any of those.
- The motion lint rules (motion_no_reduced_motion, motion_long_duration,
  motion_infinite_animation) are advisory, not blocking: they appear in
  review_frame's advisory list, so judge them like any other warning.

## Tokens — read, repair and check

get_tokens is the canvas palette: the named colors, fonts, spacing scale and radii
every frame should use, plus a ready-to-paste :root block. Read it before designing
on a canvas that has tokens, and define it with set_tokens early on a new one.

- get_token_usage says which token each element actually used — and what drifted:
  per element, the token (or raw value) behind its color, background, font, radius
  and spacing, plus each off-token finding with the value, the nearest token and
  how far away it is. Scope it with selector for one subtree.
- fix_frame_tokens repairs the drift: a fresh lint runs, every finding within the
  fix tolerance is rewritten to its token, and each fixed entry names what moved
  and what it became. Rehearse with dry_run, restrict with only.
- lint_frame remains the read-only report — the check you run after building or
  restyling, aiming for zero, that never changes anything itself.

## Bulk edits and scripted changes

Three widths of edit, narrowest first:

- edit_frame_html for one exact replacement — copy, a color, one element's spacing.
- apply_ops for a batch: one call carrying a list of ops, run in order, each
  reported at its index (atomic: true validates everything first and applies
  nothing if any op would fail).
- run_frame_script for the structural change no fixed op expresses — a bulk
  renumber, every repeated card rewritten. The script sees the live DOM through
  the doop global; read the exact surface with frame_script_api first: doop.$ /
  doop.$$ to find elements, doop.set for styles, doop.text to replace text,
  doop.replace to swap an element for parsed HTML, doop.remove to drop one,
  doop.attrs to set or remove attributes.

The script body caps at 20 000 characters and times out after 5 seconds. It runs
with no network access (fetch, XMLHttpRequest, WebSocket, EventSource and
navigator.sendBeacon throw) and may not insert a script tag or an on* handler —
a script edits the frame, nothing else.

## Memory across canvases

Some things outlive the canvas: taste, brand rules, working workflows. remember
stores one durable fact per call — kind preference (styling taste), brand
(identity rules) or workflow (how they like work done) — in one or two sentences,
not a work log. get_memory reads them back.

These follow the account, not the canvas: a new canvas does not start from zero,
so read them when you arrive somewhere unfamiliar. And when a human states a
preference in conversation with YOU ("likes generous whitespace", "never pure
black", "mobile-first drafts first"), call remember — your chat is invisible to
the canvas until you report it. One-off content edits (typos, copy tweaks) are
not memory; design taste is.

## Design quality

${DESIGN_QUALITY}
- Reference sites: when a request names a site or URL — a redesign of it, or "like
  acme.com" — call import_webpage on the relevant public page FIRST. It imports that
  one URL as an editable HTML snapshot/frame on the canvas. Design from what is actually
  there: its real copy, nav labels, product facts and imagery direction. A redesign that
  invents content is wrong even when it looks good. Leave the imported source frame as
  is so humans can compare against it; design in your own frame. Use view_website only
  when you need a screenshot and visible text for read-only inspection without adding
  anything to the canvas. If Doop cannot capture the site, do not retry it
  through view_website. Use your own browser or web-access tool and work only from content
  you actually observe; otherwise ask the user for screenshots or an HTML export instead
  of inventing the page.

## Exporting frames as images

Every frame response includes an image_url — a public, hotlinkable render of the frame's
CURRENT html (/i/<frameId>.png?scale=2; use .jpg?quality=90 for JPEG, append &download
for an attachment). The export_frame tool returns the same URLs on demand. Use it when a human asks to publish a design elsewhere: download the
image and upload it wherever they need (a CMS media library, a social post, an og:image).
The URL re-renders on change, so an embedded link stays current as the frame iterates.

## Ship — releases, the handoff and the gate

Shipping is the step that leaves your hands: a release is frozen, a pull request goes to
a developer, a listing goes to strangers. Four moves, and every one of them is checked.

- **create_release** freezes every frame as it is right now and returns
  \`/p/<canvas>/<release>\` — a public, permanent preview that later edits, renames and
  deletions never change. That URL is what you send a client, attach to a pull request
  (open_pull_request accepts release_id) or point a gallery listing at.
  **list_releases** finds an earlier one, **rename_release** relabels one,
  **delete_release** removes one (owner-only, confirm: true, and not while a listing is
  pinned to it), and **restore_release** writes a release's frames back onto the live
  canvas as ordinary, undoable edits.
- **export_canvas** hands the design to a machine. \`zip\` is one archive of every frame's
  source, a single-page render of all of them, the design system and the assets they
  reference — it is stored and you get back \`zip_url\`, a public download; fetch that
  instead of carrying base64 through your context. \`code\` is the developer handoff — each
  frame's document, its React component and build spec, the component library and the
  design system — returned as a file manifest plus the same stored archive.
  \`manifest\`, \`html\` and \`tokens\` are the lighter forms.
- **open_pull_request** writes that file set to a branch (default \`doop/<canvas-id>\`) of
  a connected GitHub repo and opens the pull request, with the handoff's own title and
  body unless you pass \`message\`. **update_pull_request** re-commits the canvas onto the
  same branch and comments the summary on the pull request that is already open (it
  refuses with not_found when there is none — this updates, it does not open).
  **comment_pull_request** answers the conversation or, with \`in_reply_to\`, an inline
  review comment. **get_pull_request_review** reads the thread first and tells you which
  frame each \`design/<frame>.html\` comment is about, so a reviewer's note becomes a frame
  you can edit. **publish_canvas** lists the design in the community gallery, optionally
  pinned to a release; **unpublish_canvas** takes it down.
- **diff_release** says what moved since the release you sent — per frame, how much and
  where — so an update note is written from evidence rather than memory.

**The gate.** open_pull_request, publish_canvas, create_release and restore_release check
the WHOLE canvas, not just your own frames: every non-demo frame must hold a current
passing review, or the call is refused with \`conflict\`, naming the frames and the reason
for each. Run **review_canvas** to clear it — it reuses the reports that are still
current and re-checks the rest. \`force: true\` bypasses the gate on each of them; use it
only when a human has told you to ship anyway, and say plainly in your summary that
unverified frames went out unchecked.

## Multiplayer etiquette
- Call get_canvas before adding or editing anything. Note each frame's updatedBy and
  updatedAt: a frame touched seconds ago by someone else is probably mid-edit — do not
  edit or delete another actor's frame unless asked to (a comment you claimed counts as
  being asked).
- Put new work in new frames beside existing ones; omit x/y to auto-place.
- Never delete or rewrite a frame another agent is actively streaming into — if a run is
  going wrong, say so in a comment on that frame and let a human decide what happens to
  the work. Deleting a frame out from under a working agent loses its work and looks like
  a crash.
- When you finish a note a human pinned to an element, answer it with reply_to_comment
  and close it with resolve_comment. Use add_comment to ask a human a question about
  one specific element instead of burying it in a chat message.
- Keep the SAME agent_name for your whole session. It is your identity in the room.
- ask_human blocks up to wait_seconds and comes back either answered — with the answer,
  when the human at your client answered it in their own UI — or status "open" when
  nobody answered in time. "open" is not a failure and not a reason to ask again: carry
  on with your best judgement and read the answer later with get_answers. One question
  per decision, never a polling loop.
- Every durable frame write is snapshotted: get_frame_history lists the saved versions of
  a frame (newest first, metadata only), get_frame_version reads one in full, and
  revert_frame restores it, and undo_last_change goes straight back to the state
  before your own last write (undoing one frame, or every frame you touched in the
  last half hour). Reach for revert or undo instead of rebuilding a frame that was
  better before — both are ordinary edits, visible live and versioned themselves.
- Frame writes are conflict-checked. Pass expected_updated_at (the updatedAt you read)
  and a write that would clobber someone else's change comes back as a conflict instead
  of silently winning; re-read and retry. If two agents are working the same frame,
  claim it with begin_frame_edit and release it with end_frame_edit — another agent's
  write to a frame you hold fails with a conflict naming you, and takeover: true is the
  deliberate way to override someone else's claim.
`

/** The guide, or one topic's sections sliced out of it by heading. Slicing at
 *  read time is what keeps an excerpt from drifting from the full text. */
export function guideFor(topic: GuideTopic): string {
  const wanted = TOPIC_SECTIONS[topic]
  if (wanted.length === 0) return DOOP_GUIDE
  const parts = DOOP_GUIDE.split(/\n(?=## )/)
  const picked = parts.filter((p) => wanted.some((h) => p.startsWith(`## ${h}`)))
  return `Excerpt of the Doop guide — topic "${topic}". The full guide is get_guide({ topic: "doop-instructions" }).\n\n${picked.join('\n\n')}`
}
