/*
 * Skimbold DOM engine: the content script that bolds word starts on a page.
 *
 * Sentinel technique: an eligible text node keeps its place in the DOM but is
 * emptied, and a <skb-w> wrapper holding the bolded copy of its text goes right
 * after it. Frameworks that hold a reference to the text node can still update,
 * move or remove it; one MutationObserver per root reconciles the wrapper with
 * whatever the page did. Disabling puts every text back, so a static page ends
 * up with byte-identical markup.
 *
 * Everything runs in the content script's isolated world; nothing in the page's
 * own JavaScript world is changed. So page scripts see the real DOM: an emptied
 * node reads '', and the words live in the wrapper's text nodes. A page that
 * edits inside a wrapper (a search highlighter marking a word) makes that
 * wrapper its own content, which is never re-rendered and is unwrapped in place
 * on disable.
 *
 * Wrapped in an IIFE so a second injection into the same content-script world
 * finds Skimbold.engine and bails out instead of redeclaring anything.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold || (globalThis.Skimbold = {});
  if (Skimbold.engine || !Skimbold.core || !Skimbold.settings) return;

  // A page element with id="browser" shows up as globalThis.browser in the
  // isolated world, so only trust that name when it is the real extension API.
  const maybeBrowser = globalThis.browser;
  const api = maybeBrowser && typeof maybeBrowser === 'object' && maybeBrowser.runtime ? maybeBrowser : globalThis.chrome;

  // Scanning runs in slices of at most SLICE_MS, adapting to how long the browser
  // takes to render each slice (see nextBudget). The first slice of a whole page
  // runs synchronously in the toggle and all of it renders in one frame, so it is
  // kept to FIRST_SLICE_MS (measured: 4 ms gave 55-108 ms frames on GitHub, 1 ms none).
  const SLICE_MS = 8;
  const FIRST_SLICE_MS = 1;
  const MIN_SLICE_MS = 1;
  const RENDER_TARGET_MS = 16;
  const FRAME_FALLBACK_MS = 100;
  // Page edits are reconciled in the observer's microtask. Past this budget the
  // remaining edited nodes are handed back and re-wrapped by the sliced scan.
  const RECONCILE_MS = 4;
  // A text node is wrapped in one step and rendered in one frame, so longer ones
  // are left alone (measured: 32,000 characters take 12 ms with no long frame,
  // 60,000 cause a 53 ms frame). Paragraphs are far shorter than this.
  const MAX_TEXT = 32768;
  // A text node rewritten this often within CHURN_MS is being fought over by a
  // page script that undoes each render, so it is handed back for good.
  const CHURN_LIMIT = 50;
  const CHURN_MS = 100;
  // Text nodes are wrapped in batches, one per slice: the styles a batch needs are
  // all read before any of it is written, while the styles the last frame computed
  // are still current. Reading after our own writes would make the browser restyle
  // the page again for every batch, which on pages with costly selectors (:has())
  // turned each slice into a long frame (measured on nextjs.org). The deadline and
  // the cost estimate size a batch; the count only caps a run of tiny text nodes,
  // whose cost per node the estimate per character lags behind (measured: a cap of
  // 64 made a 20,000-cell table take 5x longer, 512 costs no long frames).
  const BATCH = 512;
  const STYLE_TTL_MS = 1000;
  // Streaming: a container whose wrapped text the page replaces again within
  // HOT_MS is re-rendering (a chat answer, a live ticker), and new text in it is
  // wrapped once it has been quiet for QUIET_MS instead of on every frame, or at
  // the latest MAX_DEFER_MS after it arrived. A container that throws away
  // wrappers made less than STRIKE_MS before is fighting the engine: after STRIKES
  // of those its new text waits until it has been quiet for RETRY_MS, and each
  // time it throws that away too, the next wait doubles, up to MAX_RETRY_MS.
  const HOT_MS = 250;
  const QUIET_MS = 200;
  const MAX_DEFER_MS = 400;
  const STRIKE_MS = 100;
  const STRIKES = 5;
  const STRIKE_DECAY_MS = 5000;
  const RETRY_MS = 1000;
  const MAX_RETRY_MS = 16000;
  // A manual enable while the page is still loading waits for the load event (at
  // most until LOAD_WAIT_MS after the page opened) and a moment of idle, so
  // server-rendered apps hydrate before any text is wrapped. auto.js waits for the
  // load event and idle too.
  const LOAD_WAIT_MS = 3000;
  const IDLE_WAIT_MS = 1000;
  const FRAMES_DELAY_MS = 150;
  // A shadow root attached after the scan passed its host (a custom element
  // defined later) causes no mutation the observers see, so custom elements
  // without one are looked at again every HOST_SWEEP_MS, until HOST_SWEEP_QUIET
  // looks in a row find nothing and the page has stopped changing.
  const HOST_SWEEP_MS = 2000;
  const HOST_SWEEP_QUIET = 5;

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const COMMENT_NODE = 8;
  const FRAGMENT_NODE = 11;
  const SHOW = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT;

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'code', 'pre', 'kbd', 'samp', 'var', 'tt', 'svg', 'math', 'canvas', 'video', 'audio',
    'iframe', 'object', 'embed', 'head', 'title', 'mjx-container', 'skb-w', 'skb-b',
    // Icon components: their text is a name that an icon font draws as one glyph (a ligature).
    'mat-icon', 'md-icon', 'mwc-icon',
  ]);
  const SKIP_ATTRS = [
    '[contenteditable]:not([contenteditable="false" i])', '[role="textbox"]', '[data-skimbold-skip]',
    '.monaco-editor', '.CodeMirror', '.cm-editor', '.ace_editor', '.xterm',
    '.MathJax', '.katex', '.MathJax_Display',
    // MathJax 2's fast preview and its other outputs.
    '.MathJax_Preview', '.MathJax_CHTML', '.MathJax_PHTML', '.MathJax_SVG',
    // Captions a video player sizes to their measured text.
    '.ytp-caption-window-container', '.vjs-text-track-display', '.jw-captions', '.jw-text-track-container',
    '.plyr__captions', '.shaka-text-container', '.bmpui-ui-subtitle-overlay',
    '[class*="material-icons"]', '[class*="material-symbols"]', '[class*="google-symbols"]', '.mat-icon',
    // An Astro island that has not hydrated yet; Astro removes the attribute once it has.
    'astro-island[ssr]',
  ].join(',');
  // Matches an element that is, or sits inside, a zone we never touch.
  const ZONE = [...SKIP_TAGS].join(',') + ',' + SKIP_ATTRS;
  // Unrendered TeX: \( \[ $$ or $…$ with a backslash inside. MathJax may be about to typeset it.
  const TEX_RE = /\\[([]|\$\$|\$[^$]*\\[^$]*\$/;
  const NOT_BLANK = /\S/;
  const TEXT_OPTIONS = ['mode', 'strength', 'letters', 'skipShort', 'everyNth'];
  // Computed display values whose children each become a box of their own (flex and
  // grid items); a run of adjacent text nodes there shares one anonymous item.
  const ITEM_LAYOUT = /\b(?:flex|grid)\b/;
  // Icon fonts draw a lower-case name such as "edit" as a single glyph.
  const ICON_FONT = /icons|symbols/i;
  const ICON_WORD = /^[a-z][a-z0-9_]*$/;
  // A copy of a field's text drawn under a transparent field sits this close to it (see
  // isMirror; GitHub: 1 level up for its filter and search bars, 3 for its code view).
  const MIRROR_LEVELS = 3;
  // A computed colour with zero alpha: rgba(…, 0), or color(… / 0) and the like.
  const CLEAR = /^rgba\(.*,\s*0\)$|\/\s*0\)$/;
  const WEIGHTS = [600, 700, 800, 900];

  // Attribute changes are watched so a region that becomes editable (click-to-edit
  // pages) is handed back before the user can type into our wrappers.
  const OBSERVE = {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'role', 'data-skimbold-skip', 'ssr'],
  };

  const isTop = window.top === window;

  let active = false;
  let loaded = false;
  let settings = Skimbold.settings.sanitize(null);
  // Bumped whenever a setting that changes the bolding changes; wrappers rendered
  // under an older value are re-rendered when the scan reaches them.
  let gen = 0;
  let warned = false;
  // Counts explicit on and off requests, so auto.js never overrides the user.
  let choices = 0;

  const wrapperOf = new WeakMap(); // source text node → its <skb-w>
  const sourceOf = new WeakMap(); // <skb-w> → the text node it was made for (kept after release)
  const textOf = new WeakMap(); // source text node → the text it holds for the page
  const genOf = new WeakMap(); // <skb-w> → the gen it was rendered with
  const churn = new WeakMap(); // source text node → { since, count } of recent page rewrites
  const unstable = new WeakSet(); // text nodes handed back for good
  // Wrappers the page edited inside (a highlighter's <mark>): page content now,
  // never re-rendered, and unwrapped in place on disable.
  const owned = new WeakSet();
  // Wrappers the page edited inside since the last reconcile (see fixSource).
  const edited = new Set();
  // Weak references to every source, so disable() can restore sources that sit
  // in detached subtrees a page may still re-insert (cached views, carousels).
  let sources = new Set();
  let listed = new WeakSet();
  let sourceSweepAt = 1024;

  const roots = new Map(); // Document or open ShadowRoot → { observer, style }
  let rootSweepAt = 64;
  let sheet = null;
  let css = ''; // the rules the sheet and the <style> fallbacks hold (see restyle)

  let queue = [];
  let head = 0;
  const queued = new Set();
  let walk = null; // { root, walker } of the scan in progress
  let pass = { count: 0 }; // everyNth state shared by one scan pass
  let batch = []; // text nodes found by the scan, wrapped together (see flush)
  let batchChars = 0;
  // How long wrapping takes per character of text, measured as the engine goes, so a
  // batch is flushed before it would run past the slice's deadline.
  let msPerChar = 0.0004;
  const styles = new WeakMap(); // element → what its computed style means for wrapping
  const clearFields = new WeakMap(); // element → { at, fields }: the fields with transparent text inside it

  const textDirty = new Set();
  const posDirty = new Set();
  const zoneDirty = new Set();
  const strays = new Set();
  const hostsDirty = new Set(); // elements whose shadow root the page attached after the scan
  // Sources a text walker wrote to, until they are handled (see collect and reconcile).
  const walked = new Set();
  // Elements a script took apart since the last reconcile (a highlighter clearing its
  // marks) and the elements it put their children into, and the records of sources
  // removed after that (see fixSource).
  const apart = new Set();
  const places = new Map(); // source → the record that removed it
  // Removed subtrees that held wrappers; what is still off the page when they are
  // handled is given its text back (see reconcile).
  let detached = [];

  // Streaming containers (see HOT_MS).
  let heats = new WeakMap(); // container → { at, strikes, struckAt, retryMs }
  const bornAt = new WeakMap(); // <skb-w> → when the scan made it, to tell a page that fights it
  const deferred = new Map(); // text or element waiting for its container to go quiet → { container, at }
  let deferTimer = 0;
  let deferDue = 0;

  // Custom elements the scan found without a shadow root (see HOST_SWEEP_MS).
  const hostless = new Set();
  let hostSweepTimer = 0;
  let hostSweepQuiet = 0;

  let loopToken = null;
  let frameToken = null;
  let starting = null; // an enable() waiting for the page to finish loading
  let writeDepth = 0;

  function warn(error) {
    if (warned) return;
    warned = true;
    console.warn('Skimbold:', error);
  }

  function looksLikeTex(text) {
    return (text.includes('\\') || text.includes('$$')) && TEX_RE.test(text);
  }

  /* ── Styles ────────────────────────────────────────────────────────────── */

  // ID-level specificity plus !important beats page resets of b/strong, rules
  // for unknown elements and :not(:defined){visibility:hidden}.
  function cssText() {
    const weight = settings.weight;
    // font-synthesis-weight: a page that turns synthetic bold off, in a font with no
    // bold face, would otherwise hide the bold entirely.
    let css = ':is(skb-w,skb-b):not(#skb-_){all:unset!important;display:inline!important;visibility:inherit!important}'
      + `skb-b:not(#skb-_){font-weight:${weight}!important;font-synthesis-weight:auto!important}`;
    // Text already at least as heavy as the bold setting (a bold heading, a table
    // header) keeps its own weight in the word starts: never lighter, and never a
    // heavier face, which can be a different font with taller lines (Arial Black).
    const heavy = WEIGHTS.filter((w) => w >= weight).map((w) => `skb-w[data-skb-weight="${w}"]`);
    if (heavy.length > 0) css += `:is(${heavy.join(',')}):not(#skb-_)>skb-b:not(#skb-_){font-weight:inherit!important}`;
    if (settings.fade > 0) {
      // Text that paints with its own fill (a gradient clipped to the text) keeps it.
      css += 'skb-w:not([data-skb-fill]):not(#skb-_){-webkit-text-fill-color:color-mix(in srgb,currentColor '
        + (100 - settings.fade) + '%,transparent)!important}'
        + 'skb-w:not([data-skb-fill]):not(#skb-_)>skb-b:not(#skb-_){-webkit-text-fill-color:currentColor!important}';
    }
    return css;
  }

  function styleParent(root) {
    return root === document ? document.head || document.documentElement : root;
  }

  // A constructed sheet is CSSOM, which page CSP does not govern.
  function adoptSheet(root) {
    try {
      if (sheet === null) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
      }
      const adopted = root.adoptedStyleSheets;
      if (!adopted.includes(sheet)) root.adoptedStyleSheets = [...adopted, sheet];
      return root.adoptedStyleSheets.includes(sheet);
    } catch {
      // Firefox's Xray wrappers can refuse adoptedStyleSheets; the caller falls back to <style>.
      return false;
    }
  }

  // Page CSP can block a <style> element, and without our rules some pages hide
  // unknown elements, so the fallback is only kept once a probe shows it applies.
  function insertStyle(root) {
    const style = document.createElement('style');
    style.id = 'skb-style';
    style.textContent = css;
    styleParent(root).appendChild(style);
    const probe = document.createElement('skb-b');
    (root === document ? document.documentElement : root).appendChild(probe);
    const applies = getComputedStyle(probe).fontWeight === String(settings.weight);
    probe.remove();
    if (applies) return style;
    style.remove();
    return null;
  }

  function keepStyle(root) {
    const entry = roots.get(root);
    if (entry === undefined) return;
    if (entry.style === null) adoptSheet(root);
    else if (!entry.style.isConnected) styleParent(root).appendChild(entry.style);
  }

  // New rules make the browser restyle every element on the page, even when they
  // are the same (measured 45 ms on a long page turned back on while restoring).
  function restyle() {
    const next = cssText();
    if (next === css) return;
    css = next;
    if (sheet !== null) sheet.replaceSync(css);
    const fallbacks = [...roots.values()].filter((entry) => entry.style !== null);
    if (fallbacks.length === 0) return;
    withWrites(() => {
      for (const entry of fallbacks) entry.style.textContent = css;
    });
  }

  /* ── Roots ─────────────────────────────────────────────────────────────── */

  // Styles, observes and (for shadow roots) queues a root. False when no
  // stylesheet could be applied there, in which case the root is left alone.
  function attachRoot(root) {
    if (roots.has(root)) return true;
    let style = null;
    if (!adoptSheet(root)) {
      style = insertStyle(root);
      if (style === null) return false;
    }
    const observer = new MutationObserver((records) => onRecords(root, records));
    observer.observe(root, OBSERVE);
    roots.set(root, { observer, style });
    // Frame load events stop at their document or shadow root (see onFrameLoad).
    root.addEventListener('load', onFrameLoad, true);
    if (root !== document) {
      enqueue(root);
      if (roots.size > rootSweepAt) sweepRoots();
    }
    return true;
  }

  function detachRoot(root, entry) {
    entry.observer.disconnect();
    root.removeEventListener('load', onFrameLoad, true);
    if (entry.style !== null) {
      entry.style.remove();
      return;
    }
    try {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((item) => item !== sheet);
    } catch {
      // Adoption worked when the root was attached, so this only fails on a torn-down document.
    }
  }

  // Shadow roots whose host left the page are dropped; if the host comes back,
  // the scan of the re-inserted subtree finds and attaches the root again.
  function sweepRoots() {
    for (const [root, entry] of roots) {
      if (root !== document && !root.host.isConnected) {
        detachRoot(root, entry);
        roots.delete(root);
      }
    }
    rootSweepAt = Math.max(64, roots.size * 2);
  }

  /* ── The user's selection ──────────────────────────────────────────────── */

  // Rewriting a text node drops a selection inside it. So each batch of writes
  // notes where the selection's ends are, as character offsets, when they sit
  // in text the engine may rewrite, and puts them back on the same characters.
  let marks = null; // { selection, anchor, focus, moved }; an end is { node, offset, owner, at }

  function noteSelection() {
    marks = null;
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) return;
    const anchor = endOf(selection.anchorNode, selection.anchorOffset);
    const focus = endOf(selection.focusNode, selection.focusOffset);
    if (anchor.owner !== null || focus.owner !== null) marks = { selection, anchor, focus, moved: false };
  }

  // The current wrapper a node (text in a wrapper, a bold part, or the wrapper itself) belongs to.
  function wrapperAround(node) {
    let element = node.nodeType === TEXT_NODE ? node.parentNode : node;
    if (element !== null && element.nodeType === ELEMENT_NODE && element.localName === 'skb-b') element = element.parentNode;
    return element !== null && element.nodeType === ELEMENT_NODE && element.localName === 'skb-w' && isCurrent(element)
      ? element : null;
  }

  function endOf(node, offset) {
    if (node === null) return { node, offset, owner: null, at: 0 };
    const wrapper = wrapperAround(node);
    if (wrapper !== null) {
      const range = document.createRange();
      range.setStart(wrapper, 0);
      range.setEnd(node, offset);
      return { node, offset, owner: wrapper, at: range.toString().length };
    }
    // Plain text the scan may wrap.
    if (node.nodeType === TEXT_NODE && node.data !== '') return { node, offset, owner: node, at: offset };
    return { node, offset, owner: null, at: 0 };
  }

  function pointIn(wrapper, at) {
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (at <= text.data.length) return [text, at];
      at -= text.data.length;
      last = text;
    }
    return last !== null ? [last, last.data.length] : [wrapper, 0];
  }

  // Ends that were in `from` (a text node or a wrapper) move to the same character
  // of `to`, which now holds that text (a wrapper, or a plain text node).
  function remark(from, to) {
    if (marks === null) return;
    for (const end of [marks.anchor, marks.focus]) {
      if (end.owner !== from) continue;
      if (to.nodeType === TEXT_NODE) {
        end.node = to;
        end.offset = Math.min(end.at, to.data.length);
      } else {
        [end.node, end.offset] = pointIn(to, end.at);
      }
      end.owner = to;
      marks.moved = true;
    }
  }

  function restoreSelection() {
    const kept = marks;
    marks = null;
    if (kept === null || !kept.moved) return;
    try {
      kept.selection.setBaseAndExtent(kept.anchor.node, kept.anchor.offset, kept.focus.node, kept.focus.offset);
    } catch {
      // An end left the document meanwhile; the page moved the selection on anyway.
    }
  }

  /* ── Sources and wrappers ──────────────────────────────────────────────── */

  function track(source, wrapper, text) {
    wrapperOf.set(source, wrapper);
    sourceOf.set(wrapper, source);
    textOf.set(source, text);
    if (!listed.has(source)) {
      listed.add(source);
      sources.add(new WeakRef(source));
      if (sources.size > sourceSweepAt) sweepSources();
    }
  }

  function sweepSources() {
    for (const ref of sources) {
      const source = ref.deref();
      if (source === undefined) {
        sources.delete(ref);
      } else if (!wrapperOf.has(source)) {
        sources.delete(ref);
        listed.delete(source);
      }
    }
    sourceSweepAt = Math.max(1024, sources.size * 2);
  }

  function untrack(source) {
    wrapperOf.delete(source);
    textOf.delete(source);
  }

  // Gives the source its text back (unless the page already wrote new text into
  // it) and stops tracking it. The caller removes the wrapper if it is still around.
  function release(source, wrapper) {
    let text = textOf.get(source);
    // Text changed inside the wrapper where no record showed it (typed as a page
    // switched to design mode, or edited in a subtree the page had taken out) is
    // what the page shows, so it wins.
    const shown = wrapper.textContent;
    if (shown !== text) text = shown;
    if (source.data === '' && text !== undefined) source.data = text;
    untrack(source);
    remark(wrapper, source);
  }

  function isCurrent(wrapper) {
    const source = sourceOf.get(wrapper);
    return source !== undefined && wrapperOf.get(source) === wrapper;
  }

  // Replaces one of our elements with its own children.
  function unwrap(element) {
    element.replaceWith(...element.childNodes);
  }

  // A wrapper the page edited inside holds page content (a highlighter's marks), so
  // it is taken apart where it stands instead of replaced by plain text. The text
  // up to the first element goes back into the source, the way it would have
  // stayed in the page's own node had the page split that node itself.
  function unwrapOwned(source, wrapper) {
    // The bold parts split the text into pieces. Merged again, the page gets whole
    // text nodes back, as it had them, so a script that searches one node at a time
    // finds the words, and turning on again finds whole words to bold. A wrapper that
    // holds only its bold parts and text (a text walker changed its words) is merged
    // in one step: piece by piece, a walker over a long page took 1.6 s.
    if (wrapper.querySelector(':not(skb-b)') === null) {
      wrapper.textContent = wrapper.textContent;
    } else {
      for (const bold of wrapper.querySelectorAll('skb-b')) unwrap(bold);
      wrapper.normalize();
    }
    const first = wrapper.firstChild;
    if (first !== null && first.nodeType === TEXT_NODE && source.data === '' && source.nextSibling === wrapper) {
      source.data = first.data;
      first.remove();
    }
    unwrap(wrapper);
    untrack(source);
  }

  // Gives a source its text back and takes its wrapper out of the page.
  function letGo(source, wrapper) {
    if (owned.has(wrapper) && wrapper.parentNode !== null) {
      unwrapOwned(source, wrapper);
      return;
    }
    wrapper.remove();
    release(source, wrapper);
  }

  // Hands back everything wrapped inside a root (an element, document or shadow root).
  function releaseIn(root) {
    for (const wrapper of root.querySelectorAll('skb-w')) {
      const source = sourceOf.get(wrapper);
      if (source !== undefined && wrapperOf.get(source) === wrapper) letGo(source, wrapper);
    }
  }

  // Plain parts go in as strings: append() makes their text nodes without the
  // script wrapper objects createTextNode() would, which spares garbage collection
  // (and the frames it lands in) on long pages.
  function appendParts(wrapper, parts) {
    for (const part of parts) {
      if (part.b) {
        const bold = document.createElement('skb-b');
        bold.textContent = part.t;
        wrapper.appendChild(bold);
      } else {
        wrapper.append(part.t);
      }
    }
  }

  function render(wrapper, text, state) {
    wrapper.textContent = '';
    genOf.set(wrapper, gen);
    if (text !== '') {
      const parts = Skimbold.core.transform(text, settings, state);
      if (parts === null) wrapper.append(text);
      else appendParts(wrapper, parts);
    }
    remark(wrapper, wrapper);
  }

  function wrapText(source, text, parts, info, now) {
    const wrapper = document.createElement('skb-w');
    bornAt.set(wrapper, now);
    if (info.weight !== 0) wrapper.setAttribute('data-skb-weight', String(info.weight));
    if (info.fill) wrapper.setAttribute('data-skb-fill', '');
    appendParts(wrapper, parts);
    genOf.set(wrapper, gen);
    const parent = source.parentNode;
    parent.insertBefore(wrapper, source.nextSibling);
    source.data = '';
    // Chromium keeps stale text-transform: capitalize state in a laid-out text node
    // that is emptied (the next word loses its capital); re-inserting it resets that.
    if (info.capitalize) parent.insertBefore(source, wrapper);
    track(source, wrapper, text);
    remark(source, wrapper);
  }

  // Cheap checks on the text alone; the rest waits for the batch (see flush).
  function wrappable(node) {
    const text = node.data;
    return text !== '' && text.length <= MAX_TEXT && !unstable.has(node) && NOT_BLANK.test(text) && !looksLikeTex(text);
  }

  // True when it did real work, so the scan knows to look at the clock.
  function visitText(node) {
    const wrapper = wrapperOf.get(node);
    if (wrapper === undefined) {
      if (wrappable(node)) {
        batch.push(node);
        batchChars += node.data.length;
      }
      return false;
    }
    if (node.data !== '' || node.nextSibling !== wrapper) {
      // The page wrote to or moved the source while we were not watching (a detached
      // subtree); the reconcile at the end of the slice sorts it out.
      posDirty.add(node);
      return false;
    }
    if (genOf.get(wrapper) === gen || owned.has(wrapper)) return false;
    render(wrapper, textOf.get(node), pass);
    return true;
  }

  /* ── What a text node's styles mean for wrapping it ────────────────────── */

  // The element a text node is laid out and inherits in: its parent, or for a
  // child of a shadow host, the slot it is shown in.
  function boxOf(node) {
    const parent = node.parentNode;
    if (parent === null) return null;
    if (parent.nodeType === FRAGMENT_NODE) return parent.host || null;
    if (parent.nodeType !== ELEMENT_NODE) return null;
    if (parent.shadowRoot) return node.assignedSlot || parent;
    return parent;
  }

  // Light-DOM content shown through a slot inside a zone (a web component's <pre>).
  function slottedIntoZone(node) {
    for (let slot = node.assignedSlot; slot !== null; slot = slot.assignedSlot) {
      if (slot.closest(ZONE) !== null) return true;
    }
    return false;
  }

  function inZone(element) {
    if (element.closest(ZONE) !== null) return true;
    const hidden = element.closest('[aria-hidden="true"]');
    if (hidden !== null && isMirror(hidden)) return true;
    for (let ancestor = element; ancestor !== null; ancestor = ancestor.parentElement) {
      if (ancestor.assignedSlot && slottedIntoZone(ancestor)) return true;
    }
    return false;
  }

  // A page that styles what is typed into a field (GitHub's search and filter bars, its
  // code view) paints the field's text transparent and draws it in an aria-hidden copy
  // under the field. Bolded, the copy would be wider than the field's own text, so the
  // caret and the selection would no longer line up with it: such a copy is a zone.
  function isMirror(element) {
    if (element.getAttribute('aria-hidden') !== 'true') return false;
    const now = performance.now();
    let box = null;
    for (let ancestor = element.parentElement, level = 0; ancestor !== null && level < MIRROR_LEVELS;
      ancestor = ancestor.parentElement, level++) {
      for (const field of clearFieldsIn(ancestor, now)) {
        // Edges count: GitHub's filter bar draws its copy in a box of no height.
        box ||= element.getBoundingClientRect();
        const under = field.getBoundingClientRect();
        if (box.left <= under.right && under.left <= box.right && box.top <= under.bottom && under.top <= box.bottom) return true;
      }
    }
    return false;
  }

  // The inputs and textareas inside an element whose text is transparent.
  function clearFieldsIn(element, now) {
    const known = clearFields.get(element);
    if (known !== undefined && now - known.at < STYLE_TTL_MS) return known.fields;
    const fields = [];
    for (const field of element.querySelectorAll('input, textarea')) {
      const style = getComputedStyle(field);
      if (CLEAR.test(style.color) || CLEAR.test(style.getPropertyValue('-webkit-text-fill-color'))) fields.push(field);
    }
    clearFields.set(element, { at: now, fields });
    return fields;
  }

  function styleOf(element, now) {
    const known = styles.get(element);
    if (known !== undefined && now - known.at < STYLE_TTL_MS) return known;
    const style = getComputedStyle(element);
    let display = style.display;
    // display: contents hands layout to the element's own parent.
    for (let box = element; display === 'contents';) {
      box = box.assignedSlot || box.parentElement || (box.parentNode && box.parentNode.host) || null;
      if (box === null) break;
      display = getComputedStyle(box).display;
    }
    const family = style.fontFamily;
    const comma = family.indexOf(',');
    const weight = Number(style.fontWeight);
    const info = {
      at: now,
      items: ITEM_LAYOUT.test(display),
      icon: ICON_FONT.test(comma === -1 ? family : family.slice(0, comma)),
      weight: weight >= 550 ? Math.min(900, Math.round(weight / 100) * 100) : 0,
      fill: style.getPropertyValue('-webkit-text-fill-color') !== style.color,
      capitalize: style.textTransform === 'capitalize',
    };
    styles.set(element, info);
    return info;
  }

  // A text node with another text node beside it (comments and empty text in between
  // do not count) shares one anonymous flex or grid item with it; a wrapper is an
  // element, so wrapping would split the run into separate items.
  function runsOn(node, step) {
    for (let sibling = node[step]; sibling !== null; sibling = sibling[step]) {
      const type = sibling.nodeType;
      if (type === TEXT_NODE) {
        if (sibling.data !== '' || wrapperOf.has(sibling)) return true;
      } else if (type === ELEMENT_NODE) {
        return sibling.localName === 'skb-w' && isCurrent(sibling);
      } else if (type !== COMMENT_NODE) {
        return false;
      }
    }
    return false;
  }

  function inRun(node) {
    return runsOn(node, 'previousSibling') || runsOn(node, 'nextSibling');
  }

  // Wraps the batched text nodes: first every read (what to bold, and the computed
  // styles of their parents), then every write, so the browser recalculates styles
  // at most once per batch.
  function flush() {
    if (batch.length === 0) return;
    // A node can be found twice (queued itself, and inside a queued parent).
    const nodes = new Set(batch);
    const chars = batchChars;
    batch = [];
    batchChars = 0;
    const now = performance.now();
    const jobs = [];
    for (const node of nodes) {
      if (wrapperOf.has(node) || !node.isConnected || !wrappable(node)) continue;
      const parent = node.parentNode;
      if (parent.nodeType === ELEMENT_NODE && parent.shadowRoot && slottedIntoZone(node)) continue;
      const box = boxOf(node);
      if (box === null) continue;
      const text = node.data;
      const info = styleOf(box, now);
      if (info.items && inRun(node)) continue;
      if (info.icon && ICON_WORD.test(text.trim())) continue;
      const parts = Skimbold.core.transform(text, settings, pass);
      if (parts !== null) jobs.push(node, text, parts, info);
    }
    for (let i = 0; i < jobs.length; i += 4) wrapText(jobs[i], jobs[i + 1], jobs[i + 2], jobs[i + 3], now);
    if (chars > 256) msPerChar = msPerChar * 0.7 + ((performance.now() - now) / chars) * 0.3;
  }

  // True once the batch would take the slice past its deadline (or holds BATCH nodes).
  function batchFull(deadline) {
    return batch.length >= BATCH || (batch.length > 0 && performance.now() + batchChars * msPerChar >= deadline);
  }

  /* ── Scanning ──────────────────────────────────────────────────────────── */

  function enqueue(node) {
    if (queued.has(node)) return;
    queued.add(node);
    queue.push(node);
  }

  function nextQueued() {
    if (head === queue.length) {
      queue = [];
      head = 0;
      return null;
    }
    const node = queue[head];
    queue[head] = null;
    head++;
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    queued.delete(node);
    return node;
  }

  function hasWork() {
    return walk !== null || head < queue.length || batch.length > 0 || walked.size > 0;
  }

  function acceptNode(node) {
    if (node.nodeType === TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
    const name = node.localName;
    if (SKIP_TAGS.has(name)) {
      if (name === 'skb-w' && !isCurrent(node)) strays.add(node);
      return NodeFilter.FILTER_REJECT;
    }
    if (node.hasAttributes() && (node.matches(SKIP_ATTRS) || isMirror(node))) return NodeFilter.FILTER_REJECT;
    const parent = node.parentNode;
    if (parent !== null && parent.shadowRoot && slottedIntoZone(node)) return NodeFilter.FILTER_REJECT;
    // Accepted so the scan can attach the open shadow root; its children are still walked.
    if (node.shadowRoot) return NodeFilter.FILTER_ACCEPT;
    // A custom element may get its shadow root once the page defines it (see sweepHosts).
    if (name.includes('-')) hostless.add(node);
    return NodeFilter.FILTER_SKIP;
  }

  function startWalk(node) {
    if (!node.isConnected) return null;
    const type = node.nodeType;
    if (type === TEXT_NODE) {
      const parent = node.parentElement;
      if (parent === null || !inZone(parent)) visitText(node);
      return null;
    }
    if (type === ELEMENT_NODE) {
      if (inZone(node)) {
        // Wrapped text moved into an editor or code block is handed back there.
        releaseIn(node);
        return null;
      }
      if (node.shadowRoot) attachRoot(node.shadowRoot);
      // The walker never shows acceptNode its root, so an added custom element is noted here.
      else if (node.localName.includes('-')) hostless.add(node);
    } else if (type !== FRAGMENT_NODE || inZone(node.host)) {
      // A connected fragment is always a shadow root.
      return null;
    }
    return { root: node, walker: document.createTreeWalker(node, SHOW, acceptNode) };
  }

  // Walks queued roots until the deadline. True when work remains.
  function scan(deadline) {
    let steps = 0;
    for (;;) {
      if (walk === null) {
        const node = nextQueued();
        if (node === null) {
          flush();
          return false;
        }
        walk = startWalk(node);
        if (batchFull(deadline)) {
          flush();
          return true;
        }
        // Queued text nodes are handled inside startWalk, so check the clock here too.
        if (walk === null && performance.now() >= deadline) {
          flush();
          return hasWork();
        }
        continue;
      }
      const { root, walker } = walk;
      if (!root.isConnected) {
        walk = null;
        continue;
      }
      // The page may have removed the node we paused on; walking on from a detached
      // node would end early, so start the root again (done parts are skipped cheaply).
      if (!root.contains(walker.currentNode)) walker.currentNode = root;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        let worked = false;
        if (node.nodeType === TEXT_NODE) worked = visitText(node);
        else attachRoot(node.shadowRoot);
        // One batch per slice: its style reads then come before any write of the slice,
        // while the styles the last frame computed are still current.
        if (batch.length > 0 && batchFull(deadline)) {
          flush();
          return true;
        }
        if ((worked || (++steps & 63) === 0) && performance.now() >= deadline) {
          flush();
          return true;
        }
      }
      walk = null;
    }
  }

  /* ── Mutations ─────────────────────────────────────────────────────────── */

  function isOurs(node) {
    return node !== null && node.nodeType === ELEMENT_NODE && node.closest('skb-w') !== null;
  }

  // The page changed something inside one of our wrappers (a highlighter wrapping a
  // word in <mark>): from now on the wrapper holds page content.
  function noteOwned(element) {
    const wrapper = element.closest('skb-w');
    if (wrapper !== null && isCurrent(wrapper)) {
      owned.add(wrapper);
      edited.add(wrapper);
    }
  }

  // An element whose open shadow root the page attached after the scan passed it.
  function noteHost(node) {
    if (node !== null && node.nodeType === ELEMENT_NODE && node.shadowRoot && !roots.has(node.shadowRoot)) hostsDirty.add(node);
  }

  // True when only blank text and comments lie from `node` onwards in that direction.
  function atEdge(node, step) {
    for (let sibling = node; sibling !== null; sibling = sibling[step]) {
      const type = sibling.nodeType;
      if (type === ELEMENT_NODE || (type === TEXT_NODE && NOT_BLANK.test(sibling.data))) return false;
    }
    return true;
  }

  // Notes a node the page added or removed if it is one of ours. True if it was.
  function noteOurs(node) {
    if (wrapperOf.has(node)) {
      posDirty.add(node);
      return true;
    }
    if (node.nodeType === ELEMENT_NODE && node.localName === 'skb-w') {
      const source = sourceOf.get(node);
      if (source !== undefined && wrapperOf.get(source) === node) posDirty.add(source);
      else strays.add(node);
      return true;
    }
    return false;
  }

  // Whether new content in a container whose wrapped text the page just replaced
  // waits until the container goes quiet (see HOT_MS) instead of being wrapped now.
  // `struck`: what it threw away was a wrapper made less than STRIKE_MS ago.
  function heat(container, now, struck) {
    let state = heats.get(container);
    const fresh = state === undefined;
    if (fresh) {
      state = { at: now, strikes: 0, struckAt: 0, retryMs: RETRY_MS };
      heats.set(container, state);
    }
    if (now - state.struckAt > STRIKE_DECAY_MS && state.strikes < STRIKES) {
      state.strikes = 0;
      state.retryMs = RETRY_MS;
    }
    if (state.strikes >= STRIKES && now - state.at > state.retryMs) retry(state);
    if (struck) {
      state.strikes++;
      state.struckAt = now;
    }
    const recent = !fresh && now - state.at < HOT_MS;
    state.at = now;
    return recent || state.strikes >= STRIKES;
  }

  // One more try for a container that fought the engine and has been quiet long
  // enough: one more strike and it waits again, twice as long as before.
  function retry(state) {
    state.strikes = STRIKES - 1;
    state.retryMs = Math.min(state.retryMs * 2, MAX_RETRY_MS);
  }

  function defer(node, container, now) {
    if (!deferred.has(node)) deferred.set(node, { container, at: now });
    wakeDeferred(now + QUIET_MS);
  }

  function wakeDeferred(due) {
    if (deferTimer !== 0) {
      if (deferDue <= due) return;
      clearTimeout(deferTimer);
    }
    deferDue = due;
    deferTimer = setTimeout(flushDeferred, Math.max(16, due - performance.now()));
  }

  function flushDeferred() {
    deferTimer = 0;
    if (!active) {
      deferred.clear();
      return;
    }
    const now = performance.now();
    let due = Infinity;
    for (const [node, { container, at }] of deferred) {
      if (!node.isConnected) {
        deferred.delete(node);
        continue;
      }
      const state = heats.get(container);
      const fought = state !== undefined && state.strikes >= STRIKES;
      // A container that never goes quiet (a busy live feed) still gets its content
      // bolded, MAX_DEFER_MS after it arrived; one that fought the engine waits longer.
      let until = 0;
      if (fought) until = state.at + state.retryMs;
      else if (state !== undefined) until = Math.min(state.at + QUIET_MS, at + MAX_DEFER_MS);
      if (now < until) {
        due = Math.min(due, until);
        continue;
      }
      if (fought) retry(state);
      deferred.delete(node);
      enqueue(node);
    }
    if (due !== Infinity) wakeDeferred(due);
    schedule();
  }

  // A script that walks text nodes in tree order writes each emptied source just
  // before the text in its wrapper, which a framework never writes to.
  function walksInto(record, wrapper) {
    return record !== undefined && record.type === 'characterData' && wrapper.contains(record.target);
  }

  // YouTube's DOM layer skips empty text nodes and elements of other scopes (ours)
  // when it reads a yt-formatted-string's children, so one that holds only an
  // emptied source and its wrapper looks empty to it: it appends new text after them
  // instead of replacing the old ("Comments2,457,730 Comments"). Nodes appended
  // right after such a wrapper stand for the page's clear of that source.
  function supersede(wrapper) {
    if (wrapper === null || wrapper.nodeType !== ELEMENT_NODE || wrapper.localName !== 'skb-w' || !isCurrent(wrapper)) return;
    const source = sourceOf.get(wrapper);
    if (source.nextSibling === wrapper && atEdge(source.previousSibling, 'previousSibling')) textDirty.add(source);
  }

  // Whether `node` is, or is inside, an element a script took apart or took another
  // element apart into.
  function inApart(node) {
    for (let element = node; element !== null; element = element.parentNode) {
      if (apart.has(element)) return true;
    }
    return false;
  }

  // Sorts records into work; never writes to the DOM.
  function collect(records) {
    const now = performance.now();
    let lost = null; // containers whose wrapped text the page replaced in this batch
    let struck = null; // containers that threw away a wrapper we had only just made
    let removed = null; // nodes removed in this batch, to tell moves from new content
    let emptied = null; // elements the page took children out of in this batch
    let added = null; // [node, container, node, container, …]
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const target = record.target;
      if (record.type === 'characterData') {
        if (wrapperOf.has(target)) {
          // Our own writes to a source always empty a non-empty node, so a record
          // whose old value is empty can only be the page writing to it: new text,
          // a clear, or a text walker going through every node (see fixWalked).
          if (record.oldValue === '') {
            if (walksInto(records[i + 1], wrapperOf.get(target))) walked.add(target);
            else textDirty.add(target);
          }
        } else if (isOurs(target.parentNode)) {
          // A script wrote to the text inside a wrapper. Writing back the same text (a
          // walker that rewrites every text node) changes nothing; anything else makes
          // the wrapper the page's.
          if (record.oldValue !== target.data) noteOwned(target.parentNode);
        } else {
          const parent = target.parentNode;
          noteHost(parent);
          (added ||= []).push(target, parent);
          // Text rewritten in place in a container that was re-rendering waits like new
          // content there: React sets the text of an element whose only child is text in
          // place, and replaces it whole once our wrapper is beside it, on every update.
          if (heats.has(parent)) (lost ||= new Set()).add(parent);
        }
      } else if (isOurs(target)) {
        if (record.type === 'childList') noteOwned(target);
      } else {
        noteHost(target);
        if (record.type === 'attributes') {
          zoneDirty.add(target);
          continue;
        }
        let lostHere = false;
        if (record.removedNodes.length > 0) (emptied ||= new Set()).add(target);
        else if (target.localName === 'yt-formatted-string') supersede(record.previousSibling);
        for (const node of record.removedNodes) {
          (removed ||= new Set()).add(node);
          const ours = noteOurs(node);
          // A node that is back in the page was moved (a keyed list reordered), not replaced.
          if (node.isConnected) continue;
          if (record.addedNodes.length > 0) {
            // An element the page emptied and then replaced, with its own children as a
            // highlighter clearing its marks does before it normalize()s (see fixSource).
            if (emptied.has(node)) apart.add(target).add(node);
          } else if (apart.size > 0 && wrapperOf.has(node)) {
            // normalize() only removes. Whether it ran where a mark was taken apart is
            // known once the whole batch is: it can reach into a later mark first.
            places.set(node, record);
          }
          let wrapper = ours ? wrapperOf.get(node) || node : null;
          if (!ours && node.nodeType === ELEMENT_NODE) {
            wrapper = node.getElementsByTagName('skb-w').item(0);
            if (wrapper !== null) detached.push(node);
          }
          // Content held back for a quiet moment and replaced before it came is still streaming.
          if (wrapper === null && !deferred.delete(node)) continue;
          lostHere = true;
          if (wrapper !== null && now - (bornAt.get(wrapper) ?? -Infinity) < STRIKE_MS) (struck ||= new Set()).add(target);
        }
        // Content replaced in one go, or taken out of the middle, is being re-rendered.
        // Entries taken off one end are not: that is a chat or a log keeping its last
        // N entries, and what it appends at the other end is wrapped straight away.
        if (lostHere && (record.addedNodes.length > 0
            || !(atEdge(record.previousSibling, 'previousSibling') || atEdge(record.nextSibling, 'nextSibling')))) {
          (lost ||= new Set()).add(target);
        }
        for (const node of record.addedNodes) {
          if (!noteOurs(node)) (added ||= []).push(node, target);
        }
        // Vue computes insertion anchors with nextSibling, which is our wrapper.
        const before = record.previousSibling;
        if (before !== null && wrapperOf.has(before)) posDirty.add(before);
      }
    }
    if (added === null) return;
    let verdicts = null;
    for (let i = 0; i < added.length; i += 2) {
      const node = added[i];
      const container = added[i + 1];
      if (lost === null || !lost.has(container) || (removed !== null && removed.has(node))) {
        enqueue(node);
        continue;
      }
      verdicts ||= new Map();
      let waits = verdicts.get(container);
      if (waits === undefined) {
        waits = heat(container, now, struck !== null && struck.has(container));
        verdicts.set(container, waits);
      }
      if (!waits) {
        enqueue(node);
        continue;
      }
      defer(node, container, now);
      // Copies of our markup in content that waits are settled at once all the same,
      // so none is left behind unstyled.
      if (node.nodeType === ELEMENT_NODE) for (const copy of node.getElementsByTagName('skb-w')) strays.add(copy);
    }
  }

  function churning(source) {
    const now = performance.now();
    const seen = churn.get(source);
    if (seen === undefined || now - seen.since > CHURN_MS) {
      churn.set(source, { since: now, count: 1 });
      return false;
    }
    if (++seen.count <= CHURN_LIMIT) return false;
    unstable.add(source);
    return true;
  }

  // Where the words of a source that normalize() removed belong: where its wrapper
  // still is, or else (jQuery's plugin moved the source out of the mark without it)
  // right after the node before the source. normalize() works in tree order and
  // keeps that node, so it is only gone when the page removed it some other way.
  function placeOf(record, wrapper) {
    if (wrapper.isConnected) return [wrapper.parentNode, wrapper];
    const { target, previousSibling: prev } = record;
    if (!target.isConnected) return null;
    if (prev === null) return [target, target.firstChild];
    return prev.parentNode === target ? [target, prev.nextSibling] : null;
  }

  function fixSource(source, textChanged, state, deadline) {
    const wrapper = wrapperOf.get(source);
    if (wrapper === undefined) return;
    // A highlighter clearing its marks puts each mark's children (or, jQuery's plugin,
    // just the first: the source) in its place and then normalize()s that element,
    // which removes the emptied sources in it: those keep their words where the source
    // was. A framework that removes a text node (React's removeChild) never takes an
    // element apart, and a source removed anywhere else takes its words along.
    const record = places.get(source);
    const place = record !== undefined && !textChanged && !source.isConnected && inApart(record.target)
      ? placeOf(record, wrapper) : null;
    if (place !== null) {
      const [parent, before] = place;
      const text = textOf.get(source);
      untrack(source);
      const fresh = document.createTextNode('');
      parent.insertBefore(fresh, before);
      if (wrapper !== before) parent.insertBefore(wrapper, before);
      track(fresh, wrapper, text);
      return;
    }
    // A range operation (extractContents, deleteContents) that cut through the wrapper and
    // took the emptied source along moved or removed only the part it selected: the rest
    // of the wrapper stays where it is, as the page's own text.
    if (edited.has(wrapper) && wrapper.isConnected && source.nextSibling !== wrapper) {
      unwrapOwned(source, wrapper);
      return;
    }
    if (!source.isConnected || wrapper.parentNode === null) {
      // The page removed the text node (or moved it off the page), or removed our
      // wrapper and kept the text node.
      wrapper.remove();
      if (!textChanged) {
        // The node gets its text back, for whenever the page shows it again.
        release(source, wrapper);
      } else {
        // The page wrote the node's text too: what it holds is the page's own now.
        untrack(source);
        if (source.isConnected && source.data !== '') enqueue(source);
      }
      return;
    }
    const parent = source.parentNode;
    const text = source.data;
    if (textChanged && text === '') {
      // The page cleared the text: let go, so the element is really empty (:empty).
      wrapper.remove();
      untrack(source);
      return;
    }
    if (text !== '') {
      // The page's new text replaces a wrapper it had edited inside, too.
      if (owned.has(wrapper) || text.length > MAX_TEXT || looksLikeTex(text) || churning(source)
          || performance.now() >= deadline) {
        // The source already shows the page's new text; the scan re-wraps it later if it can.
        wrapper.remove();
        untrack(source);
        enqueue(source);
        return;
      }
      textOf.set(source, text);
      source.data = '';
      render(wrapper, text, state);
      const box = boxOf(source);
      const info = box !== null ? styles.get(box) : undefined;
      if (info !== undefined && info.capitalize && source.nextSibling === wrapper) parent.insertBefore(source, wrapper);
    } else if (genOf.get(wrapper) !== gen && !owned.has(wrapper)) {
      render(wrapper, textOf.get(source), state);
    }
    if (source.nextSibling !== wrapper) {
      if (parent.nodeType === ELEMENT_NODE && inZone(parent)) {
        wrapper.remove();
        release(source, wrapper);
        return;
      }
      // Moved, or the page inserted something right after it: the wrapper follows.
      parent.insertBefore(wrapper, source.nextSibling);
    }
  }

  // A shadow root attached after the scan (a component defined later) can show light DOM
  // that is already wrapped through a slot inside a zone (a code block): it is handed back.
  function attachLate(host) {
    attachRoot(host.shadowRoot);
    for (const child of [...host.children]) {
      if (!slottedIntoZone(child)) continue;
      const source = sourceOf.get(child);
      if (source !== undefined && wrapperOf.get(source) === child) letGo(source, child);
      else releaseIn(child);
    }
  }

  function fixZone(element) {
    if (!element.isConnected) return;
    if (!inZone(element)) {
      enqueue(element);
      return;
    }
    releaseIn(element);
  }

  function settleStray(wrapper) {
    const parent = wrapper.parentNode;
    if (parent === null || isCurrent(wrapper)) return;
    // Markup pasted into an editor or code block belongs to that zone; leave it be.
    if (parent.nodeType === ELEMENT_NODE && parent.closest(ZONE) !== null) return;
    const source = sourceOf.get(wrapper);
    if (source !== undefined && source.isConnected) {
      // A wrapper we let go of, put back by the page: its source shows the text already.
      wrapper.remove();
      return;
    }
    // A copy of our markup made by the page (cloned, or re-parsed from serialized
    // markup). Adopting it means disable() turns the copy back into plain text
    // like the original.
    let copy = wrapper.previousSibling;
    if (copy === null || copy.nodeType !== TEXT_NODE || copy.data !== '' || wrapperOf.has(copy)) {
      copy = document.createTextNode('');
      parent.insertBefore(copy, wrapper);
    }
    const text = wrapper.textContent;
    track(copy, wrapper, text);
    // A copy of a wrapper the page had edited inside keeps what the page put there.
    if (wrapper.querySelector(':not(skb-b)') !== null) owned.add(wrapper);
    else render(wrapper, text, { count: 0 });
  }

  // A script that walks the text nodes and writes each one (a word replacer, a
  // transliteration) wrote to this emptied source and then to the text in its
  // wrapper. Written back empty (or turned into '' by the walk), the source keeps
  // its wrapper, with whatever the walker made of the text there: this is not the
  // page clearing its text. Given text (the walker appended to every node), the
  // source and the wrapper both hold what the page made: they stay as they are, the
  // wrapper taken apart where it stands, and the scan bolds the result afresh.
  function fixWalked(source, state, deadline) {
    const wrapper = wrapperOf.get(source);
    if (wrapper === undefined) return;
    if (source.data === '' || !source.isConnected || wrapper.parentNode === null) {
      fixSource(source, false, state, deadline);
      return;
    }
    const parent = wrapper.parentNode;
    unwrapOwned(source, wrapper);
    enqueue(parent);
  }

  function reconcile(deadline) {
    if (textDirty.size > 0 || posDirty.size > 0 || walked.size > 0) {
      const state = { count: 0 };
      for (const source of textDirty) fixSource(source, true, state, deadline);
      // A walker over a long page leaves thousands of these; what the deadline leaves
      // waits for the next slice.
      for (const source of walked) {
        if (performance.now() >= deadline) break;
        walked.delete(source);
        if (!textDirty.has(source)) fixWalked(source, state, deadline);
      }
      for (const source of posDirty) {
        if (!textDirty.has(source) && !walked.has(source)) fixSource(source, false, state, deadline);
      }
      textDirty.clear();
      posDirty.clear();
    }
    apart.clear();
    places.clear();
    edited.clear();
    for (const element of zoneDirty) fixZone(element);
    zoneDirty.clear();
    for (const host of hostsDirty) {
      if (active && host.isConnected && host.shadowRoot && !inZone(host)) attachLate(host);
    }
    hostsDirty.clear();
    for (const wrapper of strays) settleStray(wrapper);
    strays.clear();
  }

  // Wrapped text in subtrees the page took off the page gets its text back, so an
  // edit the page makes there while it is detached (a recycled list row) shows when
  // the subtree comes back. What the deadline leaves waits for the next slice.
  function releaseDetached(deadline) {
    while (detached.length > 0) {
      const node = detached.pop();
      if (!node.isConnected) releaseIn(node);
      if (performance.now() >= deadline) break;
    }
  }

  // Self-mutation hygiene: page records still pending are taken (and handled by
  // the caller) before our writes, and the records our writes caused are
  // discarded after them, so the observers never react to their own changes.
  function openWrite() {
    if (writeDepth++ === 0) noteSelection();
    for (const entry of roots.values()) {
      const records = entry.observer.takeRecords();
      if (records.length > 0) collect(records);
    }
  }

  function closeWrite() {
    for (const entry of roots.values()) entry.observer.takeRecords();
    if (--writeDepth === 0) restoreSelection();
  }

  function withWrites(write) {
    openWrite();
    try {
      reconcile(Infinity);
      write();
    } finally {
      closeWrite();
    }
  }

  function onRecords(root, records) {
    if (!active) return;
    try {
      if (document.designMode === 'on') {
        stopForEditing();
        return;
      }
      collect(records);
      openWrite();
      try {
        keepStyle(root);
        const deadline = performance.now() + RECONCILE_MS;
        reconcile(deadline);
        releaseDetached(deadline);
      } finally {
        closeWrite();
      }
      schedule();
      wakeHostSweep();
    } catch (error) {
      warn(error);
    }
  }

  /* ── Work loop ─────────────────────────────────────────────────────────── */

  // One slice of at most budgetMs. True when work remains.
  function runSlice(budgetMs) {
    const deadline = performance.now() + budgetMs;
    openWrite();
    try {
      reconcile(deadline);
      const more = scan(deadline);
      releaseDetached(deadline);
      reconcile(deadline);
      return more || detached.length > 0 || walked.size > 0;
    } finally {
      closeWrite();
    }
  }

  // While the page is visible, the next slice waits until the browser has rendered
  // the last one, and resolves to how long that rendering took (null if unknown).
  // scheduler.yield() continuations outrank rendering, so slices would pile up
  // between frames and the frame that finally renders them all becomes a long task
  // itself (measured: 160-300 ms on a 250,000-word page). Hidden documents render
  // nothing, so there scheduler.yield() is used, or a timer where it is missing.
  function yieldToMain() {
    if (document.visibilityState === 'visible') {
      return new Promise((resolve) => {
        let resolved = false;
        const next = (renderMs) => {
          if (resolved) return;
          resolved = true;
          resolve(renderMs);
        };
        requestAnimationFrame(() => {
          const frameStart = performance.now();
          setTimeout(() => next(performance.now() - frameStart), 0);
        });
        // Frames that are hidden by the page (display:none iframes) get no animation frames.
        setTimeout(() => next(null), FRAME_FALLBACK_MS);
      });
    }
    const scheduler = globalThis.scheduler;
    const turn = scheduler && typeof scheduler.yield === 'function'
      ? scheduler.yield()
      : new Promise((resolve) => setTimeout(resolve, 0));
    return turn.then(() => null);
  }

  // Style and layout of the elements a slice creates cost the next frame several
  // times the slice itself on dense text (measured 5-8x), and that cost grows with
  // the slice. So each slice is sized for its frame to render in about
  // RENDER_TARGET_MS, growing by at most half per step so one cheap frame cannot
  // cause an overshoot.
  function nextBudget(budgetMs, renderMs) {
    if (renderMs === null) return budgetMs;
    const aimed = budgetMs * RENDER_TARGET_MS / Math.max(renderMs, 1);
    return Math.min(SLICE_MS, budgetMs * 1.5, Math.max(MIN_SLICE_MS, aimed));
  }

  // Runs the first slice synchronously, then keeps slicing until the queue is empty.
  function startLoop(firstBudgetMs) {
    if (!active || !loaded || starting !== null || loopToken !== null) return;
    const token = {};
    loopToken = token;
    (async () => {
      let budgetMs = firstBudgetMs;
      try {
        while (loopToken === token && runSlice(budgetMs)) budgetMs = nextBudget(budgetMs, await yieldToMain());
      } catch (error) {
        warn(error);
      } finally {
        if (loopToken === token) {
          loopToken = null;
          pass = { count: 0 };
          schedule();
          wakeHostSweep();
        }
      }
    })();
  }

  // Coalesces work from page mutations into one pass per animation frame
  // (before paint, so new text never shows unbolded first). Its first slice is
  // short too: it shares its frame with the page's own update (measured on a page
  // with :has() rules, an 8 ms first slice made that frame 10 ms longer, with the
  // same style work in total).
  function schedule() {
    if (!active || !loaded || starting !== null || loopToken !== null || frameToken !== null) return;
    if (!hasWork() && detached.length === 0) return;
    const token = {};
    frameToken = token;
    const run = () => {
      if (frameToken !== token) return;
      frameToken = null;
      startLoop(FIRST_SLICE_MS);
    };
    requestAnimationFrame(run);
    // Hidden tabs get no animation frames.
    setTimeout(run, FRAME_FALLBACK_MS);
  }

  function whenIdle(callback) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: IDLE_WAIT_MS });
    else setTimeout(() => callback(null), 0);
  }

  /* ── Late shadow roots ─────────────────────────────────────────────────── */

  // A shadow root the page attaches after the scan passed its host is found when
  // the page next changes that host or its light DOM (see noteHost). A custom
  // element that is defined later attaches its root as it upgrades, which changes
  // nothing the observers see, so the custom elements the scan found without a root
  // are looked at again in idle time every HOST_SWEEP_MS while the page changes.
  let hostSweep = null; // token of the sweep in progress or planned

  function wakeHostSweep() {
    hostSweepQuiet = 0;
    planHostSweep();
  }

  function planHostSweep() {
    if (hostSweep !== null || !active || hostless.size === 0 || hostSweepQuiet >= HOST_SWEEP_QUIET) return;
    const token = {};
    hostSweep = token;
    hostSweepTimer = setTimeout(() => sweepHosts(token), HOST_SWEEP_MS);
  }

  function sweepHosts(token) {
    const pending = [...hostless];
    let next = 0;
    let found = false;
    const step = (idle) => {
      if (hostSweep !== token) return;
      const deadline = performance.now() + (idle ? Math.min(idle.timeRemaining(), SLICE_MS) : SLICE_MS);
      const hosts = [];
      for (; next < pending.length && ((next & 31) !== 0 || performance.now() < deadline); next++) {
        const element = pending[next];
        if (!element.isConnected) {
          hostless.delete(element);
        } else if (element.shadowRoot) {
          hostless.delete(element);
          if (!roots.has(element.shadowRoot) && !inZone(element)) hosts.push(element);
        }
      }
      if (hosts.length > 0) {
        found = true;
        try {
          withWrites(() => {
            for (const host of hosts) attachLate(host);
          });
          schedule();
        } catch (error) {
          warn(error);
        }
      }
      if (next < pending.length) {
        whenIdle(step);
        return;
      }
      // Until the page changes again, a few looks that find nothing are enough.
      hostSweep = null;
      hostSweepQuiet = found ? 0 : hostSweepQuiet + 1;
      planHostSweep();
    };
    whenIdle(step);
  }

  function stopHostSweep() {
    clearTimeout(hostSweepTimer);
    hostSweep = null;
    hostSweepQuiet = 0;
    hostless.clear();
  }

  /* ── Copy and drag ─────────────────────────────────────────────────────── */

  // Browsers copy a selection as HTML with each element's computed style inlined,
  // which for our wrappers is the whole `all: unset` expansion plus the bold. So
  // when a copy or drag takes text we wrapped, the HTML is rebuilt from a clone of
  // the selection with our elements taken out (their contents kept).
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'del', 'dfn', 'em', 'i', 'ins', 'mark', 'q', 's', 'small',
    'span', 'strong', 'sub', 'sup', 'time', 'u',
  ]);

  // A selection that runs from one tree into another (into an open shadow root) has no
  // range within one tree, and Selection.toString() leaves out the other tree's text, so
  // it is left to the browser (README: Known limitations).
  function selectedRange() {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const shadowRoots = [...roots.keys()].filter((root) => root !== document);
    if (shadowRoots.length > 0 && typeof selection.getComposedRanges === 'function') {
      // Otherwise a selection inside an open shadow root is reported at its host.
      let composed = null;
      try {
        [composed] = selection.getComposedRanges({ shadowRoots });
      } catch {
        try {
          [composed] = selection.getComposedRanges(...shadowRoots);
        } catch {
          composed = null;
        }
      }
      if (composed && !composed.collapsed && composed.startContainer.getRootNode() === composed.endContainer.getRootNode()) {
        const range = document.createRange();
        range.setStart(composed.startContainer, composed.startOffset);
        range.setEnd(composed.endContainer, composed.endOffset);
        return range;
      }
    }
    return selection.getRangeAt(0);
  }

  // The selection as HTML without our elements, or null when it holds none of them.
  function cleanHtml(range) {
    let context = range.commonAncestorContainer;
    if (context.nodeType !== ELEMENT_NODE) context = context.parentNode;
    let inside = false;
    while (context !== null && context.nodeType === ELEMENT_NODE && (context.localName === 'skb-w' || context.localName === 'skb-b')) {
      inside = true;
      context = context.parentNode;
    }
    const fragment = range.cloneContents();
    if (!inside && fragment.querySelector('skb-w, skb-b') === null) return null;
    for (const element of fragment.querySelectorAll('skb-w, skb-b')) unwrap(element);
    fragment.normalize();
    // Keep the inline elements the selection sits in (a link, a bold phrase).
    let content = fragment;
    for (let element = context; element !== null && element.nodeType === ELEMENT_NODE && INLINE_TAGS.has(element.localName);
      element = element.parentNode) {
      const shell = element.cloneNode(false);
      shell.append(content);
      content = shell;
    }
    const holder = document.createElement('div');
    holder.append(content);
    // Pasted elsewhere, relative links would point nowhere.
    for (const link of holder.querySelectorAll('a[href]')) link.setAttribute('href', link.href);
    for (const image of holder.querySelectorAll('img[src]')) image.setAttribute('src', image.src);
    return holder.innerHTML;
  }

  function onCopy(event) {
    if (event.defaultPrevented || (!active && restoring === null)) return;
    const drag = event.type === 'dragstart';
    const data = drag ? event.dataTransfer : event.clipboardData;
    if (!data) return;
    // A drag of a link or an image carries its address (text/uri-list), even when the
    // link or image is part of the selection. Any other drag that starts on the
    // selection carries it: pressed on a link inside it, on a bold part, or on the
    // element around the text (Chromium starts it on the element under the pointer).
    // Its text/plain is no guide: Chromium writes it with CRLF and image alt text.
    const origin = drag ? event.composedPath()[0] : null;
    try {
      if (drag && [...data.types].includes('text/uri-list')) return;
      const range = selectedRange();
      const html = range !== null && (!drag || (origin && range.intersectsNode(origin))) ? cleanHtml(range) : null;
      if (html === null) return;
      data.setData('text/html', html);
      data.setData('text/plain', String(document.getSelection()));
      if (!drag) event.preventDefault();
    } catch (error) {
      warn(error);
    }
  }

  /* ── Editing and frames ────────────────────────────────────────────────── */

  // A page switched to design mode gives no mutation record, so the first edit
  // would land in a wrapper: everything is handed back before it does.
  function stopForEditing() {
    disable();
    finishRestore();
  }

  function onBeforeInput(event) {
    if (!active) return;
    if (document.designMode === 'on') {
      stopForEditing();
      return;
    }
    // Text that became editable in a way the observer cannot see (a style rule).
    // Ordinary editors are zones, which never hold wrappers.
    const target = event.composedPath()[0];
    if (target && target.nodeType === ELEMENT_NODE && target.closest(ZONE) === null && target.querySelector('skb-w') !== null) {
      try {
        withWrites(() => releaseIn(target));
      } catch (error) {
        warn(error);
      }
    }
  }

  // A frame that loads after the toggle (added later, lazy, or navigated) has no
  // engine; the background injects one into it and brings it to this page's state.
  // It is told which frames loaded when that is known, so it need not look into
  // every frame of the tab: from runtime.getFrameId (Firefox), or from the id a
  // same-origin frame noted on its element when it was synced (see noteFrameId).
  // Otherwise it is told whether a frame this page had not seen before loaded; a
  // frame that reloads announced itself as it left its last page (see onPageHide).
  const FRAME_ID = 'skimboldFrameId';
  const seenFrames = new WeakSet();
  let framesRequest = null; // { ids, fresh } to send
  let framesTimer = 0;

  function onFrameLoad(event) {
    const frame = event.target;
    if (!frame || frame.nodeType !== ELEMENT_NODE || (frame.localName !== 'iframe' && frame.localName !== 'frame')) return;
    requestFrames([frame]);
  }

  // Content scripts of same-origin frames share one isolated world, so a property set
  // on the frame's element here is seen by the page that holds the frame, and never
  // by the page's own scripts. The id stays the frame's own when it loads a new page.
  function noteFrameId(frameId) {
    try {
      const frame = window.frameElement;
      if (frame !== null) frame[FRAME_ID] = frameId;
    } catch {
      // A cross-origin parent cannot be reached; it asks for its frames without ids.
    }
  }

  function frameIdOf(frame) {
    try {
      if (api && api.runtime && typeof api.runtime.getFrameId === 'function') return api.runtime.getFrameId(frame);
      return Number.isInteger(frame[FRAME_ID]) ? frame[FRAME_ID] : -1;
    } catch {
      return -1;
    }
  }

  function requestFrames(frames) {
    if (!active) return;
    const request = framesRequest ||= { ids: new Set(), fresh: false };
    for (const frame of frames) {
      const id = frameIdOf(frame);
      if (id > 0) request.ids.add(id);
      else if (!seenFrames.has(frame)) request.fresh = true;
      seenFrames.add(frame);
    }
    if (framesTimer !== 0) return;
    framesTimer = setTimeout(() => {
      framesTimer = 0;
      const { ids, fresh } = framesRequest;
      framesRequest = null;
      if (active) send({ type: 'skb:frames', frameIds: [...ids], fresh });
    }, FRAMES_DELAY_MS);
  }

  // A frame whose engine is on tells the background as its page goes away, so the
  // page the frame loads next gets the engine without a look into every frame.
  function onPageHide() {
    if (active && !isTop) send({ type: 'skb:frames', leaving: true });
  }

  /* ── Restoring ─────────────────────────────────────────────────────────── */

  // Sources still to hand back after disable(), and the roots whose stylesheets
  // stay until the last wrapper is gone (unstyled, some pages would hide them).
  let restoring = null; // { refs, next, roots }

  // Restores sources until the deadline, last first. True when all are done.
  // A restored paragraph changes height, so the browser re-lays out everything
  // after it: cheap for plain text, costly for text that is still wrapped
  // (measured 17 ms against 110 ms per frame on a 5,000-paragraph page).
  function restoreSome(job, deadline) {
    const { refs } = job;
    noteSelection();
    try {
      while (job.next > 0) {
        const source = refs[--job.next].deref();
        if (source !== undefined) {
          const wrapper = wrapperOf.get(source);
          if (wrapper !== undefined) letGo(source, wrapper);
        }
        if ((job.next & 31) === 0 && performance.now() >= deadline) break;
      }
    } finally {
      restoreSelection();
    }
    return job.next === 0;
  }

  function finishRestore() {
    const job = restoring;
    if (job === null) return;
    restoring = null;
    try {
      restoreSome(job, Infinity);
      // Copies of our markup the engine never adopted (content that was waiting for
      // its container to go quiet) are turned into plain text as well.
      for (const [root] of job.roots) {
        for (const element of root.querySelectorAll('skb-w, skb-b')) unwrapStray(element);
      }
    } finally {
      for (const [root, entry] of job.roots) detachRoot(root, entry);
    }
  }

  // Turned back on before the restore has finished: what is still wrapped stays so,
  // its sources tracked and its roots observed again, and the scan wraps the rest.
  // (Finishing the restore first blocked the page for up to 0.4 s on a long page.)
  function resumeRestore() {
    const job = restoring;
    if (job === null) return;
    restoring = null;
    for (const [root, entry] of job.roots) {
      entry.observer.observe(root, OBSERVE);
      roots.set(root, entry);
    }
    for (let i = 0; i < job.next; i++) {
      const source = job.refs[i].deref();
      const wrapper = source === undefined ? undefined : wrapperOf.get(source);
      if (wrapper === undefined) continue;
      listed.add(source);
      sources.add(job.refs[i]);
      // Nothing watched the page meanwhile.
      if (source.data !== '' || source.nextSibling !== wrapper) posDirty.add(source);
    }
  }

  // Restoring a very long page is sliced like scanning; small pages finish in the
  // first, synchronous slice.
  async function restoreLoop(job) {
    let budgetMs = SLICE_MS;
    try {
      while (restoring === job && !restoreSome(job, performance.now() + budgetMs)) {
        budgetMs = nextBudget(budgetMs, await yieldToMain());
      }
      if (restoring === job) finishRestore();
    } catch (error) {
      warn(error);
    }
  }

  // A page can serialize its markup while Skimbold is on and put it back after it
  // is turned off (a cached tab panel). Copies of our wrappers that arrive then are
  // turned back into plain text; unstyled, some pages would hide them.
  let strayWatchers = [];

  function watchStrays(rootList) {
    unwatchStrays();
    for (const root of rootList) {
      if (root !== document && !root.host.isConnected) continue;
      const observer = new MutationObserver(onStrayRecords);
      observer.observe(root, { childList: true, subtree: true });
      strayWatchers.push(observer);
    }
  }

  function unwatchStrays() {
    for (const observer of strayWatchers) observer.disconnect();
    strayWatchers = [];
  }

  function onStrayRecords(records) {
    try {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== ELEMENT_NODE || !node.isConnected) continue;
          if (node.localName === 'skb-w' || node.localName === 'skb-b') unwrapStray(node);
          else if (node.firstElementChild !== null) for (const element of node.querySelectorAll('skb-w, skb-b')) unwrapStray(element);
        }
      }
    } catch (error) {
      warn(error);
    }
  }

  function unwrapStray(element) {
    const parent = element.parentNode;
    if (!element.isConnected || parent === null) return;
    // A bold part inside a wrapper goes with it; markup in an editor or code block belongs there.
    if (parent.nodeType === ELEMENT_NODE && parent.closest(ZONE) !== null) return;
    // A copy of a wrapper the page had edited inside keeps the page's markup, with its
    // text in whole nodes (see unwrapOwned).
    if (element.querySelector(':not(skb-b)') !== null) {
      for (const bold of element.querySelectorAll('skb-b')) unwrap(bold);
      element.normalize();
      unwrap(element);
      return;
    }
    const text = element.textContent;
    const before = element.previousSibling;
    if (element.localName === 'skb-w' && before !== null && before.nodeType === TEXT_NODE && before.data === '') before.data = text;
    else parent.insertBefore(document.createTextNode(text), element);
    element.remove();
  }

  /* ── Public API ────────────────────────────────────────────────────────── */

  // A browser's PDF viewer draws the text itself, out of a content script's reach,
  // so there is nothing to bold and the page must not claim to be on.
  function isPdfDocument() {
    return document.contentType === 'application/pdf';
  }

  // Styles, observes and scans the page; turns back off if the page blocked our styles.
  function begin(waited) {
    starting = null;
    restyle();
    if (!attachRoot(document)) {
      warn(new Error('the page blocked our stylesheet, so it was left unchanged'));
      active = false;
      report();
      return;
    }
    pass = { count: 0 };
    const start = document.body || document.documentElement;
    if (start !== null) enqueue(start);
    startLoop(FIRST_SLICE_MS);
    // The frames here now are brought in line with the page by whoever turned it on,
    // except those that loaded while enable() waited for the page.
    const frames = document.querySelectorAll('iframe, frame');
    if (waited) requestFrames(frames);
    else for (const frame of frames) seenFrames.add(frame);
  }

  // Waits for the load event (or until LOAD_WAIT_MS after the page opened) and a
  // moment of idle, so an app rendered on the server has hydrated before its text is
  // wrapped. Pages full of ads can take much longer to fire load, long after they
  // are readable, so the wait counts from the page's start, not from the toggle.
  function waitForPage() {
    const token = {};
    starting = token;
    let timer = 0;
    const loaded = () => {
      window.removeEventListener('load', loaded);
      clearTimeout(timer);
      if (starting !== token) return;
      whenIdle(() => {
        if (starting === token && active) begin(true);
      });
    };
    window.addEventListener('load', loaded);
    timer = setTimeout(loaded, Math.max(0, LOAD_WAIT_MS - performance.now()));
  }

  // A frame whose src or srcdoc is still on its way shows an empty about:blank until
  // its page arrives, and Chromium keeps this script's world when it does. Nothing
  // is started there, so the engine starts afresh on the page itself (skb:frames).
  // An about:blank frame with nothing on its way is the page's own, filled by script.
  function isPlaceholder() {
    if (location.href !== 'about:blank') return false;
    let frame = null;
    try {
      frame = window.frameElement;
    } catch {
      frame = null;
    }
    if (frame === null) return false;
    const src = (frame.getAttribute('src') || '').trim();
    return frame.hasAttribute('srcdoc') || (src !== '' && src !== 'about:blank');
  }

  function enable() {
    if (active || document.designMode === 'on' || isPdfDocument() || isPlaceholder()) return;
    try {
      resumeRestore();
      unwatchStrays();
      heats = new WeakMap();
      active = true;
      if (document.readyState === 'complete') begin(false);
      else waitForPage();
      if (active) report();
    } catch (error) {
      warn(error);
    }
  }

  function disable() {
    if (!active) return;
    active = false;
    starting = null;
    loopToken = null;
    frameToken = null;
    walk = null;
    batch = [];
    batchChars = 0;
    try {
      // Bring every source up to date with what the page did before handing it back.
      openWrite();
      try {
        reconcile(Infinity);
      } finally {
        closeWrite();
      }
    } catch (error) {
      warn(error);
    }
    // Disconnected first, so restoring thousands of nodes queues no records.
    for (const entry of roots.values()) entry.observer.disconnect();
    const refs = [...sources];
    const rootList = [...roots];
    restoring = { refs, next: refs.length, roots: rootList };
    roots.clear();
    rootSweepAt = 64;
    sources = new Set();
    listed = new WeakSet();
    sourceSweepAt = 1024;
    queue = [];
    head = 0;
    queued.clear();
    textDirty.clear();
    posDirty.clear();
    zoneDirty.clear();
    strays.clear();
    hostsDirty.clear();
    walked.clear();
    apart.clear();
    places.clear();
    edited.clear();
    detached = [];
    deferred.clear();
    clearTimeout(deferTimer);
    deferTimer = 0;
    stopHostSweep();
    watchStrays(rootList.map(([root]) => root));
    report();
    restoreLoop(restoring);
  }

  function toggle() {
    if (active) disable();
    else enable();
    return active;
  }

  function isActive() {
    return active;
  }

  // Re-applies the current settings: new stylesheet text, and every wrapper
  // re-rendered in document order with a fresh everyNth count.
  function refresh() {
    if (!active || !loaded || starting !== null) return;
    try {
      gen++;
      pass = { count: 0 };
      restyle();
      for (const root of roots.keys()) {
        const start = root === document ? document.body || document.documentElement : root;
        if (start !== null) enqueue(start);
      }
      startLoop(FIRST_SLICE_MS);
    } catch (error) {
      warn(error);
    }
  }

  function applySettings(next) {
    const previous = settings;
    const first = !loaded;
    settings = next;
    loaded = true;
    if (!active || starting !== null) {
      // Wrappers kept from before (see resumeRestore) are re-rendered by the next scan.
      if (TEXT_OPTIONS.some((key) => previous[key] !== next[key])) gen++;
      return;
    }
    try {
      if (first) {
        // enable() ran before the settings arrived; the scan starts now.
        restyle();
        startLoop(FIRST_SLICE_MS);
      } else if (TEXT_OPTIONS.some((key) => previous[key] !== next[key])) {
        refresh();
      } else if (previous.weight !== next.weight || previous.fade !== next.fade) {
        restyle();
      }
    } catch (error) {
      warn(error);
    }
  }

  function send(message) {
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;
    try {
      const sent = api.runtime.sendMessage(message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => undefined);
    } catch {
      // The extension was reloaded or updated, so nobody is listening any more.
    }
  }

  // Only the top frame speaks for the tab (the toolbar badge).
  function report() {
    if (isTop) send({ type: 'skb:state', active });
  }

  function onMessage(message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;
    switch (message.type) {
      case 'skb:toggle':
        choices++;
        toggle();
        break;
      case 'skb:set':
        // A frame brought in line with the top frame is not a choice of the user's.
        if (!message.sync) choices++;
        if (!isTop && Number.isInteger(message.frameId)) noteFrameId(message.frameId);
        if (message.active) enable();
        else disable();
        break;
      case 'skb:getState':
        sendResponse({ active, pdf: isPdfDocument() });
        return undefined;
      default:
        return undefined;
    }
    sendResponse({ active });
    return undefined;
  }

  Skimbold.engine = { enable, disable, toggle, isActive, refresh, choices: () => choices };

  if (api && api.runtime && api.runtime.onMessage) api.runtime.onMessage.addListener(onMessage);
  Skimbold.settings.onChange(applySettings);
  Skimbold.settings.load().then((current) => {
    if (!loaded) applySettings(current);
  });
  // A page restored from the back/forward cache lost its tab badge on navigation.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && active) report();
  });
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('copy', onCopy);
  window.addEventListener('dragstart', onCopy);
  window.addEventListener('beforeinput', onBeforeInput, true);
})();
