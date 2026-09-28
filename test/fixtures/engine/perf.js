// Builds a long article (5,000 paragraphs and about 250,000 words by default; ?paragraphs=N for
// another size) and measures the main thread while the engine works on it: long tasks from
// PerformanceObserver, the largest gap seen by a 10 ms interval probe, the largest gap between
// animation frames (a running rAF loop, like a page with an animation), and the moments the last
// paragraph receives its wrapper (doneAt) and the first and last have both lost theirs (restoredAt).
(function () {
  'use strict';

  const PARAGRAPHS = Number(new URLSearchParams(location.search).get('paragraphs')) || 5000;
  const WORDS_PER_PARAGRAPH = 50;
  const WORDS = ('the tide keeper lantern harbour across morning evening water shore rocks anemone limpet '
    + 'weather northern current breakwater shingle estuary mooring saltmarsh fishermen returned '
    + 'with their catch before sunset while children counted crabs under curtains of seaweed and '
    + 'gulls circled above wooden jetties where old ropes lay coiled beside painted boats a of in on').split(' ');

  let seed = 11;
  function random() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }

  function sentence(count) {
    const words = [];
    for (let i = 0; i < count; i++) words.push(WORDS[Math.floor(random() * WORDS.length)]);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    return `${words.join(' ')}.`;
  }

  function build() {
    const article = document.getElementById('article');
    const fragment = document.createDocumentFragment();
    let words = 0;
    for (let i = 0; i < PARAGRAPHS; i++) {
      const p = document.createElement('p');
      if (i % 10 === 3) {
        p.append(sentence(20), ' ');
        const link = p.appendChild(document.createElement('a'));
        link.href = `#p${i}`;
        link.textContent = sentence(5);
        p.append(' ', sentence(25));
      } else {
        p.textContent = sentence(WORDS_PER_PARAGRAPH);
      }
      words += WORDS_PER_PARAGRAPH;
      fragment.appendChild(p);
    }
    const last = fragment.lastChild;
    last.id = 'last';
    article.appendChild(fragment);
    return { words, last };
  }

  const state = { ready: false, words: 0, paragraphs: PARAGRAPHS, doneAt: null, restoredAt: null };
  let longTasks = [];
  let observer = null;
  let probe = null;
  let maxGap = 0;
  let maxGapAt = 0;
  let lastBeat = 0;
  let measureStart = 0;
  let measuring = false;
  let maxFrameGap = 0;
  let frames = 0;
  let lastFrame = 0;

  function onFrame(now) {
    if (!measuring) return;
    maxFrameGap = Math.max(maxFrameGap, now - lastFrame);
    lastFrame = now;
    frames++;
    requestAnimationFrame(onFrame);
  }

  function startMeasure() {
    longTasks = [];
    maxGap = 0;
    measureStart = performance.now();
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    observer.observe({ type: 'longtask' });
    measuring = true;
    maxFrameGap = 0;
    frames = 0;
    lastFrame = performance.now();
    requestAnimationFrame(onFrame);
    lastBeat = performance.now();
    probe = setInterval(() => {
      const now = performance.now();
      if (now - lastBeat > maxGap) {
        maxGap = now - lastBeat;
        maxGapAt = lastBeat - measureStart;
      }
      lastBeat = now;
    }, 10);
  }

  function stopMeasure() {
    observer.takeRecords().forEach((entry) => longTasks.push(Math.round(entry.duration)));
    observer.disconnect();
    clearInterval(probe);
    measuring = false;
    return { longTasks, maxGap: Math.round(maxGap), maxGapAt: Math.round(maxGapAt), maxFrameGap: Math.round(maxFrameGap), frames };
  }

  document.addEventListener('DOMContentLoaded', () => {
    const { words, last } = build();
    state.words = words;
    // The engine works in document order, so the last paragraph is wrapped last; the restore
    // order is its own business, so it counts as done once neither end is wrapped.
    const first = document.querySelector('#article > p');
    const watcher = new MutationObserver(() => {
      if (state.doneAt === null) {
        if (last.querySelector('skb-w') !== null) state.doneAt = performance.now();
      } else if (state.restoredAt === null && first.querySelector('skb-w') === null && last.querySelector('skb-w') === null) {
        state.restoredAt = performance.now();
      }
    });
    watcher.observe(first, { childList: true });
    watcher.observe(last, { childList: true });
    requestAnimationFrame(() => requestAnimationFrame(() => { state.ready = true; }));
  });

  // Forgets doneAt and restoredAt, for another round of enable and disable.
  function reset() {
    state.doneAt = null;
    state.restoredAt = null;
  }

  window.perfFixture = Object.assign(state, { startMeasure, stopMeasure, reset });
})();
