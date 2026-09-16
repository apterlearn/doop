/**
 * Bootstrap document loaded once per frame iframe. The parent posts HTML in
 * via postMessage and the runtime morphs the live DOM to match — only changed
 * elements are touched, so updates render in place with no white reload flash.
 * Works inside sandbox="allow-scripts" (no same-origin access needed).
 */
import { ELEMENT_KEY_SRC, ELEMENT_PATH_SRC } from '../../shared/selector'

export const FRAME_BOOTSTRAP = `<!doctype html>
<html><head></head><body><script data-v-boot>
(function () {
  /* horizontal overscroll inside a frame must not chain to the parent page,
     where the browser turns it into a history back/forward swipe. Adopted
     sheet, not a <style> tag — the morph would wipe a tag from <head>. */
  try {
    var vSheet = new CSSStyleSheet()
    vSheet.replaceSync('html,body{overscroll-behavior-x:none}')
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(vSheet)
  } catch (e) {}
  function syncAttrs(from, to) {
    for (var i = from.attributes.length - 1; i >= 0; i--) {
      var name = from.attributes[i].name
      if (name === 'data-v-ran') continue
      if (!to.hasAttribute(name)) from.removeAttribute(name)
    }
    for (var j = 0; j < to.attributes.length; j++) {
      var a = to.attributes[j]
      if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
    }
  }

  function isOpaque(el) {
    // subtrees we swap wholesale instead of walking
    var n = el.nodeName
    return n === 'STYLE' || n === 'TEXTAREA' || n === 'IFRAME' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml'
  }

  function morphChildren(from, to) {
    var tc = to.childNodes
    for (var i = 0; i < tc.length; i++) {
      var t = tc[i]
      var f = from.childNodes[i]
      if (!f) {
        from.appendChild(document.importNode(t, true))
        continue
      }
      if (f.nodeType !== t.nodeType || (f.nodeType === 1 && f.nodeName !== t.nodeName)) {
        from.replaceChild(document.importNode(t, true), f)
        continue
      }
      if (t.nodeType === 3 || t.nodeType === 8) {
        if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue
        continue
      }
      if (t.nodeType === 1) {
        syncAttrs(f, t)
        if (f.nodeName === 'SCRIPT') {
          if (f.textContent !== t.textContent) {
            f.textContent = t.textContent
            f.removeAttribute('data-v-ran') // changed script: re-execute
          }
        } else if (isOpaque(f)) {
          if (f.innerHTML !== t.innerHTML) f.innerHTML = t.innerHTML
        } else {
          morphChildren(f, t)
        }
      }
    }
    while (from.childNodes.length > tc.length) from.removeChild(from.lastChild)
  }

  /* cloned/imported script nodes never execute — swap in fresh ones */
  function activateScripts() {
    var scripts = document.querySelectorAll('script:not([data-v-ran]):not([data-v-boot])')
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i]
      var s = document.createElement('script')
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value)
      s.textContent = old.textContent
      s.setAttribute('data-v-ran', '1')
      old.parentNode.replaceChild(s, old)
    }
  }

  function render(html) {
    var doc
    try {
      doc = new DOMParser().parseFromString(html, 'text/html')
      syncAttrs(document.documentElement, doc.documentElement)
      /* the incoming html carries no root style, so the sync drops our
         crisp-render zoom — put it back before the page reflows */
      if (curZoom !== 1) document.documentElement.style.zoom = String(curZoom)
      morphChildren(document.head, doc.head)
      morphChildren(document.body, doc.body)
      activateScripts()
    } catch (e) {
      if (doc) document.documentElement.innerHTML = doc.documentElement.innerHTML
    }
  }

  /* ---- inline text editing ----
     The parent flips edit mode on. Instead of designMode (which makes the
     whole document a caret trap), we hit-test: hovering a text-bearing
     element outlines it, clicking makes JUST that element editable with the
     caret placed at the click point. Edits debounce-serialize back to the
     parent, which saves them through the normal frame-update path. */
  var editing = false
  /* the parent marks this document as the presentation ("doop:present"), which
     is the one thing that turns on the deck's key relays below */
  var presenting = false
  var activeEl = null
  var editTimer = null
  /* An element the mini toolbar has made rich carries data-v-rich: plain
     typing stays contentEditable 'plaintext-only' — a design's markup should
     not fall to a careless keystroke — and a format command is the one thing
     that turns markup on. The marker stays on the element for the session (a
     re-activated element comes back rich, see activate) and serialize() strips
     it, so it never reaches a saved document. */
  /* The last selection inside the active element. The toolbar lives in the
     parent document, so pressing one of its buttons can blur this document and
     collapse the selection the command was meant to act on; a command restores
     this range first. */
  var lastRange = null

  var EDIT_CSS =
    '[data-v-hover]{outline:1.5px dashed rgba(39,67,238,0.75)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]{outline:2px solid rgba(39,67,238,0.9)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]:focus{outline:2px solid rgba(39,67,238,0.9)!important}'

  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.replace(/[\\s\\u00a0]+/g, '')) return true
    }
    return false
  }

  /* nearest ancestor (incl. self) that directly contains visible text */
  function candidate(start) {
    var el = start && start.nodeType === 3 ? start.parentElement : start
    while (el && el !== document.body && el !== document.documentElement) {
      if (hasOwnText(el)) return el
      el = el.parentElement
    }
    return null
  }

  function clearHover() {
    var h = document.querySelector('[data-v-hover]')
    if (h) h.removeAttribute('data-v-hover')
  }

  function deactivate() {
    if (!activeEl) return
    activeEl.removeAttribute('contenteditable')
    activeEl.removeAttribute('data-v-active')
    activeEl = null
    lastRange = null // it pointed into the element that just lost the caret
    postActive()
  }

  /* tell the parent which element is selected for editing, so it can anchor
     the element toolbar (comment etc.) to it */
  function activeInfo() {
    return activeEl ? hitInfo(activeEl) : null
  }

  function postActive() {
    parent.postMessage({ type: 'doop:active', hit: activeInfo() }, '*')
  }

  function placeCaret(x, y) {
    var r = null
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(x, y)
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y)
      if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true) }
    }
    if (r) {
      var s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
    }
  }

  function activate(el, x, y, keepSelection) {
    if (activeEl !== el) {
      deactivate()
      activeEl = el
      el.removeAttribute('data-v-hover')
      el.setAttribute('data-v-active', '1')
      /* plain typing is plaintext-only; an element the toolbar has already
         made rich (see applyFormat) keeps taking markup */
      try {
        el.contentEditable = el.hasAttribute('data-v-rich') ? 'true' : 'plaintext-only'
      } catch (e) { el.contentEditable = 'true' }
      el.focus({ preventScroll: true })
      postActive()
    }
    /* double/triple clicks carry a native word/paragraph selection —
       placing a caret here would collapse it the instant it appears */
    if (!keepSelection) placeCaret(x, y)
  }

  function serialize() {
    var root = document.documentElement.cloneNode(true)
    var boot = root.querySelector('script[data-v-boot]')
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot)
    var es = root.querySelector('style[data-v-edit]')
    if (es && es.parentNode) es.parentNode.removeChild(es)
    var ran = root.querySelectorAll('[data-v-ran]')
    for (var i = 0; i < ran.length; i++) ran[i].removeAttribute('data-v-ran')
    var marked = root.querySelectorAll('[data-v-active],[data-v-hover]')
    for (var j = 0; j < marked.length; j++) {
      marked[j].removeAttribute('contenteditable')
      marked[j].removeAttribute('data-v-active')
      marked[j].removeAttribute('data-v-hover')
    }
    /* the toolbar's rich marker outlives deactivation by design (an element
       stays rich for the session), so it is stripped document-wide rather than
       only on whichever element happens to be active right now */
    var rich = root.querySelectorAll('[data-v-rich]')
    for (var k = 0; k < rich.length; k++) rich[k].removeAttribute('data-v-rich')
    root.style.removeProperty('zoom') // crisp-render zoom is ours, not the design's
    if (!root.getAttribute('style')) root.removeAttribute('style')
    return '<!doctype html>\\n' + root.outerHTML
  }

  function postEdited() {
    parent.postMessage({ type: 'doop:edited', html: serialize() }, '*')
    /* typing can move/grow the element — keep the parent's toolbar anchored */
    if (editing && activeEl) postActive()
  }

  function setEdit(on) {
    if (on === editing) return
    editing = on
    if (on) {
      var st = document.createElement('style')
      st.setAttribute('data-v-edit', '')
      st.textContent = EDIT_CSS
      document.head.appendChild(st)
    } else {
      if (editTimer) { clearTimeout(editTimer); editTimer = null }
      deactivate()
      clearHover()
      var st2 = document.querySelector('style[data-v-edit]')
      if (st2 && st2.parentNode) st2.parentNode.removeChild(st2)
      postEdited() // flush the final state before renders resume
    }
  }

  /* ---- rich text (the mini toolbar) ----
     Edit mode types as plain text so a design's markup cannot fall to a
     careless keystroke, but a format command IS the explicit request for
     markup: it upgrades the element it acts on to contentEditable='true' and
     marks it data-v-rich, which is what tells activate() to bring the element
     back rich when it is selected again (see the marker note above).
     The toolbar lives in the parent document, so the selection is remembered
     here and put back before a command runs — pressing a toolbar button would
     otherwise collapse the very words the command is about. */
  var FORMAT_TAGS = { bold: 'STRONG', italic: 'EM', underline: 'U' }

  function upgradeRich(el) {
    if (el.hasAttribute('data-v-rich')) return
    el.setAttribute('data-v-rich', '1')
    try { el.contentEditable = 'true' } catch (e) { /* keep whatever it had */ }
  }

  function selectionInside() {
    var s = getSelection()
    if (!s || !s.rangeCount || !activeEl) return null
    var n = s.anchorNode
    return activeEl === n || activeEl.contains(n) ? s : null
  }

  function saveRange() {
    if (!editing) return
    var s = selectionInside()
    if (s) lastRange = s.getRangeAt(0).cloneRange()
  }

  /* the live selection when there still is one, the remembered one otherwise */
  function restoreRange() {
    var s = selectionInside()
    if (s) return s.getRangeAt(0)
    if (!lastRange) return null
    var sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(lastRange)
    return lastRange
  }

  function selectRange(r) {
    var s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    lastRange = r.cloneRange()
  }

  /* Range fallback for bold/italic/underline: wrap the selected words in the
     tag, or lift them back out of it when they already sit inside one. */
  function wrapSelection(tag) {
    var r = restoreRange()
    if (!r || r.collapsed) return false
    var start = r.commonAncestorContainer
    var node = start.nodeType === 3 ? start.parentNode : start
    var holder = null
    while (node && node !== activeEl && node.nodeType === 1) {
      if (node.nodeName === tag) { holder = node; break }
      node = node.parentNode
    }
    if (holder && holder.parentNode) {
      var parent = holder.parentNode
      while (holder.firstChild) parent.insertBefore(holder.firstChild, holder)
      parent.removeChild(holder)
      return true
    }
    var frag = r.extractContents()
    var wrap = document.createElement(tag)
    wrap.appendChild(frag)
    r.insertNode(wrap)
    var after = document.createRange()
    after.selectNodeContents(wrap)
    selectRange(after)
    return true
  }

  /* Range fallback for the link button: selected words gain the anchor, a bare
     caret gets the url as the link's own text. */
  function insertLink(href) {
    var r = restoreRange()
    if (!r) return false
    var node = r.commonAncestorContainer
    var inline = node.nodeType === 3 ? node.parentElement : node
    var existing = inline && inline.closest ? inline.closest('a') : null
    if (existing && existing !== activeEl && activeEl.contains(existing)) {
      existing.setAttribute('href', href)
      return true
    }
    var a = document.createElement('a')
    a.setAttribute('href', href)
    if (r.collapsed) a.textContent = href
    else a.appendChild(r.extractContents())
    r.insertNode(a)
    var after = document.createRange()
    after.setStartAfter(a)
    after.collapse(true)
    selectRange(after)
    return true
  }

  /* Range fallback for the list buttons: the selection becomes the first item,
     a bare caret gets an empty one to type into. */
  function insertList(tag) {
    var r = restoreRange()
    if (!r) return false
    var list = document.createElement(tag)
    var item = document.createElement('li')
    list.appendChild(item)
    if (r.collapsed) item.appendChild(document.createElement('br'))
    else item.appendChild(r.extractContents())
    r.insertNode(list)
    var after = document.createRange()
    after.selectNodeContents(item)
    after.collapse(false)
    selectRange(after)
    return true
  }

  function applyFormat(command, value) {
    if (!editing || !activeEl) return false
    upgradeRich(activeEl)
    restoreRange()
    var ok = false
    try {
      /* execCommand is deprecated but still the only path that carries the
         browser's own markup rules (nesting, toggling off); the Range code
         above is the fallback for the commands it refuses. */
      ok = document.execCommand(command === 'link' ? 'createLink' : command, false, command === 'link' ? value : null)
    } catch (e) { ok = false }
    if (!ok) {
      var tag = FORMAT_TAGS[command]
      if (tag) ok = wrapSelection(tag)
      else if (command === 'link' && typeof value === 'string' && value) ok = insertLink(value)
      else if (command === 'insertUnorderedList') ok = insertList('UL')
      else if (command === 'insertOrderedList') ok = insertList('OL')
    }
    /* a formatted word saves through the normal frame-update path, exactly as
       a typed one does */
    if (ok) postEdited()
    return ok
  }

  /* remember where the caret is: a command can arrive after the toolbar has
     taken focus out of this document */
  document.addEventListener('selectionchange', saveRange)

  /* capture-phase: no link navigation or button handlers while editing */
  document.addEventListener('click', function (ev) {
    if (!editing) return
    ev.preventDefault()
    ev.stopPropagation()
    var el = candidate(ev.target)
    if (el) activate(el, ev.clientX, ev.clientY, ev.detail > 1)
    else deactivate()
  }, true)

  document.addEventListener('mousemove', function (ev) {
    if (!editing) return
    var el = candidate(ev.target)
    var prev = document.querySelector('[data-v-hover]')
    if (prev && prev !== el) prev.removeAttribute('data-v-hover')
    if (el && el !== activeEl) el.setAttribute('data-v-hover', '1')
  }, true)

  document.addEventListener('input', function () {
    if (!editing) return
    if (editTimer) clearTimeout(editTimer)
    editTimer = setTimeout(postEdited, 400)
  })

  /* Keys pressed with focus inside the frame never reach the parent window,
     so Escape is relayed out of here. The parent also says when this document
     IS the presentation (doop:present), and the deck's stepping keys are
     relayed the same way — focus lands in here the moment anyone clicks the
     deck, and a presenter who clicks must not lose their arrows. */
  var NAV_KEYS = { ArrowLeft: -1, ArrowRight: 1, PageUp: -1, PageDown: 1 }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (editing) {
        setEdit(false)
        parent.postMessage({ type: 'doop:edit-esc' }, '*')
      } else {
        parent.postMessage({ type: 'doop:esc' }, '*')
      }
      return
    }
    if (!presenting || editing) return
    var dir = NAV_KEYS[ev.key]
    if (ev.key === ' ' || ev.key === 'Spacebar') dir = ev.shiftKey ? -1 : 1
    if (!dir) return
    /* stepping must not also scroll the deck */
    ev.preventDefault()
    parent.postMessage({ type: 'doop:present-key', dir: dir }, '*')
  })

  /* ---- element probe + locate (comments) ----
     The parent can't see into this sandboxed document, so it asks: probe
     resolves the element at a point (for the click toolbar), locate finds a
     stored selector again (to place comment pins). Coordinates cross the
     boundary in design px; the crisp-render zoom is unapplied on both ends. */
  var curZoom = 1

  /* the selector algorithm is shared with the parent page and the server:
     ELEMENT_PATH_SRC is the same source that runs in both (shared/selector.ts) */
  ${ELEMENT_PATH_SRC}
  ${ELEMENT_KEY_SRC}
  var cssPath = globalThis.doopElementPath
  var elementKey = globalThis.doopElementKey

  function designRect(el) {
    var r = el.getBoundingClientRect()
    return { x: r.left / curZoom, y: r.top / curZoom, width: r.width / curZoom, height: r.height / curZoom }
  }

  function hitInfo(el) {
    var snippet = el.outerHTML || ''
    if (snippet.length > 400) snippet = snippet.slice(0, 397) + '...'
    return {
      selector: cssPath(el),
      key: elementKey(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      snippet: snippet,
      rect: designRect(el),
    }
  }

  function probe(x, y) {
    var el = document.elementFromPoint(x * curZoom, y * curZoom)
    if (!el || el === document.documentElement || el === document.body) return null
    return hitInfo(el)
  }

  /* the Layers panel selects by selector rather than by point */
  function describe(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement || el === document.body) return null
    return hitInfo(el)
  }

  /* hover inspection: like probe but fired on every (throttled) pointer move,
     so it skips the outerHTML/selector work and returns just tag + rect */
  function hoverProbe(x, y) {
    var el = document.elementFromPoint(x * curZoom, y * curZoom)
    if (!el || el === document.documentElement || el === document.body) return null
    return { tag: el.tagName.toLowerCase(), rect: designRect(el) }
  }

  /* full source of one element, with runtime markers stripped */
  function elementCode(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el) return null
    var c = el.cloneNode(true)
    var nodes = [c].concat(Array.prototype.slice.call(c.querySelectorAll('*')))
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('data-v-ran')
      nodes[i].removeAttribute('data-v-hover')
      nodes[i].removeAttribute('data-v-active')
      nodes[i].removeAttribute('data-v-rich')
      nodes[i].removeAttribute('contenteditable')
    }
    var html = c.outerHTML
    if (html.length > 20000) html = html.slice(0, 20000) + '\\n<!-- truncated -->'
    return html
  }

  /* ---- element properties (the Design panel) ----
     The panel cannot read computed styles across the sandbox, so it asks for
     a summary of one element and writes changes back as inline styles; the
     edited document then goes to the parent through the usual save path. */
  function px(v) {
    var n = parseFloat(v)
    return isNaN(n) ? null : Math.round(n * 100) / 100
  }

  function inspect(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement) return null
    var cs = getComputedStyle(el)
    var parentEl = el.parentElement
    var pcs = parentEl ? getComputedStyle(parentEl) : null
    var siblings = parentEl ? parentEl.children : [el]
    var index = 0
    for (var i = 0; i < siblings.length; i++) if (siblings[i] === el) index = i + 1
    var inline = {}
    for (var j = 0; j < el.style.length; j++) {
      var name = el.style[j]
      inline[name] = el.style.getPropertyValue(name)
    }
    var classes = (el.getAttribute('class') || '').trim().split(/[ ]+/).filter(Boolean)
    var text = ''
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue
    var sides = ['Top', 'Right', 'Bottom', 'Left']
    var drawn = 'Top'
    for (var b = 0; b < sides.length; b++) {
      if (px(cs['border' + sides[b] + 'Width']) > 0 && cs['border' + sides[b] + 'Style'] !== 'none') { drawn = sides[b]; break }
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: classes,
      parent: parentEl && parentEl !== document.documentElement
        ? { tag: parentEl.tagName.toLowerCase(), id: parentEl.id || '', className: (parentEl.getAttribute('class') || '').trim().split(/[ ]+/)[0] || '', display: pcs.display, flexDirection: pcs.flexDirection }
        : null,
      index: index,
      count: siblings.length,
      inline: inline,
      hasText: text.replace(/\\s+/g, '') !== '',
      rect: designRect(el),
      position: cs.position,
      display: cs.display,
      flexDirection: cs.flexDirection,
      width: px(cs.width),
      height: px(cs.height),
      left: px(cs.left),
      top: px(cs.top),
      minWidth: cs.minWidth,
      rowGap: px(cs.rowGap),
      columnGap: px(cs.columnGap),
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      opacity: px(cs.opacity),
      visibility: cs.visibility,
      backgroundColor: cs.backgroundColor,
      /* rounded: the crisp-render zoom snaps hairlines to device pixels */
      borderWidths: [
        Math.round(px(cs.borderTopWidth)),
        Math.round(px(cs.borderRightWidth)),
        Math.round(px(cs.borderBottomWidth)),
        Math.round(px(cs.borderLeftWidth)),
      ],
      borderStyle: cs['border' + drawn + 'Style'],
      borderColor: cs['border' + drawn + 'Color'],
      borderRadius: px(cs.borderTopLeftRadius),
      color: cs.color,
      fontSize: px(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      textAlign: cs.textAlign,
    }
  }

  var styleTimer = null
  function applyStyle(selector, styles) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el) return false
    for (var k in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, k)) continue
      if (styles[k] === null || styles[k] === '') el.style.removeProperty(k)
      else el.style.setProperty(k, String(styles[k]))
    }
    if (!el.getAttribute('style')) el.removeAttribute('style')
    /* a slider fires many of these a second — one save once it settles */
    if (styleTimer) clearTimeout(styleTimer)
    styleTimer = setTimeout(postEdited, 250)
    return true
  }

  window.addEventListener('message', function (ev) {
    /* only the parent drives this document — a script inside the frame must
       not be able to pose as the panel and push edits into the save path */
    if (ev.source !== parent) return
    var d = ev.data
    if (!d) return
    if (d.type === 'doop:inspect') {
      parent.postMessage({ type: 'doop:inspect-result', reqId: d.reqId, info: inspect(d.selector) }, '*')
    }
    if (d.type === 'doop:style' && d.styles && typeof d.styles === 'object') {
      var applied = applyStyle(d.selector, d.styles)
      parent.postMessage({ type: 'doop:style-result', reqId: d.reqId, ok: applied, info: applied ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:html' && typeof d.html === 'string' && !editing) render(d.html)
    if (d.type === 'doop:edit') setEdit(!!d.on)
    /* the mini toolbar's commands: applied to the active editable element, then
       saved by applyFormat through postEdited() */
    if (d.type === 'doop:format' && typeof d.command === 'string') {
      applyFormat(d.command, typeof d.value === 'string' ? d.value : null)
    }
    /* present mode on/off: only the presentation relays the stepping keys */
    if (d.type === 'doop:present') presenting = !!d.on
    if (d.type === 'doop:probe') {
      parent.postMessage({ type: 'doop:probe-result', reqId: d.reqId, hit: probe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:hover') {
      parent.postMessage({ type: 'doop:hover-result', reqId: d.reqId, hit: hoverProbe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:select') {
      parent.postMessage({ type: 'doop:select-result', reqId: d.reqId, hit: describe(d.selector) }, '*')
    }
    if (d.type === 'doop:code') {
      parent.postMessage({ type: 'doop:code-result', reqId: d.reqId, html: elementCode(d.selector) }, '*')
    }
    if (d.type === 'doop:locate') {
      /* a stored anchor can go stale: the selector is a positional path, so
         inserting a sibling above the element moves it. Fall back to the
         content key before giving up, and report a moved or lost anchor so
         the pin is not silently dropped. */
      var found = null
      var anchor = 'selector'
      try {
        var target = d.selector ? document.querySelector(d.selector) : null
        if (d.key) {
          var matches = []
          var all = document.querySelectorAll('*')
          for (var i = 0; i < all.length; i++) {
            if (elementKey(all[i]) === d.key) matches.push(all[i])
          }
          if (matches.length === 1) {
            /* a selector is a positional path: when the element it resolves to
               is not the one the content key names, a sibling was inserted
               above and the key is the truth */
            if (matches[0] !== target) { target = matches[0]; anchor = 'key' }
          } else if (matches.length > 1 && !target) {
            /* several elements answer to this key and none is pinned: report
               the ambiguity rather than picking one at random */
            anchor = 'ambiguous'
          }
        }
        if (target && anchor !== 'ambiguous') found = designRect(target)
        else if (anchor === 'selector') anchor = 'lost'
      } catch (e) { anchor = 'lost' }
      parent.postMessage({ type: 'doop:located', reqId: d.reqId, rect: found, anchor: anchor }, '*')
    }
    /* re-rasterize crisply when the canvas is zoomed in: layout stays identical
       (viewport is scaled up by the same factor outside) but pixels are k-times denser */
    if (d.type === 'doop:zoom' && typeof d.zoom === 'number') {
      curZoom = d.zoom
      document.documentElement.style.zoom = String(d.zoom)
    }
  })
  parent.postMessage({ type: 'doop:frame-ready' }, '*')
})()
</script></body></html>`

/* ---- frame edit requests (the text tool) ----
   A frame can be created on purpose in edit mode — T, or the toolbar's Text
   entry makes a frame and wants the caret in it. The frame's own FrameView is
   mounted by Stage, which this change does not own, so a prop threaded down to
   it would drag two other components along. The creator parks the frame id
   here instead and the FrameView claims it the moment its runtime answers
   ("doop:frame-ready"), then calls its own enterEdit() — the same entry point
   a double-click uses, so the lock and read-only gates still apply, unchanged.

   Entries only ever wait for their frame's runtime to boot, which happens once
   per frame iframe: a claim removes what it hands over, so nothing accumulates
   and a request nobody claims (a frame deleted before it mounted) is dropped. */
const pendingFrameEdits = new Set<string>()

export function requestFrameEdit(frameId: string): void {
  pendingFrameEdits.add(frameId)
}

export function takeFrameEditRequest(frameId: string): boolean {
  return pendingFrameEdits.delete(frameId)
}
