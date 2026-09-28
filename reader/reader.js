/*
 * Skimbold Reader: paste text or open a file (plain text, Markdown, HTML or
 * PDF) and read it with the start of every word in bold.
 *
 * Runs as an extension page and as a plain web page (the web build copies
 * reader/, shared/, vendor/ and icons/ side by side), so every extension API
 * is optional. Page and file text only ever reaches the DOM through
 * createElement and text nodes.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold;
  const core = Skimbold.core;
  const store = Skimbold.settings;
  const api = globalThis.browser ?? globalThis.chrome;
  const isExtension = Boolean(api && api.runtime && api.runtime.id);

  const MAX_BYTES = 100 * 1024 * 1024;
  const MAX_REMEMBER = 4 * 1024 * 1024;
  const MAX_BLOCK = 20000;
  const SECTION_BLOCKS = 40;
  const SECTION_CHARS = 30000;
  const SLICE_MS = 8;
  const TAB_CHUNK = 8 * 1024 * 1024;
  const SAVE_DELAY = 400;
  const DOC_KEY = 'skimbold.reader.doc';
  const POS_KEY = 'skimbold.reader.position';
  const THEME_KEY = 'skimbold.reader.theme';
  const OPEN_KEY = 'skimbold.reader.open';
  const SIZES = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28, 30, 32, 36, 40, 44, 48];
  const HOME_TITLE = 'Paste text or open a file';
  const HOME_LEAD = 'Skimbold bolds the start of every word to help you focus and keep your place.';
  const KIND_LABELS = {
    paste: 'Pasted text',
    selection: 'Selected text',
    typed: 'Typed text',
    text: 'Text file',
    md: 'Markdown',
    html: 'Web page',
    pdf: 'PDF',
  };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const MOD = isMac ? '⌘' : 'Ctrl';

  /* ── Small helpers ─────────────────────────────────────────────────────── */

  function storageGet(area, key) {
    try {
      return globalThis[area].getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(area, key, value) {
    try {
      globalThis[area].setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function storageRemove(area, key) {
    try {
      globalThis[area].removeItem(key);
    } catch {
      // Storage is blocked; there is nothing to remove.
    }
  }

  function yieldToMain() {
    const scheduler = globalThis.scheduler;
    if (scheduler && typeof scheduler.yield === 'function') return scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function randomId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatNumber(n) {
    return new Intl.NumberFormat().format(n);
  }

  function plural(n, one, many) {
    return `${formatNumber(n)} ${n === 1 ? one : many}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark' || theme === 'sepia') root.dataset.theme = theme;
    else root.removeAttribute('data-theme');
  }

  // The stored settings arrive asynchronously; the last theme is cached so the
  // page never flashes the wrong colours first.
  applyTheme(storageGet('localStorage', THEME_KEY));

  /* ── Turning text into blocks ──────────────────────────────────────────────
   * A block is { t, x } with t: 'p' | 'h' | 'li' | 'quote' | 'pre' | 'hr' | 'note'.
   * Headings add l (level); list items add d (depth), ol (ordered), n (number)
   * and c (continues the item above). A '\n' inside x is a line break.
   */

  const LIST_LINE = /^\s*(?:[-*+•–]|\d{1,3}[.)])\s+\S/;
  const UPPER_START = /^[\p{Lu}\p{N}"'“‘«([]/u;
  const LOWER_START = /^\p{Ll}/u;
  const HYPHEN_END = /\p{L}[-\u{2010}]$/u;

  function normalizeNewlines(text) {
    return text.replace(/^\uFEFF/, '').replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n').replace(/\f/g, '\n\n');
  }

  function collapse(text) {
    return text.replace(/[ \t]+/g, ' ').trim();
  }

  // Very long paragraphs are cut at a sentence end so no single block takes
  // long to render.
  function splitLong(text) {
    if (text.length <= MAX_BLOCK) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > MAX_BLOCK) {
      const window = rest.slice(0, MAX_BLOCK);
      let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      cut = cut > MAX_BLOCK / 2 ? cut + 1 : window.lastIndexOf(' ');
      if (cut <= 0) cut = /[\uD800-\uDBFF]/.test(window.charAt(MAX_BLOCK - 1)) ? MAX_BLOCK - 1 : MAX_BLOCK;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  function pushText(blocks, t, text, extra) {
    const clean = text.split('\n').map(collapse).filter(Boolean).join('\n');
    if (!clean) return;
    const pieces = t === 'p' || t === 'quote' ? splitLong(clean) : [clean];
    for (const x of pieces) blocks.push(extra ? { t, x, ...extra } : { t, x });
  }

  function joinWrapped(lines) {
    let text = '';
    for (const raw of lines) {
      const line = collapse(raw);
      if (!line) continue;
      if (!text) text = line;
      else if (text.endsWith('\u00AD')) text = text.slice(0, -1) + line;
      else if (HYPHEN_END.test(text)) text = LOWER_START.test(line) ? text.slice(0, -1) + line : text + line;
      else text += ' ' + line;
    }
    return text;
  }

  // One blank-line-separated chunk of plain text.
  function textParagraph(chunk, blocks) {
    const lines = chunk.split('\n').filter((line) => line.trim());
    if (lines.length === 0) return;
    if (lines.length === 1) {
      pushText(blocks, 'p', lines[0]);
      return;
    }
    // Lists keep one item per line; indented lines continue the item above.
    const markers = lines.filter((line) => LIST_LINE.test(line)).length;
    if (markers >= 2 || LIST_LINE.test(lines[0])) {
      const items = [];
      for (const line of lines) {
        if (items.length && !LIST_LINE.test(line) && /^\s/.test(line)) items[items.length - 1] += ' ' + collapse(line);
        else items.push(collapse(line));
      }
      pushText(blocks, 'p', items.join('\n'));
      return;
    }
    // Long lines are paragraphs of their own (text copied with single line breaks).
    if (lines.filter((line) => line.length > 120).length >= lines.length / 2) {
      for (const line of lines) pushText(blocks, 'p', line);
      return;
    }
    // Poetry and addresses: short lines, or lines that mostly start with a capital.
    const rest = lines.slice(1);
    const capitals = rest.filter((line) => UPPER_START.test(line.trim())).length;
    // A loop, not Math.max(...lines): spreading a chunk of 125,000+ lines overflows the stack.
    let longest = 0;
    for (const line of lines) longest = Math.max(longest, line.trim().length);
    if (longest <= 40 || capitals >= rest.length * 0.75) {
      pushText(blocks, 'p', lines.join('\n'));
      return;
    }
    pushText(blocks, 'p', joinWrapped(lines));
  }

  async function parseText(text, isCurrent) {
    const source = normalizeNewlines(text);
    const blocks = [];
    const blank = /\n[ \t]*\n/g;
    let start = 0;
    let deadline = performance.now() + SLICE_MS;
    while (start < source.length) {
      const match = blank.exec(source);
      const end = match ? match.index : source.length;
      textParagraph(source.slice(start, end), blocks);
      start = match ? blank.lastIndex : source.length;
      if (performance.now() >= deadline) {
        await yieldToMain();
        if (!isCurrent()) return null;
        deadline = performance.now() + SLICE_MS;
      }
    }
    return blocks;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : match;
    });
  }

  // Strips Markdown's inline markers and keeps the words.
  function inlineMarkdown(text) {
    const kept = [];
    const keep = (value) => `\uE000${kept.push(value) - 1}\uE001`;
    let out = text
      .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => keep(code.trim()))
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (m, ch) => keep(ch));
    out = out
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '$1')
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
    return decodeEntities(out).replace(/\uE000(\d+)\uE001/g, (m, i) => kept[Number(i)]);
  }

  const MD_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  const MD_BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|```|~~~|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/;
  const MD_TABLE_ROW = /^\s*\|.*\|\s*$/;
  const MD_TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inlineMarkdown(cell.trim()));
  }

  // Parsed in slices like plain text, so a long file never blocks the page for long.
  async function parseMarkdown(source, isCurrent = () => true) {
    const lines = normalizeNewlines(source).split('\n');
    const blocks = [];
    let para = [];
    let deadline = performance.now() + SLICE_MS;
    const flush = () => {
      if (!para.length) return;
      let text = '';
      para.forEach((line, i) => {
        const hard = /(?: {2,}|\\)$/.test(line);
        text += line.replace(/(?: {2,}|\\)$/, '').trim();
        if (i < para.length - 1) text += hard ? '\n' : ' ';
      });
      para = [];
      pushText(blocks, 'p', inlineMarkdown(text));
    };

    for (let i = 0; i < lines.length; i++) {
      if ((i & 127) === 0 && performance.now() >= deadline) {
        await yieldToMain();
        if (!isCurrent()) return null;
        deadline = performance.now() + SLICE_MS;
      }
      const line = lines[i];
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        flush();
        const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        const code = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        if (code.join('').trim()) blocks.push({ t: 'pre', x: code.join('\n') });
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading) {
        flush();
        pushText(blocks, 'h', inlineMarkdown(heading[2] || ''), { l: heading[1].length });
        continue;
      }
      if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
        const text = inlineMarkdown(para.map((part) => part.trim()).join(' '));
        para = [];
        pushText(blocks, 'h', text, { l: line.trim()[0] === '=' ? 1 : 2 });
        continue;
      }
      if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
        flush();
        blocks.push({ t: 'hr' });
        continue;
      }
      const item = MD_ITEM.exec(line);
      if (item) {
        flush();
        let text = item[3].replace(/^\[([ xX])\][ \t]+/, (m, mark) => (mark === ' ' ? '☐ ' : '☑ '));
        // Indented lines, and lazy lines that start no other block, continue the item.
        while (i + 1 < lines.length && lines[i + 1].trim() && !MD_ITEM.test(lines[i + 1])
          && !MD_BLOCK_START.test(lines[i + 1])) {
          const next = lines[++i];
          text += /(?: {2,}|\\)$/.test(lines[i - 1]) ? '\n' + next.trim() : ' ' + next.trim();
        }
        const depth = Math.min(4, Math.floor(item[1].replace(/\t/g, '    ').length / 2));
        const extra = { d: depth };
        if (/\d/.test(item[2])) {
          extra.ol = 1;
          extra.n = parseInt(item[2], 10);
        }
        pushText(blocks, 'li', inlineMarkdown(text), extra);
        continue;
      }
      if (/^ {0,3}>/.test(line)) {
        flush();
        const quoted = [];
        while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || !MD_BLOCK_START.test(lines[i]))) {
          quoted.push(lines[i].replace(/^ {0,3}> ?/, ''));
          i++;
        }
        i--;
        const inner = await parseMarkdown(quoted.join('\n'), isCurrent);
        if (inner === null) return null;
        for (const block of inner) blocks.push(block.t === 'p' ? { ...block, t: 'quote' } : block);
        continue;
      }
      if (MD_TABLE_ROW.test(line) && i + 1 < lines.length && MD_TABLE_RULE.test(lines[i + 1])) {
        flush();
        const rows = [tableCells(line).join(' · ')];
        for (i += 2; i < lines.length && MD_TABLE_ROW.test(lines[i]); i++) rows.push(tableCells(lines[i]).join(' · '));
        i--;
        pushText(blocks, 'p', rows.join('\n'));
        continue;
      }
      // Link reference definitions ("[id]: https://…") are not text.
      if (!para.length && /^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) continue;
      para.push(line);
    }
    flush();
    return blocks;
  }

  const HTML_SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas',
    'video', 'audio', 'picture', 'img', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'aside',
    'dialog', 'head', 'link', 'meta', 'map', 'datalist', 'output', 'progress', 'meter',
  ]);
  const HTML_BLOCKS = new Set([
    'address', 'article', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'header', 'hgroup', 'main', 'p', 'section', 'summary', 'table', 'tbody', 'thead',
    'tfoot', 'caption', 'center', 'menu', 'legend',
  ]);

  // Reads headings, paragraphs, list items, quotes and code from an HTML file.
  // DOMParser builds an inert document (no scripts run, nothing loads), and
  // only its text is used: none of its markup reaches the page. The walk can
  // yield at any node, so a long file never blocks the page for long, however
  // its parts are nested. Only DOMParser's own parse runs in one go.
  async function parseHtml(source, isCurrent = () => true) {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const root = parsed.querySelector('article') || parsed.querySelector('main') || parsed.body;
    const blocks = [];
    let buffer = '';
    // The nodes still to read, last first: a stack rather than recursion, so the
    // walk can stop at the slice deadline anywhere. An entry is a node, to be
    // read with the siblings after it, or (node null) the end of a block.
    const stack = [];

    const flush = (ctx) => {
      const text = buffer;
      buffer = '';
      if (ctx.type === 'li') {
        const before = blocks.length;
        pushText(blocks, 'li', text, ctx.first ? { d: ctx.depth, ...ctx.marker } : { d: ctx.depth, c: 1, ...(ctx.marker.ol ? { ol: 1 } : {}) });
        if (blocks.length > before) ctx.first = false;
      } else if (ctx.type === 'h') {
        pushText(blocks, 'h', text, { l: ctx.level });
      } else {
        pushText(blocks, ctx.type, text);
      }
    };

    // Reads a node's children, then flushes `end` when given. The end is pushed
    // first so it comes off the stack after the children and before the node's
    // next sibling.
    const walk = (node, ctx, end) => {
      if (end) stack.push({ node: null, ctx: end });
      if (node.firstChild) stack.push({ node: node.firstChild, ctx });
    };

    const visit = (child, ctx) => {
      if (child.nodeType === 3) {
        buffer += child.data.replace(/[\t\n\r\f ]+/g, ' ');
        return;
      }
      if (child.nodeType !== 1) return;
      const tag = child.localName;
      if (HTML_SKIP.has(tag) || child.hidden || child.getAttribute('aria-hidden') === 'true'
          || (child.style && child.style.display === 'none')) return;
      if (tag === 'br') {
        buffer += '\n';
      } else if (/^h[1-6]$/.test(tag)) {
        flush(ctx);
        const heading = { type: 'h', level: Number(tag[1]) };
        walk(child, heading, heading);
      } else if (tag === 'pre') {
        flush(ctx);
        const code = child.textContent.replace(/^\n/, '').replace(/\s+$/, '');
        if (code) blocks.push({ t: 'pre', x: code });
      } else if (tag === 'hr') {
        flush(ctx);
        blocks.push({ t: 'hr' });
      } else if (tag === 'ul' || tag === 'ol') {
        flush(ctx);
        const start = parseInt(child.getAttribute('start'), 10);
        const list = { ordered: tag === 'ol', next: Number.isFinite(start) ? start : 1 };
        walk(child, { type: 'p', list, depth: ctx.list ? Math.min(4, ctx.depth + 1) : 0 });
      } else if (tag === 'li') {
        flush(ctx);
        const list = ctx.list || { ordered: false, next: 1 };
        const marker = list.ordered ? { ol: 1, n: list.next++ } : {};
        const item = { type: 'li', list, depth: ctx.depth || 0, marker, first: true };
        walk(child, item, item);
      } else if (tag === 'blockquote') {
        flush(ctx);
        const quote = { ...ctx, type: 'quote' };
        walk(child, quote, quote);
      } else if (tag === 'tr') {
        flush(ctx);
        walk(child, ctx, ctx);
      } else if (tag === 'td' || tag === 'th') {
        if (buffer.trim()) buffer += ' · ';
        walk(child, ctx);
      } else if (HTML_BLOCKS.has(tag)) {
        flush(ctx);
        walk(child, ctx, ctx);
      } else {
        walk(child, ctx);
      }
    };

    const top = { type: 'p', depth: 0 };
    if (root) walk(root, top, top);
    let deadline = performance.now() + SLICE_MS;
    while (stack.length) {
      if (performance.now() >= deadline) {
        await yieldToMain();
        if (!isCurrent()) return null;
        deadline = performance.now() + SLICE_MS;
      }
      const { node, ctx } = stack.pop();
      if (!node) {
        flush(ctx);
        continue;
      }
      if (node.nextSibling) stack.push({ node: node.nextSibling, ctx });
      visit(node, ctx);
    }
    return blocks;
  }

  function sectionsOf(blocks) {
    const sections = [];
    let current = null;
    let chars = 0;
    for (const block of blocks) {
      if (!current || current.blocks.length >= SECTION_BLOCKS || chars >= SECTION_CHARS) {
        current = { blocks: [] };
        sections.push(current);
        chars = 0;
      }
      current.blocks.push(block);
      chars += block.x ? block.x.length : 0;
    }
    return sections;
  }

  function titleFromText(text) {
    const line = (text.split('\n').find((part) => part.trim()) || '').trim().replace(/\s+/g, ' ');
    return line.length > 70 ? line.slice(0, 67).replace(/\s+\S*$/, '') + '…' : line;
  }

  /* ── Files ─────────────────────────────────────────────────────────────── */

  function kindOfFile(name, type) {
    const ext = /\.([a-z0-9]+)$/i.exec(name || '');
    const extension = ext ? ext[1].toLowerCase() : '';
    if (extension === 'pdf' || type === 'application/pdf') return 'pdf';
    if (['md', 'markdown', 'mdown', 'mkd'].includes(extension) || type === 'text/markdown' || type === 'text/x-markdown') return 'md';
    if (['html', 'htm', 'xhtml'].includes(extension) || type === 'text/html' || type === 'application/xhtml+xml') return 'html';
    if (['txt', 'text'].includes(extension) || /^text\//.test(type || '')) return 'text';
    return null;
  }

  // What a file is, from its content first: a PDF saved as .txt is still a PDF, and a binary
  // file is not text whatever its name says. Text files keep the kind their name gives.
  function kindOfBytes(bytes, name, type) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    const binary = !utf16 && bytes.subarray(0, 8192).includes(0);
    // A PDF starts with its signature, or carries it in its first kilobyte with binary data after.
    if (/^\s*%PDF-/.test(head) || (binary && head.includes('%PDF-'))) return 'pdf';
    const named = kindOfFile(name, type);
    if (named === 'pdf') return 'pdf';
    if (binary) return null;
    return named || (/^\s*<(?:!doctype html|html[\s>])/i.test(head) ? 'html' : 'text');
  }

  function decodeText(bytes, kind) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    if (kind === 'html') {
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
      const declared = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
      if (declared) {
        try {
          return new TextDecoder(declared[1]).decode(bytes);
        } catch {
          // An unknown label: fall through to UTF-8.
        }
      }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function decodeBase64(text) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function readLimited(response) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return { error: 'too-large' };
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return buffer.byteLength > MAX_BYTES ? { error: 'too-large' } : { bytes: new Uint8Array(buffer) };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        reader.cancel();
        return { error: 'too-large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes };
  }

  // Runs inside the PDF's own tab (via scripting.executeScript), so the request
  // is same-origin there and carries that site's cookies. The file waits in
  // this isolated world until the Reader collects it in pieces.
  async function fetchPdfInTab(url, token, limit) {
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) return { error: 'failed' };
      if (Number(response.headers.get('content-length')) > limit) return { error: 'too-large' };
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > limit) return { error: 'too-large' };
      const stash = globalThis.skimboldPdfStash || (globalThis.skimboldPdfStash = new Map());
      stash.set(token, buffer);
      return { size: buffer.byteLength };
    } catch {
      return { error: 'failed' };
    }
  }

  // Also runs in the PDF's tab: returns one piece of the stashed file as base64.
  function readPdfPieceInTab(token, offset, length) {
    const stash = globalThis.skimboldPdfStash;
    const buffer = stash && stash.get(token);
    if (!buffer) return null;
    const end = Math.min(buffer.byteLength, offset + length);
    if (end >= buffer.byteLength) stash.delete(token);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(new Blob([new Uint8Array(buffer, offset, end - offset)]));
    });
  }

  async function fetchViaTab(tabId, url) {
    const target = { tabId };
    const token = randomId();
    try {
      const [first] = await api.scripting.executeScript({ target, func: fetchPdfInTab, args: [url, token, MAX_BYTES] });
      const info = first && first.result;
      if (!info || info.error) return info && info.error === 'too-large' ? info : null;
      const bytes = new Uint8Array(info.size);
      // Messages between the tab and the Reader are size-limited, so the file comes in pieces.
      for (let offset = 0; offset < info.size; offset += TAB_CHUNK) {
        const [piece] = await api.scripting.executeScript({ target, func: readPdfPieceInTab, args: [token, offset, TAB_CHUNK] });
        if (!piece || typeof piece.result !== 'string') return null;
        bytes.set(decodeBase64(piece.result), offset);
      }
      return { bytes };
    } catch {
      return null;
    }
  }

  async function fetchDirect(url) {
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) return null;
      return await readLimited(response);
    } catch {
      return null;
    }
  }

  let pdfjsPromise = null;

  // pdf.js uses the Iterator global as it loads; a browser without it (Chrome before 122,
  // Safari before 18.4) cannot run it at all. What else it needs from newer browsers,
  // pdf-support.js adds, here and in the worker (pdf-worker.mjs).
  function canRunPdfJs() {
    return typeof globalThis.Iterator === 'function';
  }

  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./pdf-support.js')
        .then(() => import('../vendor/pdfjs/pdf.min.mjs'))
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = new URL('pdf-worker.mjs', document.baseURI).href;
          return lib;
        });
      pdfjsPromise.catch(() => {
        pdfjsPromise = null;
      });
    }
    return pdfjsPromise;
  }

  // A browser that lacks something pdf.js calls fails part-way through a file, which must
  // not read as a damaged PDF.
  function missingFeature(error) {
    return /is not (?:a function|defined)|Iterator/.test(String(error && error.message));
  }

  function browserTooOld() {
    return {
      tone: 'danger',
      title: 'This browser is too old to open PDFs here.',
      text: 'Update it to the latest version, then open the PDF again. Text files and pasted text work as they are.',
    };
  }

  /* ── Page state ────────────────────────────────────────────────────────── */

  const els = {};
  let settings = store.sanitize(undefined);
  let pendingPatch = null;
  let savesInFlight = 0;
  let saveTimer = 0;
  let positionTimer = 0;
  let internalDrag = false;
  let dragDepth = 0;

  const view = {
    doc: null, // the document being shown
    job: 0, // bumps to stop a render
    rerenderJob: 0,
    load: 0, // bumps to abandon a file or PDF that is still loading
    controller: null,
    waiting: null, // resolves when a streaming PDF delivers another page
    blocks: [], // [{ el, target, text, count }] in document order
    totalBlocks: 0, // once known, for "n% read"
    state: { count: 0 }, // running everyNth count for the first render
    cursor: null,
    words: 0,
    restore: null,
    opts: null,
    optsKey: '',
  };

  function transformOptions(s) {
    return { mode: s.mode, strength: s.strength, letters: s.letters, skipShort: s.skipShort, everyNth: s.everyNth };
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function fill(target, text, state) {
    const fragment = document.createDocumentFragment();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) fragment.append(document.createElement('br'));
      const parts = core.transform(lines[i], view.opts, state);
      if (!parts) {
        fragment.append(lines[i]);
        continue;
      }
      for (const part of parts) {
        if (part.b) fragment.append(el('span', 'skb-rb', part.t));
        else fragment.append(part.t);
      }
    }
    target.replaceChildren(fragment);
  }

  function countWords(text) {
    const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
    return words ? words.length : 0;
  }

  function wake() {
    const resolve = view.waiting;
    view.waiting = null;
    if (resolve) resolve();
  }

  function estimateHeight(section) {
    const r = settings.reader;
    const width = Math.min(r.width, Math.max(240, window.innerWidth - 40));
    const perLine = Math.max(20, width / (r.fontSize * 0.5));
    let lines = 0;
    for (const block of section.blocks) lines += Math.ceil((block.x ? block.x.length : 0) / perLine) + 1;
    return Math.round(lines * r.fontSize * r.lineHeight);
  }

  function openSection(section, index) {
    const node = el('section', 'rd-sec');
    if (section.label && index > 0) node.append(el('p', 'rd-page', section.label));
    node.style.containIntrinsicSize = `auto ${estimateHeight(section)}px`;
    els.docBody.append(node);
    return node;
  }

  function groupFor(cursor, key, make) {
    if (!cursor.group || cursor.groupKey !== key) {
      cursor.group = make();
      cursor.groupKey = key;
      cursor.sectionEl.append(cursor.group);
    }
    return cursor.group;
  }

  function renderBlock(block, cursor) {
    const count = view.state.count;
    let node;
    let target = null;
    if (block.t === 'li') {
      const key = block.ol ? 'ol' : 'ul';
      const list = groupFor(cursor, key, () => {
        const made = document.createElement(key);
        if (block.ol && block.n != null && block.n !== 1) made.start = block.n;
        return made;
      });
      node = target = document.createElement('li');
      if (block.ol && block.n != null) node.value = block.n;
      if (block.d) node.style.marginInlineStart = `${block.d * 1.5}em`;
      if (block.c) node.className = 'rd-li-more';
      list.append(node);
    } else if (block.t === 'quote') {
      const quote = groupFor(cursor, 'quote', () => document.createElement('blockquote'));
      node = target = document.createElement('p');
      quote.append(node);
    } else {
      cursor.group = null;
      if (block.t === 'h') node = target = document.createElement(`h${clamp(block.l || 2, 1, 6)}`);
      else if (block.t === 'pre') node = el('pre', 'rd-code', block.x);
      else if (block.t === 'hr') node = document.createElement('hr');
      else if (block.t === 'note') node = el('p', 'rd-note', block.x);
      else node = target = document.createElement('p');
      cursor.sectionEl.append(node);
    }
    node.dataset.i = String(view.blocks.length);
    const text = typeof block.x === 'string' ? block.x : '';
    if (target) {
      fill(target, text, view.state);
      view.words += countWords(text);
    }
    view.blocks.push({ el: node, target, text, count });
  }

  function barBottom() {
    return els.bar.getBoundingClientRect().bottom;
  }

  // Scrolls back to where the reader was. Sections above first lay out at an
  // estimated height and then settle, so the spot is held for a moment, until
  // the reader scrolls or presses anything.
  function applyRestore() {
    const { i, f } = view.restore;
    view.restore = null;
    const entry = view.blocks[i];
    if (!entry) return;
    const job = view.job;
    const place = () => {
      const rect = entry.el.getBoundingClientRect();
      const offset = rect.top - barBottom() - 16 + clamp(f, 0, 1) * rect.height;
      if (Math.abs(offset) >= 1) window.scrollBy(0, offset);
    };
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    let released = false;
    const release = () => {
      released = true;
    };
    for (const type of events) window.addEventListener(type, release, { capture: true, passive: true });
    const until = performance.now() + 1500;
    const hold = () => {
      if (released || job !== view.job || performance.now() > until) {
        for (const type of events) window.removeEventListener(type, release, { capture: true });
        return;
      }
      place();
      requestAnimationFrame(hold);
    };
    place();
    requestAnimationFrame(hold);
  }

  async function renderLoop(job) {
    const cursor = view.cursor;
    let deadline = performance.now() + SLICE_MS;
    for (;;) {
      if (job !== view.job) return;
      const doc = view.doc;
      const section = doc.sections[cursor.section];
      if (!section) {
        if (doc.complete) break;
        await new Promise((resolve) => {
          view.waiting = resolve;
        });
        deadline = performance.now() + SLICE_MS;
        continue;
      }
      if (!cursor.sectionEl) cursor.sectionEl = openSection(section, cursor.section);
      if (cursor.block < section.blocks.length) {
        renderBlock(section.blocks[cursor.block], cursor);
        cursor.block++;
        if (view.restore && view.blocks.length > view.restore.i) applyRestore();
      } else {
        cursor.section++;
        cursor.block = 0;
        cursor.sectionEl = null;
        cursor.group = null;
      }
      if (performance.now() >= deadline) {
        await yieldToMain();
        deadline = performance.now() + SLICE_MS;
      }
    }
    finishDocument(job);
  }

  function finishDocument(job) {
    if (job !== view.job) return;
    const doc = view.doc;
    view.restore = null;
    view.totalBlocks = view.blocks.length;
    els.docLoading.hidden = true;
    els.docEnd.hidden = false;
    els.docMeta.textContent = metaOf(doc, view.words);
    if (!doc.remembered) remember(doc);
  }

  // Re-renders every block after a change to how words are bolded, starting
  // with what is on screen. Blocks keep their everyNth count from the first render.
  async function rerender() {
    const job = ++view.rerenderJob;
    const docJob = view.job;
    const total = view.blocks.length;
    const first = firstVisibleIndex();
    let deadline = performance.now() + SLICE_MS;
    for (let k = 0; k < total; k++) {
      if (job !== view.rerenderJob || docJob !== view.job) return;
      const entry = view.blocks[(first + k) % total];
      if (entry.target) fill(entry.target, entry.text, { count: entry.count });
      if (performance.now() >= deadline) {
        await yieldToMain();
        deadline = performance.now() + SLICE_MS;
      }
    }
  }

  function probePosition() {
    if (!view.blocks.length) return null;
    const column = els.docBody.getBoundingClientRect();
    const x = column.left + Math.min(column.width / 2, 120);
    const top = barBottom() + 12;
    for (let y = top; y < window.innerHeight; y += 24) {
      const hit = document.elementFromPoint(x, y);
      const block = hit && hit.closest('[data-i]');
      if (block && els.docBody.contains(block)) {
        const rect = block.getBoundingClientRect();
        return { i: Number(block.dataset.i), f: rect.height ? clamp((top - rect.top) / rect.height, 0, 1) : 0 };
      }
    }
    return null;
  }

  function firstVisibleIndex() {
    const pos = probePosition();
    return pos ? pos.i : 0;
  }

  function metaOf(doc, words) {
    const parts = [KIND_LABELS[doc.kind] || 'Document'];
    if (doc.pages) parts.push(plural(doc.pages, 'page', 'pages'));
    if (words) parts.push(plural(words, 'word', 'words'));
    return parts.join(' · ');
  }

  function makeDoc(title, kind, sections, extra) {
    return { v: 1, id: randomId(), title: title || KIND_LABELS[kind], kind, sections, complete: true, ...extra };
  }

  function showDocument(doc, { restore = false } = {}) {
    flushPosition();
    view.job++;
    wake();
    view.doc = doc;
    view.blocks = [];
    view.state = { count: 0 };
    view.words = 0;
    view.totalBlocks = doc.complete ? doc.sections.reduce((sum, section) => sum + section.blocks.length, 0) : 0;
    view.cursor = { section: 0, block: 0, sectionEl: null, group: null, groupKey: '' };
    view.restore = restore ? readPosition(doc.id) : null;
    els.docBody.replaceChildren();
    els.docTitle.textContent = doc.title;
    els.docMeta.textContent = metaOf(doc, 0);
    els.docEnd.hidden = true;
    els.docLoading.hidden = true;
    els.home.hidden = true;
    els.doc.hidden = false;
    els.barTitle.textContent = doc.title;
    els.barTitle.hidden = false;
    document.title = `${doc.title} · Skimbold Reader`;
    if (doc.private) storageRemove('sessionStorage', OPEN_KEY);
    else storageSet('sessionStorage', OPEN_KEY, doc.id);
    syncQuery(doc);
    window.scrollTo(0, 0);
    els.doc.focus({ preventScroll: true });
    announce(`Opened ${doc.title}`);
    // A PDF still streaming in is remembered once it is complete.
    if (doc.complete && !doc.remembered) remember(doc);
    renderLoop(view.job);
  }

  /* ── Remembering the last document ─────────────────────────────────────── */

  // Text from a private window stays out of storage (the Reader tab itself opens in a
  // regular window), as does where it was read up to.
  function remember(doc) {
    if (doc.private) {
      doc.remembered = true;
      return;
    }
    let chars = 0;
    for (const section of doc.sections) for (const block of section.blocks) chars += (block.x || '').length + 12;
    doc.remembered = true;
    if (chars > MAX_REMEMBER) {
      forget();
      return;
    }
    const { v, id, title, kind, sections, pages, source } = doc;
    const json = JSON.stringify({ v, id, title, kind, sections, pages, source });
    if (json.length > MAX_REMEMBER || !storageSet('localStorage', DOC_KEY, json)) forget();
  }

  function loadRemembered() {
    const raw = storageGet('localStorage', DOC_KEY);
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw);
      if (!doc || doc.v !== 1 || typeof doc.id !== 'string' || !Array.isArray(doc.sections)) return null;
      return { ...doc, complete: true, remembered: true };
    } catch {
      return null;
    }
  }

  function readPosition(id) {
    try {
      const pos = JSON.parse(storageGet('localStorage', POS_KEY) || 'null');
      return pos && pos.id === id && Number.isInteger(pos.i) ? pos : null;
    } catch {
      return null;
    }
  }

  function savePosition() {
    clearTimeout(positionTimer);
    positionTimer = 0;
    if (!view.doc || els.doc.hidden || view.doc.private) return;
    const pos = probePosition();
    if (!pos) return;
    const total = view.totalBlocks || view.blocks.length;
    const percent = total > 1 ? Math.round((100 * pos.i) / (total - 1)) : 0;
    storageSet('localStorage', POS_KEY, JSON.stringify({ id: view.doc.id, i: pos.i, f: Number(pos.f.toFixed(3)), p: percent }));
  }

  // Saves a position the last scroll has not stored yet. Leaving never measures
  // afresh, so whatever moves the page on the way out cannot change the spot.
  function flushPosition() {
    if (positionTimer) savePosition();
  }

  function forget() {
    storageRemove('localStorage', DOC_KEY);
    storageRemove('localStorage', POS_KEY);
  }

  function updateContinue() {
    const doc = loadRemembered();
    els.continue.hidden = !doc;
    if (!doc) return;
    const pos = readPosition(doc.id);
    els.continueTitle.textContent = doc.title;
    const bits = [metaOf(doc, 0)];
    if (pos && pos.p > 0) bits.push(`${Math.min(100, pos.p)}% read`);
    els.continueMeta.textContent = bits.join(' · ');
    els.continue.style.setProperty('--rd-read', `${pos ? Math.min(100, pos.p) : 0}%`);
  }

  /* ── Views and messages ────────────────────────────────────────────────── */

  function abortLoad() {
    view.load++;
    if (view.controller) view.controller.abort();
    view.controller = null;
    setProgress(null);
  }

  function showHome({ focus = true } = {}) {
    abortLoad();
    enterHome({ keepMessage: false, focus });
  }

  // Switches to the start page without touching a file that is still loading.
  function enterHome({ keepMessage, focus }) {
    flushPosition();
    view.job++;
    wake();
    view.doc = null;
    view.blocks = [];
    els.docBody.replaceChildren();
    els.doc.hidden = true;
    els.home.hidden = false;
    els.barTitle.hidden = true;
    document.title = 'Skimbold Reader';
    storageRemove('sessionStorage', OPEN_KEY);
    if (!keepMessage) clearMessage();
    updateContinue();
    window.scrollTo(0, 0);
    if (focus) els.homeTitle.focus({ preventScroll: true });
  }

  function clearMessage() {
    els.message.hidden = true;
    els.message.replaceChildren();
    els.message.removeAttribute('role');
  }

  // Shows a notice above the start page. tone: 'danger' | 'info'; busy notices
  // are plain status lines.
  function showMessage({ title, text, tone = 'info', actions = [], busy = false, content = null }) {
    if (!els.doc.hidden) enterHome({ keepMessage: true, focus: false });
    const box = el('div', busy ? 'rd-notice rd-notice--busy' : `rd-notice skb-notice${tone === 'danger' ? ' skb-notice--danger' : ''}`);
    if (title) box.append(el('p', 'rd-notice__title', title));
    if (text) box.append(el('p', 'rd-notice__text', text));
    if (content) box.append(content);
    if (actions.length) {
      const row = el('div', 'rd-notice__actions');
      for (const action of actions) {
        const button = el('button', `skb-btn skb-btn--small${action.primary ? ' skb-btn--primary' : ''}`, action.label);
        button.type = 'button';
        button.addEventListener('click', action.onClick);
        row.append(button);
      }
      box.append(row);
    }
    els.message.replaceChildren(box);
    els.message.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    els.message.hidden = false;
    if (!busy && !content) els.message.focus({ preventScroll: true });
  }

  // While a document is open it stays in view until the next one is ready.
  function showBusy(text) {
    if (els.doc.hidden) showMessage({ text, busy: true });
    setProgress('busy');
    announce(text);
  }

  function setProgress(value) {
    if (value === null) {
      els.progress.hidden = true;
      els.progress.classList.remove('is-busy');
      return;
    }
    els.progress.hidden = false;
    els.progress.classList.toggle('is-busy', value === 'busy');
    els.progressFill.style.width = value === 'busy' ? '' : `${Math.round(clamp(value, 0, 1) * 100)}%`;
  }

  function announce(text) {
    els.status.textContent = '';
    setTimeout(() => {
      els.status.textContent = text;
    }, 60);
  }

  const chooseFileAction = (label = 'Choose a file') => ({ label, primary: true, onClick: () => openPicker() });

  function tooLarge(name) {
    showMessage({ tone: 'danger', title: `${name} is too large to open.`, text: 'The Reader opens files up to 100 MB.', actions: [chooseFileAction('Choose another file')] });
  }

  /* ── Opening things ────────────────────────────────────────────────────── */

  // Whatever goes wrong while something opens, the Reader says so instead of staying busy.
  function guarded(open) {
    return async (...args) => {
      try {
        await open(...args);
      } catch (error) {
        console.warn('Skimbold Reader: that could not be opened.', error);
        abortLoad();
        showMessage({
          tone: 'danger',
          title: 'That could not be opened.',
          text: 'Something in it tripped the Reader up. Try another file, or paste the text instead.',
          actions: [chooseFileAction()],
        });
      }
    };
  }

  const openText = guarded(openTextNow);
  const openFile = guarded(openFileNow);
  const openPdfUrl = guarded(openPdfUrlNow);

  // `isPrivate`: text from a private window, which the Reader shows but does not keep.
  async function openTextNow(text, { title, kind, isCurrent = null, source = '', isPrivate = false }) {
    if (text.length > MAX_BYTES) {
      showMessage({ tone: 'danger', title: 'That text is too long to open.', text: 'The Reader opens up to 100 MB of text at a time.' });
      return;
    }
    let current = isCurrent;
    if (!current) {
      abortLoad();
      const token = view.load;
      current = () => token === view.load;
    }
    if (text.length > 2e6) showBusy('Preparing the text…');
    const blocks = kind === 'md' ? await parseMarkdown(text, current) : await parseText(text, current);
    if (!blocks || !current()) return;
    setProgress(null);
    if (!blocks.length) {
      showMessage({ title: 'There is no text to read in that.', text: 'Paste or open something with words in it.' });
      return;
    }
    showDocument(makeDoc(title || titleFromText(text), kind, sectionsOf(blocks), { source, private: isPrivate }));
  }

  async function openFileNow(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      tooLarge(file.name);
      return;
    }
    abortLoad();
    const token = view.load;
    const isCurrent = () => token === view.load;
    showBusy(`Opening ${file.name}…`);
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      if (!isCurrent()) return;
      setProgress(null);
      showMessage({ tone: 'danger', title: `${file.name} could not be read.`, text: 'The file may have moved or be locked by another program.', actions: [chooseFileAction()] });
      return;
    }
    if (!isCurrent()) return;
    const kind = kindOfBytes(bytes, file.name, file.type);
    if (kind === 'pdf') {
      await openPdf(bytes, file.name, {});
      return;
    }
    if (!kind) {
      setProgress(null);
      showMessage({ tone: 'danger', title: `${file.name} isn't a file the Reader can open.`, text: 'It opens plain text, Markdown, HTML and PDF files.', actions: [chooseFileAction('Choose another file')] });
      return;
    }
    const text = decodeText(bytes, kind);
    if (kind === 'html') {
      const blocks = await parseHtml(text, isCurrent);
      if (!blocks || !isCurrent()) return;
      setProgress(null);
      if (!blocks.length) {
        showMessage({ title: `${file.name} has no text to read.`, actions: [chooseFileAction('Choose another file')] });
        return;
      }
      showDocument(makeDoc(file.name, 'html', sectionsOf(blocks)));
      return;
    }
    await openText(text, { title: file.name, kind, isCurrent });
  }

  function pageSection(page) {
    const blocks = [];
    for (const block of page.blocks) {
      if (block.type === 'h') blocks.push({ t: 'h', l: block.level || 2, x: block.text });
      else for (const x of splitLong(block.text)) blocks.push({ t: 'p', x });
    }
    if (page.noText) blocks.push({ t: 'note', x: 'No selectable text on this page.' });
    return { label: `Page ${page.page}`, blocks };
  }

  function pdfFailure(error, name) {
    if (missingFeature(error)) return browserTooOld();
    if (error && error.name === 'InvalidPDFException') {
      return { tone: 'danger', title: `${name} isn't a PDF the Reader can open.`, text: 'The file may be damaged or not really a PDF.', actions: [chooseFileAction('Choose another file')] };
    }
    return { tone: 'danger', title: `${name} could not be read.`, text: 'The PDF may be damaged, or use features the Reader doesn’t support.', actions: [chooseFileAction('Choose another file')] };
  }

  // `source` is the query (?pdf=…) the PDF came from, when it came from one; `isPrivate`
  // marks a PDF from a private window (see remember).
  async function openPdf(bytes, name, { password, source = '', isPrivate = false }) {
    abortLoad();
    const token = view.load;
    const isCurrent = () => token === view.load;
    const controller = new AbortController();
    view.controller = controller;
    if (!canRunPdfJs()) {
      setProgress(null);
      showMessage(browserTooOld());
      return;
    }
    showBusy(`Opening ${name}…`);
    let lib;
    try {
      lib = await loadPdfJs();
    } catch (error) {
      if (!isCurrent()) return;
      console.warn('Skimbold Reader: pdf.js failed to load.', error);
      setProgress(null);
      showMessage(missingFeature(error) ? browserTooOld() : { tone: 'danger', title: 'The PDF reader could not start.', text: 'Reload the page and try again.' });
      return;
    }
    if (!isCurrent()) return;

    const doc = makeDoc(name, 'pdf', [], { complete: false, pages: 0, source, private: isPrivate });
    let shown = false;
    const waitingForText = [];
    let read = 0;
    const showReading = () => {
      els.docLoading.hidden = read >= doc.pages;
      els.docLoading.textContent = `Reading page ${formatNumber(read + 1)} of ${formatNumber(doc.pages)}…`;
    };
    const onProgress = ({ page, pages }) => {
      if (!isCurrent()) return;
      doc.pages = pages;
      read = page;
      setProgress(page / pages);
      if (shown) showReading();
    };
    const onPage = (page) => {
      if (!isCurrent()) return;
      const section = pageSection(page);
      // Hold back pages without text until it is clear the PDF has some at all.
      if (!shown && page.noText) {
        waitingForText.push(section);
        return;
      }
      if (!shown) {
        shown = true;
        showDocument(doc);
        showReading();
        doc.sections.push(...waitingForText.splice(0));
      }
      doc.sections.push(section);
      wake();
    };

    try {
      await Skimbold.pdfText.extractPdfParagraphs(lib, bytes.slice(), { password, signal: controller.signal, onProgress, onPage });
    } catch (error) {
      if (!isCurrent() || (error && error.name === 'AbortError')) return;
      setProgress(null);
      if (error && error.name === 'PasswordException') {
        askPassword(bytes, name, { source, isPrivate }, error.code === 2);
        return;
      }
      if (!shown) {
        showMessage(pdfFailure(error, name));
        return;
      }
      doc.sections.push({ blocks: [{ t: 'note', x: 'The rest of this PDF could not be read.' }] });
    }
    if (!isCurrent()) return;
    setProgress(null);
    view.controller = null;
    if (!shown) {
      showMessage({
        title: 'This PDF has no selectable text — it may be a scanned image.',
        text: 'Skimbold can only bold text that is stored as text. Run the scan through a text-recognition (OCR) tool first, then open the result here.',
        actions: [chooseFileAction('Choose another file')],
      });
      return;
    }
    doc.complete = true;
    announce(`Opened ${name}, ${plural(doc.pages, 'page', 'pages')}`);
    wake();
  }

  function askPassword(bytes, name, { source, isPrivate }, wrong) {
    const form = el('form', 'rd-password');
    const label = el('label', 'skb-field__label', `Password for ${name}`);
    label.htmlFor = 'rd-password-input';
    const input = el('input', 'skb-input');
    input.type = 'password';
    input.id = 'rd-password-input';
    input.required = true;
    input.autocomplete = 'off';
    const submit = el('button', 'skb-btn skb-btn--primary', 'Open');
    submit.type = 'submit';
    const cancel = el('button', 'skb-btn skb-btn--ghost', 'Cancel');
    cancel.type = 'button';
    const row = el('div', 'rd-password__row');
    row.append(input, submit, cancel);
    form.append(label, row);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value) openPdf(bytes, name, { password: input.value, source, isPrivate });
    });
    cancel.addEventListener('click', () => showHome());
    showMessage({
      tone: wrong ? 'danger' : 'info',
      title: wrong ? 'That password didn’t work. Try again.' : 'This PDF is protected with a password.',
      text: wrong ? '' : 'Enter it to read the PDF here. It stays on this device.',
      content: form,
    });
    input.focus();
  }

  async function openPdfUrlNow(raw, tabId, isPrivate) {
    let url = null;
    try {
      url = new URL(raw, location.href);
    } catch {
      url = null;
    }
    if (!url || !['http:', 'https:', 'file:'].includes(url.protocol)) {
      showMessage({ tone: 'danger', title: 'That PDF link isn’t valid.', actions: [chooseFileAction('Choose the PDF')] });
      return;
    }
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    let name = last || url.hostname || 'PDF';
    try {
      name = decodeURIComponent(name);
    } catch {
      // Malformed escapes: keep the name as written.
    }
    abortLoad();
    const token = view.load;
    const local = url.protocol === 'file:';
    let result = null;
    if (!local) {
      showBusy(`Opening ${name}…`);
      if (isExtension && api.scripting && Number.isInteger(tabId) && tabId >= 0) result = await fetchViaTab(tabId, url.href);
      if (!result && token === view.load) result = await fetchDirect(url.href);
    }
    if (token !== view.load) return;
    setProgress(null);
    if (result && result.error === 'too-large') {
      tooLarge(name);
      return;
    }
    if (!result || !result.bytes) {
      showMessage({
        title: 'Choose the PDF to read it here.',
        text: local
          ? 'Your browser doesn’t let extensions read files on your computer directly. Choose the same file and it opens here.'
          : 'The site didn’t let Skimbold download this PDF. Save it to your computer, then choose it or drop it on this page.',
        actions: [chooseFileAction('Choose the PDF')],
      });
      return;
    }
    await openPdf(result.bytes, name, { source: location.search, isPrivate });
  }

  async function openSession(key, isPrivate) {
    let text = null;
    try {
      const got = await api.storage.session.get(key);
      text = got ? got[key] : null;
      await api.storage.session.remove(key);
    } catch {
      text = null;
    }
    if (typeof text === 'string' && text.trim()) {
      await openText(text, { kind: 'selection', source: location.search, isPrivate });
      return;
    }
    showHome({ focus: false });
    showMessage({ title: 'The selected text is no longer available.', text: 'Select it again and choose “Open selection in Skimbold Reader”.' });
  }

  // The address keeps ?pdf= or ?session= while it describes what is on screen,
  // so the link can be shared and a reload comes back to the same document.
  function syncQuery(doc) {
    if (location.search && doc.source !== location.search) history.replaceState(null, '', location.pathname);
  }

  function openPicker() {
    els.file.value = '';
    els.file.click();
  }

  async function pasteFromClipboard() {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          await openText(text, { kind: 'paste' });
          return;
        }
      } catch {
        // No clipboard access; the paste box below still takes Ctrl+V.
      }
    }
    if (els.home.hidden) showHome({ focus: false });
    els.input.focus();
    announce(`Press ${MOD}+V to paste.`);
  }

  /* ── Settings ──────────────────────────────────────────────────────────── */

  function merged(base, patch) {
    return store.sanitize({ ...base, ...patch, reader: { ...base.reader, ...(patch.reader || {}) } });
  }

  // Applies a change at once and saves it after `delay` ms, so dragging a
  // slider or holding + writes once rather than on every step.
  function change(patch, delay = 0) {
    pendingPatch = pendingPatch
      ? { ...pendingPatch, ...patch, reader: { ...(pendingPatch.reader || {}), ...(patch.reader || {}) } }
      : patch;
    applySettings(merged(settings, patch));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, delay);
  }

  async function flushSave() {
    const patch = pendingPatch;
    pendingPatch = null;
    if (!patch) return;
    savesInFlight++;
    let saved = null;
    try {
      saved = await store.save(patch);
    } catch (error) {
      console.warn('Skimbold Reader: settings could not be saved.', error);
    }
    savesInFlight--;
    if (saved && !pendingPatch && !savesInFlight) applySettings(saved);
  }

  function onStoredChange(next) {
    // A change of ours is still on its way; its own result will be applied.
    if (pendingPatch || savesInFlight) return;
    applySettings(next);
  }

  function syncRange(range, output, text) {
    const pct = ((Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
    range.style.setProperty('--skb-fill', `${clamp(pct, 0, 100)}%`);
    output.textContent = text;
  }

  function checkRadio(name, value) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
  }

  function applySettings(next) {
    settings = next;
    const r = next.reader;
    applyTheme(r.theme);
    storageSet('localStorage', THEME_KEY, r.theme);
    const root = document.documentElement;
    root.style.setProperty('--rd-size', `${r.fontSize}px`);
    root.style.setProperty('--rd-leading', String(r.lineHeight));
    root.style.setProperty('--rd-measure', `${r.width}px`);
    root.style.setProperty('--rd-font', r.font === 'sans' ? 'var(--skb-font-ui)' : 'var(--skb-font-read)');
    root.style.setProperty('--rd-weight', String(next.weight));
    root.style.setProperty('--rd-rest', `${100 - next.fade}%`);
    root.dataset.bold = r.bold ? 'on' : 'off';

    checkRadio('rd-letters', next.mode === 'auto' ? 'auto' : String(next.letters));
    els.strengthField.hidden = next.mode !== 'auto';
    els.strength.value = String(next.strength);
    syncRange(els.strength, els.strengthValue, String(next.strength));
    checkRadio('rd-theme', r.theme);
    checkRadio('rd-font', r.font);
    els.sizeValue.textContent = `${r.fontSize} px`;
    els.sizeDown.disabled = r.fontSize <= SIZES[0];
    els.sizeUp.disabled = r.fontSize >= SIZES[SIZES.length - 1];
    els.leading.value = String(r.lineHeight);
    syncRange(els.leading, els.leadingValue, r.lineHeight.toFixed(2).replace(/0$/, ''));
    els.width.value = String(r.width);
    syncRange(els.width, els.widthValue, `${r.width} px`);
    els.bold.checked = r.bold;

    const opts = transformOptions(next);
    const key = JSON.stringify(opts);
    if (key !== view.optsKey) {
      view.optsKey = key;
      view.opts = opts;
      renderHomeText();
      if (view.blocks.length) rerender();
    }
  }

  function stepSize(direction) {
    const current = settings.reader.fontSize;
    const next = direction > 0 ? SIZES.find((size) => size > current) : SIZES.slice().reverse().find((size) => size < current);
    if (next === undefined) return;
    change({ reader: { fontSize: next } }, SAVE_DELAY);
    if (!els.display.matches(':popover-open')) announce(`Text size ${next} pixels`);
  }

  function renderHomeText() {
    fill(els.homeTitle, HOME_TITLE, {});
    fill(els.homeLead, HOME_LEAD, {});
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  function isTyping(target) {
    if (!target || !target.closest) return false;
    if (target.isContentEditable) return true;
    const field = target.closest('input, textarea, select');
    if (!field) return false;
    return field.localName !== 'input' || !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes(field.type);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && key.toLowerCase() === 'o') {
      event.preventDefault();
      openPicker();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (key === 'b' || key === 'B') {
      event.preventDefault();
      change({ reader: { bold: !settings.reader.bold } });
      announce(settings.reader.bold ? 'Bold on' : 'Bold off');
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      stepSize(1);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      stepSize(-1);
    }
  }

  function onPaste(event) {
    const data = event.clipboardData;
    if (!data || els.home.hidden) return;
    const inBox = event.target === els.input;
    if (inBox ? els.input.value.trim() !== '' : isTyping(event.target)) return;
    const file = data.files && data.files[0];
    const text = data.getData('text/plain');
    if (text && text.trim()) {
      event.preventDefault();
      openText(text, { kind: 'paste' });
    } else if (file) {
      event.preventDefault();
      openFile(file);
    }
  }

  function carriesDrop(event) {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
    return !internalDrag && (types.includes('Files') || types.includes('text/plain'));
  }

  function bindDragAndDrop() {
    document.addEventListener('dragstart', () => {
      internalDrag = true;
    });
    document.addEventListener('dragend', () => {
      internalDrag = false;
    });
    window.addEventListener('dragenter', (event) => {
      if (!carriesDrop(event)) return;
      event.preventDefault();
      dragDepth++;
      els.dropzone.hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (!carriesDrop(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
      if (!carriesDrop(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) els.dropzone.hidden = true;
    });
    window.addEventListener('drop', (event) => {
      dragDepth = 0;
      els.dropzone.hidden = true;
      if (!carriesDrop(event)) return;
      event.preventDefault();
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) {
        openFile(file);
        return;
      }
      const text = event.dataTransfer.getData('text/plain');
      if (text && text.trim()) openText(text, { kind: 'paste' });
    });
  }

  function bindControls() {
    els.letters.addEventListener('change', (event) => {
      const value = event.target.value;
      change(value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', letters: Number(value) });
    });
    els.strength.addEventListener('input', () => change({ strength: Number(els.strength.value) }, SAVE_DELAY));
    els.theme.addEventListener('change', (event) => change({ reader: { theme: event.target.value } }));
    els.font.addEventListener('change', (event) => change({ reader: { font: event.target.value } }));
    els.sizeDown.addEventListener('click', () => stepSize(-1));
    els.sizeUp.addEventListener('click', () => stepSize(1));
    els.leading.addEventListener('input', () => change({ reader: { lineHeight: Number(els.leading.value) } }, SAVE_DELAY));
    els.width.addEventListener('input', () => change({ reader: { width: Number(els.width.value) } }, SAVE_DELAY));
    els.bold.addEventListener('change', () => change({ reader: { bold: els.bold.checked } }));
    els.display.addEventListener('toggle', (event) => {
      els.displayToggle.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
  }

  function bindEvents() {
    bindControls();
    bindDragAndDrop();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('paste', onPaste);
    els.homeButton.addEventListener('click', () => showHome());
    els.open.addEventListener('click', openPicker);
    els.choose.addEventListener('click', openPicker);
    els.endOpen.addEventListener('click', openPicker);
    els.endClose.addEventListener('click', () => showHome());
    els.paste.addEventListener('click', pasteFromClipboard);
    els.file.addEventListener('change', () => {
      const file = els.file.files && els.file.files[0];
      if (file) openFile(file);
    });
    els.input.addEventListener('input', () => {
      els.read.disabled = !els.input.value.trim();
    });
    const readTyped = () => {
      const text = els.input.value;
      if (!text.trim()) return;
      els.input.value = '';
      els.read.disabled = true;
      openText(text, { kind: 'typed' });
    };
    els.read.addEventListener('click', readTyped);
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        readTyped();
      }
    });
    els.continueOpen.addEventListener('click', () => {
      const doc = loadRemembered();
      if (doc) showDocument(doc, { restore: true });
      else updateContinue();
    });
    els.forget.addEventListener('click', () => {
      forget();
      updateContinue();
      announce('The saved document is forgotten.');
      els.homeTitle.focus();
    });
    window.addEventListener('scroll', () => {
      els.bar.classList.toggle('is-scrolled', window.scrollY > 2);
      if (!positionTimer && view.doc) positionTimer = setTimeout(savePosition, 500);
    }, { passive: true });
    window.addEventListener('pagehide', flushPosition);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPosition();
    });
  }

  function bindElements() {
    const byId = (id) => document.getElementById(id);
    Object.assign(els, {
      bar: byId('rd-bar'),
      barTitle: byId('rd-bar-title'),
      homeButton: byId('rd-home'),
      open: byId('rd-open'),
      paste: byId('rd-paste'),
      bold: byId('rd-bold'),
      displayToggle: byId('rd-display-toggle'),
      display: byId('rd-display'),
      progress: byId('rd-progress'),
      progressFill: byId('rd-progress-fill'),
      letters: byId('rd-letters'),
      strengthField: byId('rd-strength-field'),
      strength: byId('rd-strength'),
      strengthValue: byId('rd-strength-value'),
      sharedHint: byId('rd-shared-hint'),
      webNote: byId('rd-web-note'),
      theme: byId('rd-theme'),
      font: byId('rd-font'),
      sizeDown: byId('rd-size-down'),
      sizeUp: byId('rd-size-up'),
      sizeValue: byId('rd-size-value'),
      leading: byId('rd-leading'),
      leadingValue: byId('rd-leading-value'),
      width: byId('rd-width'),
      widthValue: byId('rd-width-value'),
      home: byId('rd-home-view'),
      homeTitle: byId('rd-home-title'),
      homeLead: byId('rd-home-lead'),
      message: byId('rd-message'),
      continue: byId('rd-continue'),
      continueTitle: byId('rd-continue-title'),
      continueMeta: byId('rd-continue-meta'),
      continueOpen: byId('rd-continue-open'),
      forget: byId('rd-forget'),
      input: byId('rd-input'),
      read: byId('rd-read'),
      choose: byId('rd-choose'),
      doc: byId('rd-doc'),
      docTitle: byId('rd-doc-title'),
      docMeta: byId('rd-doc-meta'),
      docBody: byId('rd-doc-body'),
      docLoading: byId('rd-doc-loading'),
      docEnd: byId('rd-doc-end'),
      endOpen: byId('rd-end-open'),
      endClose: byId('rd-end-close'),
      file: byId('rd-file'),
      dropzone: byId('rd-dropzone'),
      status: byId('rd-status'),
    });
  }

  function useMacLabels() {
    if (!isMac) return;
    for (const kbd of document.querySelectorAll('kbd[data-mod]')) kbd.textContent = MOD;
    els.open.title = 'Open a file (⌘O)';
  }

  // The website's Reader only follows ?pdf= links to its own site: anyone could link people to
  // the official Reader showing a PDF of theirs. The extension's comes from a tab you are on.
  function mayOpenPdfLink(raw) {
    if (isExtension) return true;
    try {
      return new URL(raw, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  async function route() {
    // A reload keeps you in the document you were reading: a ?pdf= link is not
    // fetched again, and a ?session= selection (read once, then deleted) survives.
    // So does one reopened with "Continue reading", whose own link is not in the address.
    const saved = loadRemembered();
    if (saved && storageGet('sessionStorage', OPEN_KEY) === saved.id
        && (!location.search || (saved.source || '') === location.search)) {
      showDocument(saved, { restore: true });
      return;
    }
    const params = new URLSearchParams(location.search);
    const session = params.get('session');
    const pdf = params.get('pdf');
    const isPrivate = params.get('private') === '1';
    if (session && isExtension && api.storage && api.storage.session) {
      await openSession(session, isPrivate);
      return;
    }
    if (pdf && !mayOpenPdfLink(pdf)) {
      showHome({ focus: false });
      showMessage({
        title: 'This Reader opens the files you choose.',
        text: 'To read a PDF from another site, download it, then choose it or drop it on this page.',
        actions: [chooseFileAction('Choose the PDF')],
      });
      return;
    }
    if (pdf) {
      showHome({ focus: false });
      await openPdfUrl(pdf, params.has('tab') ? Number(params.get('tab')) : NaN, isPrivate);
      return;
    }
    showHome({ focus: false });
  }

  async function init() {
    // The Reader puts you back where you were itself, after its text is in place.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    bindElements();
    useMacLabels();
    els.sharedHint.hidden = !isExtension;
    // On the website the Reader is often the first thing a visitor opens.
    els.webNote.hidden = isExtension;
    applySettings(await store.load());
    store.onChange(onStoredChange);
    bindEvents();
    await route();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
