// Helpers shared by the engine e2e specs (test/e2e/engine*.spec.mjs). They drive the content
// script directly from the service worker, so the tests never depend on background.js.

import { swEval, tabIdFor } from '../../e2e/fixtures.mjs';

export const ENGINE_FILES = ['shared/settings.js', 'shared/core.js', 'content/engine.js'];
export const AUTO_FILES = [...ENGINE_FILES, 'content/auto.js'];

/** Opens a fixture page and returns its tab id. */
export async function openFixture(page, serviceWorker, urlPath) {
  await page.goto(urlPath);
  return tabIdFor(serviceWorker, page);
}

/** Injects the engine's files into the tab, the way background.js does. */
export async function inject(serviceWorker, tabId, { allFrames = false, files = ENGINE_FILES } = {}) {
  await swEval(serviceWorker, async ({ id, all, list }) => {
    const api = globalThis.browser ?? globalThis.chrome;
    await api.scripting.executeScript({ target: { tabId: id, allFrames: all }, files: list });
  }, { id: tabId, all: allFrames, list: files });
}

/** Sends a message to every frame of the tab (or one frame) and returns the first reply. */
export function send(serviceWorker, tabId, message, frameId) {
  return swEval(serviceWorker, async ({ id, msg, frame }) => {
    const api = globalThis.browser ?? globalThis.chrome;
    return api.tabs.sendMessage(id, msg, frame === undefined ? {} : { frameId: frame });
  }, { id: tabId, msg: message, frame: frameId });
}

/** Turns the engine on or off in every frame through the message protocol; resolves to the reply. */
export function setActive(serviceWorker, tabId, active) {
  return send(serviceWorker, tabId, { type: 'skb:set', active });
}

/**
 * Runs fn(...args) in the content scripts' isolated world of each frame (Skimbold is visible
 * there, not in the page's world) and returns the results, top frame first.
 */
export async function isolated(serviceWorker, tabId, fn, args = [], { allFrames = false } = {}) {
  // executeScript needs a real function object in the worker, so fn's source (test code) is
  // spliced into the expression Playwright evaluates there, exactly as evaluate(fn) would do.
  const target = JSON.stringify({ tabId, allFrames });
  return serviceWorker.evaluate(`(async () => {
    const api = globalThis.browser ?? globalThis.chrome;
    const results = await api.scripting.executeScript({ target: ${target}, func: ${fn.toString()}, args: ${JSON.stringify(args)} });
    return results.sort((a, b) => a.frameId - b.frameId).map((result) => result.result);
  })()`);
}

/** Writes settings straight to storage.sync; the engine picks them up through onChange. */
export async function writeSettings(serviceWorker, partial) {
  await swEval(serviceWorker, async (value) => {
    const api = globalThis.browser ?? globalThis.chrome;
    await api.storage.sync.set({ settings: value });
  }, partial);
}

/** Waits for two animation frames plus a short pause, which covers the engine's per-frame batching. */
export function frames(page, pauseMs = 30) {
  return page.evaluate((pause) => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, pause)));
  }), pauseMs);
}

/**
 * Checks the engine's structural invariants in the page and returns a list of problems (empty when
 * all is well): every wrapper directly follows an empty text node, wrappers never nest, bold parts
 * only live in wrappers, and skip zones hold no wrappers.
 */
export function invariantProblems(page, rootSelector = 'body') {
  return page.evaluate((selector) => {
    const problems = [];
    const root = document.querySelector(selector);
    const zones = 'textarea,code,pre,kbd,samp,var,tt,svg,math,button,select,[contenteditable]:not([contenteditable="false"]),'
      + '[role="textbox"],[data-skimbold-skip],.monaco-editor,.CodeMirror,.cm-editor,.ace_editor,.xterm,mjx-container,.MathJax,.katex';
    for (const wrapper of root.querySelectorAll('skb-w')) {
      const before = wrapper.previousSibling;
      if (!before || before.nodeType !== Node.TEXT_NODE || before.data !== '') {
        problems.push(`wrapper without an empty source before it: "${wrapper.textContent.slice(0, 40)}"`);
      }
      if (wrapper.parentElement && wrapper.parentElement.closest('skb-w')) problems.push('nested wrapper');
      if (wrapper.parentElement && wrapper.parentElement.closest(zones)) problems.push(`wrapper inside a skip zone: ${wrapper.parentElement.outerHTML.slice(0, 80)}`);
    }
    for (const bold of root.querySelectorAll('skb-b')) {
      if (!bold.parentElement || bold.parentElement.localName !== 'skb-w') problems.push('bold part outside a wrapper');
    }
    return problems;
  }, rootSelector);
}
