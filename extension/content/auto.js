/*
 * Skimbold auto-on entry. The registered content script loads settings, core
 * and engine first, then this file. It waits for the page to finish loading and
 * go idle, so server-rendered apps (React, Next) hydrate before any text is
 * wrapped, then checks the settings again before it turns the engine on.
 *
 * Skimbold.auto holds the promise of that decision (true when it turned the
 * engine on); it also stops a second injection from starting another wait. If
 * the user turns Skimbold on or off for the page during the wait, auto.js
 * leaves it that way.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold;
  if (!Skimbold || !Skimbold.engine || !Skimbold.settings || Skimbold.auto) return;

  const IDLE_TIMEOUT_MS = 1500;

  function pageLoaded() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      window.addEventListener('load', () => resolve(), { once: true });
    });
  }

  function pageIdle() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
      else setTimeout(resolve, 0);
    });
  }

  // The tab's own origin, as seen from a frame. Chromium exposes it even to
  // cross-origin frames; elsewhere only the frame's own origin is known.
  function topOrigin() {
    const ancestors = location.ancestorOrigins;
    return ancestors && ancestors.length > 0 ? Skimbold.settings.originOf(ancestors[ancestors.length - 1]) : null;
  }

  // The registration can lag behind a settings change, so the lists decide.
  function wanted(current) {
    const origin = Skimbold.settings.originOf(location.href);
    if (origin === null) return false;
    if (!current.autoAll) return current.autoSites.includes(origin);
    const top = topOrigin();
    return !current.excludedSites.includes(origin) && (top === null || !current.excludedSites.includes(top));
  }

  async function start() {
    const engine = Skimbold.engine;
    const chosen = engine.choices();
    await pageLoaded();
    await pageIdle();
    const current = await Skimbold.settings.load();
    // The user turned Skimbold on or off for this page meanwhile; that choice stands.
    if (engine.choices() !== chosen || !wanted(current)) return false;
    engine.enable();
    return engine.isActive();
  }

  Skimbold.auto = start().catch((error) => {
    console.warn('Skimbold:', error);
    return false;
  });
})();
