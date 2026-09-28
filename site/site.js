/*
 * Skimbold website: the live demo, the headline's first-load moment and the "Skimbold this
 * page" switch. Everything runs on the extension's own algorithm (shared/core.js). The page
 * makes no network requests and stores nothing.
 *
 * Loaded without defer, so the class below is set before first paint and the headline never
 * flashes from bold to plain. The rest waits for DOMContentLoaded, after core.js (deferred).
 */
(function () {
  'use strict';

  const reduceMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) document.documentElement.classList.add('js');

  // Elements whose text stays as it is, matching what the extension leaves alone.
  const SKIP = 'script, style, noscript, textarea, input, select, option, button, code, pre, kbd, samp, var, svg, [data-skimbold-skip], .skb-wordmark, .skim';

  function partsToFragment(parts) {
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (part.b) {
        const bold = document.createElement('b');
        bold.textContent = part.t;
        fragment.append(bold);
      } else {
        fragment.append(part.t);
      }
    }
    return fragment;
  }

  function syncRange(range, output, unit) {
    const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty('--skb-fill', `${pct}%`);
    output.textContent = `${range.value}${unit}`;
  }

  function playHeadline() {
    const starts = document.querySelectorAll('.hero__title b');
    if (reduceMotion) return;
    // One word at a time, like a page turning on with Alt+R.
    starts.forEach((start, i) => {
      setTimeout(() => start.classList.add('is-on'), 350 + i * 110);
    });
  }

  function setUp() {
    playHeadline();

    // Without the algorithm the demo stays empty, but the rest of the page still works.
    const core = globalThis.Skimbold && globalThis.Skimbold.core;
    if (!core) return;

    const textarea = document.getElementById('demo-text');
    const preview = document.getElementById('demo-preview');
    const strength = document.getElementById('strength');
    const strengthOut = document.getElementById('strength-value');
    const fade = document.getElementById('fade');
    const fadeOut = document.getElementById('fade-value');
    const letters = document.querySelector('.demo .skb-seg');
    const pageSwitch = document.getElementById('page-switch');

    function options() {
      const choice = letters.querySelector('input:checked').value;
      return choice === 'auto'
        ? { mode: 'auto', strength: Number(strength.value) }
        : { mode: 'fixed', letters: Number(choice) };
    }

    function renderPreview() {
      const text = textarea.value;
      if (text.trim() === '') {
        const hint = document.createElement('span');
        hint.className = 'skb-muted';
        hint.textContent = 'Type or paste some text to see it here.';
        preview.replaceChildren(hint);
        return;
      }
      const parts = core.transform(text, options(), { count: 0 });
      preview.replaceChildren(parts ? partsToFragment(parts) : text);
    }

    // The masthead switch: the same treatment on this page's own text, fully reversible.
    let wrapped = [];

    function skimPage() {
      const opts = options();
      const state = { count: 0 };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.data.trim() === '') return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          return parent && !parent.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const parts = core.transform(node.data, opts, state);
        if (!parts) continue;
        const wrapper = document.createElement('span');
        wrapper.className = 'skim';
        wrapper.append(partsToFragment(parts));
        node.replaceWith(wrapper);
        wrapped.push([node, wrapper]);
      }
    }

    function unskimPage() {
      for (const [node, wrapper] of wrapped) wrapper.replaceWith(node);
      wrapped = [];
    }

    let frame = 0;
    function update() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const auto = options().mode === 'auto';
        strength.disabled = !auto;
        syncRange(strength, strengthOut, '');
        syncRange(fade, fadeOut, '%');
        document.documentElement.style.setProperty('--fade', `${fade.value}%`);
        renderPreview();
        if (pageSwitch.checked) {
          unskimPage();
          skimPage();
        }
      });
    }

    textarea.addEventListener('input', update);
    letters.addEventListener('change', update);
    strength.addEventListener('input', update);
    fade.addEventListener('input', update);
    pageSwitch.addEventListener('change', () => {
      if (pageSwitch.checked) skimPage();
      else unskimPage();
    });
    pageSwitch.closest('label').hidden = false;
    update();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUp);
  else setUp();
})();
