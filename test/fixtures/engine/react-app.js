// A React 18 app that re-renders constantly: a counter every 10 ms, and every 50 ms new text, a
// keyed list that shuffles, grows and shrinks, subtrees that mount and unmount, and elements whose
// only child is a string (React writes those through textContent). It renders one store into
// #app, which the engine processes, and into #reference (data-skimbold-skip), which the engine
// never touches, so the two must always show the same text.
(function () {
  'use strict';

  const { createElement: h, useSyncExternalStore } = React;
  const WORDS = ['harbour', 'lantern', 'driftwood', 'compass', 'seagull', 'anchor', 'current', 'breakwater', 'shingle', 'estuary', 'mooring', 'saltmarsh'];
  const SENTENCES = [
    'Low water reveals the rock pools',
    'Crabs hide under curtains of weed',
    'The lighthouse keeper trims the wick',
    'Fog rolls in from the north-east',
    'Boats return before the evening tide',
    'Anemones close when the sea retreats',
    'Children count limpets on the breakwater',
  ];

  let seed = 7;
  function random() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }

  let nextId = 1;
  function makeItem() {
    const id = nextId++;
    return { id, label: `${WORDS[id % WORDS.length]} ${WORDS[(id * 7) % WORDS.length]}` };
  }

  let state = { fast: 0, tick: 0, openedAt: 0, show: true, items: Array.from({ length: 8 }, makeItem) };
  const listeners = new Set();
  const store = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
  };
  function update(change) {
    state = { ...state, ...change(state) };
    for (const listener of listeners) listener();
  }
  const useStore = () => useSyncExternalStore(store.subscribe, store.get);

  function nextList(items) {
    const list = items.slice();
    const i = Math.floor(random() * list.length);
    const j = Math.floor(random() * list.length);
    [list[i], list[j]] = [list[j], list[i]];
    if (list.length < 15 && random() < 0.6) list.splice(Math.floor(random() * (list.length + 1)), 0, makeItem());
    if (list.length > 5 && random() < 0.5) list.splice(Math.floor(random() * list.length), 1);
    return list;
  }

  function Headline() {
    const s = useStore();
    return h('h2', null, SENTENCES[s.tick % SENTENCES.length]);
  }

  function Counter() {
    const s = useStore();
    return h('p', { className: 'counter' }, 'Ticks so far: ', s.fast, ' and counting ', h('span', null, s.fast % 2 ? 'odd' : 'even'));
  }

  function Greeting() {
    const s = useStore();
    return h('p', null, 'Hello ', WORDS[s.tick % WORDS.length], ', you have ', s.tick, ' new messages about the ', WORDS[(s.tick * 5) % WORDS.length], '.');
  }

  function List() {
    const s = useStore();
    return h('ul', null, s.items.map((item) => h('li', { key: item.id }, item.label, ' number ', item.id)));
  }

  function Tide() {
    const s = useStore();
    return h('p', null, 'Water is ', s.tick % 2 ? h('em', null, 'rising fast') : 'falling slowly', ' along the shore');
  }

  function Details() {
    const s = useStore();
    if (!s.show) return h('p', null, 'Details are hidden for now');
    return h('section', null,
      h('h3', null, 'Tide details'),
      h('p', null, 'Opened at tick ', s.openedAt, ' while watching the ', WORDS[s.openedAt % WORDS.length], '.'),
      h(Tide));
  }

  function Remount() {
    const s = useStore();
    const shape = s.tick % 3;
    return h('div', { key: shape }, h('p', null, `Remounted block in shape ${shape} of three`));
  }

  function Markup() {
    const s = useStore();
    return h('div', { dangerouslySetInnerHTML: { __html: `<p>Static markup rendered <b>as a string</b> at tick ${s.tick % 4}</p>` } });
  }

  function App() {
    return h('main', null, h(Headline), h(Counter), h(Greeting), h(List), h(Details), h(Remount), h(Markup));
  }

  const timers = [];
  const mismatches = [];
  let mounted = false;

  function texts() {
    return { app: document.getElementById('app').innerText, reference: document.getElementById('reference').innerText };
  }

  // Runs after React's commit microtask and the engine's observer microtask, just before the
  // next task could paint or read the page.
  function sample() {
    const { app, reference } = texts();
    if (app !== reference && mismatches.length < 5) mismatches.push({ app, reference });
  }

  function resume() {
    if (timers.length > 0) return;
    timers.push(setInterval(() => update((s) => ({ fast: s.fast + 1 })), 10));
    timers.push(setInterval(() => {
      update((s) => {
        const tick = s.tick + 1;
        const show = tick % 7 < 4;
        return { tick, show, openedAt: show && !s.show ? tick : s.openedAt, items: nextList(s.items) };
      });
      setTimeout(sample, 0);
    }, 50));
  }

  function pause() {
    while (timers.length > 0) clearInterval(timers.pop());
  }

  function start() {
    if (mounted) return;
    mounted = true;
    ReactDOM.createRoot(document.getElementById('app')).render(h(App));
    ReactDOM.createRoot(document.getElementById('reference')).render(h(App));
    resume();
  }

  window.reactFixture = { start, pause, resume, texts, mismatches, ticks: () => state.tick };
  if (!location.search.includes('manual')) document.addEventListener('DOMContentLoaded', start);
})();
