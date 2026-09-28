/*
 * Skimbold PDF text: turns the positioned text runs that pdf.js reports into
 * readable paragraphs and headings, page by page.
 *
 * Runs are grouped into rows by baseline, rows are cut into fragments at wide
 * gaps, and fragments are ordered column by column when a page has two clear
 * columns. Lines then join into paragraphs by vertical gap, indentation, list
 * markers and where the previous line stopped. Running headers and footers
 * (the same text at the same height on most pages) are dropped.
 *
 * Classic script: attaches Skimbold.pdfText and has a UMD tail for Node.
 * pdf.js itself is passed in, so this file never loads anything.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold || (globalThis.Skimbold = {});

  // Pages read ahead of the page being finished. Running headers can only be
  // recognised once several pages have been seen.
  const LOOKAHEAD = 8;
  // Rows this close to the top or bottom edge may be running headers or footers.
  const MARGIN_BAND = 0.12;
  // Text turned more than this (radians) is a stamp, watermark or side note.
  const MAX_ANGLE = 0.05;
  const HEADING_RATIO = 1.15;
  const MAX_HEADING_CHARS = 250;

  // Bullets (any symbol character, e.g. • ➢ ✓), "1." "a)" "iv." and section numbers like "2.3.1".
  const LIST_MARKER = /^(?:[\p{So}•◦‣⁃∙·–—*+-]|\(?(?:\d{1,3}|[a-zA-Z]|[ivx]{2,4}|[IVX]{2,4})[.)]|\d+(?:\.\d+)+)\s/u;
  // A table-of-contents entry: dot leaders, then a page number.
  const TOC_ENTRY = /(?:\.\s?){4,}\s*\d+$|…{2,}\s*\d+$/u;
  const ENDS_WITH_HYPHEN = /\p{L}[-\u2010\u00AD]$/u;
  const STARTS_LOWER = /^\p{Ll}/u;
  const SENTENCE_END = /[.!?:;…"'”’)\]]$/u;
  // Scripts written without spaces between words: CJK, kana, Hangul, full-width forms.
  const CJK = /[\u3000-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;

  function median(values) {
    if (values.length === 0) return NaN;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function percentile(values, p) {
    if (values.length === 0) return NaN;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  function collapse(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Page numbers change from page to page; the rest of a running header does not.
  function signature(text) {
    return collapse(text).toLowerCase().replace(/\d+/g, '#').replace(/^[ivxlcdm]+$/, '#');
  }

  /* ── Runs and rows ─────────────────────────────────────────────────────── */

  // Appends run text to a line, adding a space where the runs do not touch.
  function appendRun(text, prevEnd, run) {
    if (text === '') return run.str;
    const gap = run.x - prevEnd;
    const needsSpace = gap > run.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(run.str);
    return needsSpace ? text + ' ' + run.str : text + run.str;
  }

  function textOf(runs) {
    let text = '';
    let end = -Infinity;
    for (const run of runs) {
      text = appendRun(text, end, run);
      end = Math.max(end, run.x + run.w);
    }
    return collapse(text);
  }

  // The size carrying the most characters, so a superscript never sets a line's size.
  function dominantSize(runs) {
    const weight = new Map();
    let best = runs[0].size;
    let bestWeight = 0;
    for (const run of runs) {
      const key = Math.round(run.size * 2) / 2;
      const total = (weight.get(key) || 0) + run.str.length;
      weight.set(key, total);
      if (total > bestWeight) {
        best = key;
        bestWeight = total;
      }
    }
    return best;
  }

  function makeLine(runs) {
    const rtl = runs.filter((run) => run.rtl).length > runs.length / 2;
    runs.sort(rtl ? (a, b) => b.x - a.x : (a, b) => a.x - b.x);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const run of runs) {
      x0 = Math.min(x0, run.x);
      x1 = Math.max(x1, run.x + run.w);
    }
    const size = dominantSize(runs);
    const main = runs.find((run) => Math.round(run.size * 2) / 2 === size) || runs[0];
    return { runs, x0, x1, y: main.y, size, text: textOf(runs) };
  }

  // Groups runs into rows that share a baseline. A superscript sits a little
  // above the baseline, so the tolerance is half the smaller font size.
  function groupRows(runs) {
    runs.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    let current = null;
    for (const run of runs) {
      if (current && Math.abs(run.y - current.y) <= 0.5 * Math.min(run.size, current.size)) {
        current.runs.push(run);
        if (run.size > current.size) {
          current.size = run.size;
          current.y = run.y;
        }
      } else {
        current = { runs: [run], y: run.y, size: run.size };
        rows.push(current);
      }
    }
    return rows.map((row) => makeLine(row.runs));
  }

  function readPage(Util, content, viewport, number) {
    const runs = [];
    for (const item of content.items) {
      if (typeof item.str !== 'string' || item.str.trim() === '') continue;
      const tx = Util.transform(viewport.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]);
      if (!(size > 0.5)) continue;
      if (Math.abs(Math.atan2(tx[1], tx[0])) > MAX_ANGLE) continue;
      runs.push({ str: item.str, x: tx[4], y: tx[5], w: Math.abs(item.width) || 0, size, rtl: item.dir === 'rtl' });
    }
    const rows = groupRows(runs);
    const height = viewport.height;
    for (const row of rows) {
      // A header often pairs a fixed title with a changing chapter name or page
      // number, so each separate piece of a margin row is judged on its own.
      if (row.y < height * MARGIN_BAND || row.y > height * (1 - MARGIN_BAND)) {
        row.parts = fragmentsOf([row]).map((part) => ({ runs: part.runs, y: part.y, sig: signature(part.text) }));
      }
    }
    return { number, width: viewport.width, height, rows, hasText: runs.length > 0 };
  }

  /* ── Document statistics, from the pages read so far ───────────────────── */

  function createStats() {
    return {
      pages: 0,
      sizeWeight: new Map(),
      spacing: [],
      margins: new Map(), // signature → [{ page, y }]
    };
  }

  function addToStats(stats, page) {
    stats.pages++;
    const seen = new Set();
    let prev = null;
    for (const row of page.rows) {
      for (const run of row.runs) {
        const key = Math.round(run.size * 2) / 2;
        stats.sizeWeight.set(key, (stats.sizeWeight.get(key) || 0) + run.str.length);
      }
      if (prev && !row.parts && !prev.parts && Math.abs(prev.size - row.size) < 0.05 * row.size) {
        const ratio = (row.y - prev.y) / row.size;
        if (ratio > 0.9 && ratio < 2.6 && stats.spacing.length < 4000) stats.spacing.push(ratio);
      }
      prev = row;
      for (const part of row.parts || []) {
        const key = part.sig + '@' + Math.round(part.y);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!stats.margins.has(part.sig)) stats.margins.set(part.sig, []);
        stats.margins.get(part.sig).push({ page: page.number, y: part.y });
      }
    }
  }

  function bodySize(stats) {
    let best = 0;
    let bestWeight = -1;
    for (const [size, weight] of stats.sizeWeight) {
      if (weight > bestWeight) {
        best = size;
        bestWeight = weight;
      }
    }
    return best || 10;
  }

  // Running text sits at the same height on most pages, or (a chapter title in
  // the header) on the pages around this one.
  function isRunning(stats, part, pageNumber) {
    const pages = new Set();
    let nearby = 0;
    for (const hit of stats.margins.get(part.sig) || []) {
      if (Math.abs(hit.y - part.y) > 3 || pages.has(hit.page)) continue;
      pages.add(hit.page);
      if (hit.page !== pageNumber && Math.abs(hit.page - pageNumber) <= 2) nearby++;
    }
    return pages.size >= 2 && (nearby > 0 || pages.size >= Math.ceil(stats.pages * 0.4));
  }

  // The page's rows without running headers and footers.
  function bodyRows(page, stats) {
    const rows = [];
    for (const row of page.rows) {
      if (!row.parts) {
        rows.push(row);
        continue;
      }
      const kept = row.parts.filter((part) => !isRunning(stats, part, page.number));
      if (kept.length === row.parts.length) rows.push(row);
      else if (kept.length) rows.push(makeLine(kept.flatMap((part) => part.runs)));
    }
    return rows;
  }

  /* ── Columns ───────────────────────────────────────────────────────────── */

  // Cuts rows into fragments wherever runs are far apart (a gutter or a tab stop).
  function fragmentsOf(rows) {
    const out = [];
    for (const row of rows) {
      let group = [row.runs[0]];
      let end = row.runs[0].x + row.runs[0].w;
      for (let i = 1; i < row.runs.length; i++) {
        const run = row.runs[i];
        if (run.x - end > run.size * 1.0) {
          out.push(makeLine(group));
          group = [];
        }
        group.push(run);
        end = Math.max(end, run.x + run.w);
      }
      out.push(makeLine(group));
    }
    return out;
  }

  // Finds the x of a gutter between two columns of body text, or NaN.
  function findGutter(fragments, width) {
    if (fragments.length < 6) return NaN;
    const from = Math.floor(width * 0.25);
    const to = Math.ceil(width * 0.75);
    // A gutter has plenty of text on both sides and little running across it.
    // A title spanning both columns crosses it, so crossings only lower the score.
    const scores = [];
    let best = -Infinity;
    for (let x = from; x <= to; x++) {
      let left = 0;
      let right = 0;
      for (const f of fragments) {
        if (f.x1 <= x) left++;
        else if (f.x0 >= x) right++;
      }
      const crossing = fragments.length - left - right;
      const score = crossing > fragments.length * 0.15 ? -Infinity : Math.min(left, right) - 2 * crossing;
      scores.push(score);
      best = Math.max(best, score);
    }
    if (!(best >= 3)) return NaN;
    // The widest stretch with the best score; its middle is the split.
    let bestStart = 0;
    let bestLength = 0;
    let start = -1;
    for (let i = 0; i <= scores.length; i++) {
      if (i < scores.length && scores[i] === best) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start > bestLength) {
          bestStart = start;
          bestLength = i - start;
        }
        start = -1;
      }
    }
    const at = from + bestStart + Math.floor((bestLength - 1) / 2);
    const left = fragments.filter((f) => f.x1 <= at);
    const right = fragments.filter((f) => f.x0 >= at);
    if (left.length < fragments.length * 0.2 || right.length < fragments.length * 0.2) return NaN;
    // Midway between the two groups, so both keep exactly the fragments counted above.
    const split = (Math.max(...left.map((f) => f.x1)) + Math.min(...right.map((f) => f.x0))) / 2;
    // Columns hold running text: most lines fill a good part of their column.
    const minX = Math.min(...left.map((f) => f.x0));
    const maxX = Math.max(...right.map((f) => f.x1));
    if (median(left.map((f) => f.x1 - f.x0)) < 0.5 * (split - minX)) return NaN;
    if (median(right.map((f) => f.x1 - f.x0)) < 0.5 * (maxX - split)) return NaN;
    // Side by side, not one above the other.
    const top = Math.max(Math.min(...left.map((f) => f.y)), Math.min(...right.map((f) => f.y)));
    const bottom = Math.min(Math.max(...left.map((f) => f.y)), Math.max(...right.map((f) => f.y)));
    if (bottom <= top) return NaN;
    return split;
  }

  // Joins the fragments of one flow that share a baseline back into lines.
  function linesOf(fragments) {
    const lines = [];
    let current = null;
    for (const f of fragments) {
      if (current && Math.abs(f.y - current.y) <= 0.5 * Math.min(f.size, current.size)) {
        current.parts.push(f);
      } else {
        current = { y: f.y, size: f.size, parts: [f] };
        lines.push(current);
      }
    }
    return lines.map((line) => (line.parts.length === 1
      ? line.parts[0]
      : makeLine(line.parts.flatMap((part) => part.runs))));
  }

  // Orders a page's fragments into flows: full-width pieces in place, and
  // between them the left column before the right one.
  function flowsOf(fragments, width) {
    const byY = (a, b) => a.y - b.y || a.x0 - b.x0;
    const split = findGutter(fragments, width);
    if (Number.isNaN(split)) return [{ lines: linesOf(fragments.slice().sort(byY)), column: false }];
    const flows = [];
    let left = [];
    let right = [];
    const flush = () => {
      if (left.length) flows.push({ lines: linesOf(left), column: true });
      if (right.length) flows.push({ lines: linesOf(right), column: true });
      left = [];
      right = [];
    };
    for (const f of fragments.slice().sort(byY)) {
      if (f.x1 <= split) left.push(f);
      else if (f.x0 >= split) right.push(f);
      else {
        flush();
        flows.push({ lines: [f], column: false });
      }
    }
    flush();
    // Consecutive full-width pieces belong to one flow.
    const merged = [];
    for (const flow of flows) {
      const last = merged[merged.length - 1];
      if (last && !last.column && !flow.column) last.lines.push(...flow.lines);
      else merged.push(flow);
    }
    return merged;
  }

  /* ── Paragraphs ────────────────────────────────────────────────────────── */

  function joinText(text, next) {
    if (text === '') return next;
    if (text.endsWith('\u00AD')) return text.slice(0, -1) + next;
    if (ENDS_WITH_HYPHEN.test(text)) {
      // "exam-" + "ple" is one word; "Jean-" + "Paul" keeps its hyphen.
      return STARTS_LOWER.test(next) ? text.slice(0, -1) + next : text + next;
    }
    if (CJK.test(text.slice(-1)) && CJK.test(next.charAt(0))) return text + next;
    return text + ' ' + next;
  }

  function mode(values) {
    const counts = new Map();
    let best = values[0];
    let bestCount = 0;
    for (const value of values) {
      const count = (counts.get(value) || 0) + 1;
      counts.set(value, count);
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }

  function firstWord(text) {
    const match = /^\S+/.exec(text);
    return match ? match[0] : '';
  }

  function paragraphsOf(lines, ctx) {
    if (lines.length === 0) return [];
    const body = lines.filter((line) => Math.abs(line.size - ctx.body) < 0.1 * ctx.body);
    const measured = body.length >= 3 ? body : lines;
    const left = mode(measured.map((line) => Math.round(line.x0)));
    const right = percentile(measured.map((line) => line.x1), 0.9);

    const paragraphs = [];
    let current = null;
    for (const line of lines) {
      const prev = current && current.lines[current.lines.length - 1];
      if (!prev || startsParagraph(prev, line, current, left, right, ctx)) {
        current = { lines: [line], size: line.size };
        paragraphs.push(current);
      } else {
        current.lines.push(line);
      }
    }
    return paragraphs;
  }

  function startsParagraph(prev, line, current, left, right, ctx) {
    const size = Math.max(prev.size, line.size);
    if (Math.abs(prev.size - line.size) > 0.12 * size) return true;
    const gap = line.y - prev.y;
    if (gap <= 0 || gap > ctx.spacing * line.size * 1.3) return true;
    if (LIST_MARKER.test(line.text) || TOC_ENTRY.test(prev.text)) return true;
    const em = line.size;
    const inList = LIST_MARKER.test(current.lines[0].text);
    // A first-line indent, or a line hanging left of the margin, opens a paragraph.
    if (!inList && line.x0 > left + 0.8 * em && line.x0 > prev.x0 + 0.8 * em) return true;
    if (line.x0 < left - 0.8 * em && line.x0 < prev.x0 - 0.8 * em) return true;
    // The previous line stopped although this line's first word would have fit.
    if (Math.abs(prev.size - ctx.body) < 0.1 * ctx.body && !ENDS_WITH_HYPHEN.test(prev.text)) {
      const word = firstWord(line.text);
      const charWidth = (line.x1 - line.x0) / Math.max(1, line.text.length);
      if (right - prev.x1 > word.length * charWidth + 0.6 * em) return true;
    }
    return false;
  }

  function toBlocks(paragraphs, ctx) {
    const blocks = [];
    let dropCap = '';
    for (const paragraph of paragraphs) {
      let text = '';
      for (const line of paragraph.lines) text = joinText(text, line.text);
      text = collapse(text);
      if (!text) continue;
      const ratio = paragraph.size / ctx.body;
      const heading = ratio >= HEADING_RATIO && text.length <= MAX_HEADING_CHARS && paragraph.lines.length <= 4;
      // A decorative first letter set large on its own belongs to the paragraph after it.
      if (heading && /^\p{Lu}$/u.test(text)) {
        dropCap = text;
        continue;
      }
      if (dropCap) {
        text = dropCap + text;
        dropCap = '';
      }
      if (heading) blocks.push({ type: 'h', level: ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3, text });
      else blocks.push({ type: 'p', text });
    }
    if (dropCap) blocks.push({ type: 'p', text: dropCap });
    return blocks;
  }

  // A paragraph that runs from the bottom of one column into the next continues.
  function continues(prevParagraph, nextParagraph) {
    const last = prevParagraph.lines[prevParagraph.lines.length - 1].text;
    const first = nextParagraph.lines[0].text;
    if (Math.abs(prevParagraph.size - nextParagraph.size) > 0.05 * nextParagraph.size) return false;
    if (LIST_MARKER.test(first)) return false;
    return ENDS_WITH_HYPHEN.test(last) || (!SENTENCE_END.test(last) && STARTS_LOWER.test(first));
  }

  function finishPage(page, stats) {
    const rows = bodyRows(page, stats);
    const ctx = { body: bodySize(stats), spacing: median(stats.spacing) || 1.45 };
    const flows = flowsOf(fragmentsOf(rows), page.width);
    const paragraphs = [];
    let prevFlow = null;
    for (const flow of flows) {
      const found = paragraphsOf(flow.lines, ctx);
      if (found.length && paragraphs.length && prevFlow && prevFlow.column && flow.column
          && continues(paragraphs[paragraphs.length - 1], found[0])) {
        paragraphs[paragraphs.length - 1].lines.push(...found.shift().lines);
      }
      paragraphs.push(...found);
      prevFlow = flow;
    }
    const result = { page: page.number, blocks: toBlocks(paragraphs, ctx) };
    if (!page.hasText) result.noText = true;
    return result;
  }

  /* ── Entry point ───────────────────────────────────────────────────────── */

  function abortError() {
    const error = new Error('The PDF was closed before it finished loading.');
    error.name = 'AbortError';
    return error;
  }

  /**
   * Extracts paragraphs from a PDF.
   * @param pdfjsLib  the pdf.js module (getDocument, Util)
   * @param data      Uint8Array of the file; pdf.js takes ownership of its buffer
   * @param options   onProgress({page, pages}) after each page is read,
   *                  onPage(result) as each page is finished, in order,
   *                  password, and signal (AbortSignal)
   * @returns Promise<[{page, blocks: [{type: 'p'|'h', text, level?}], noText?}]>
   * Rejects with pdf.js's PasswordException (name 'PasswordException', code 1 when a
   * password is needed, 2 when it was wrong) or InvalidPDFException.
   */
  async function extractPdfParagraphs(pdfjsLib, data, options) {
    const { onProgress, onPage, password, signal } = options || {};
    const task = pdfjsLib.getDocument({
      data,
      password,
      // pdf.js 6 no longer compiles fonts to code at all; this keeps that true
      // should the vendored build ever change.
      isEvalSupported: false,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    });
    const stop = () => task.destroy();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      const doc = await task.promise;
      const total = doc.numPages;
      const stats = createStats();
      const pending = [];
      const results = [];
      for (let number = 1; number <= total; number++) {
        if (signal && signal.aborted) throw abortError();
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        const read = readPage(pdfjsLib.Util, content, page.getViewport({ scale: 1 }), number);
        page.cleanup();
        addToStats(stats, read);
        pending.push(read);
        if (onProgress) onProgress({ page: number, pages: total });
        while (pending.length > LOOKAHEAD || (number === total && pending.length)) {
          const result = finishPage(pending.shift(), stats);
          results.push(result);
          if (onPage) onPage(result);
        }
      }
      return results;
    } catch (error) {
      if (signal && signal.aborted) throw abortError();
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
      task.destroy();
    }
  }

  const pdfText = { extractPdfParagraphs };
  Skimbold.pdfText = pdfText;

  if (typeof module === 'object' && module && module.exports) module.exports = pdfText;
})();
