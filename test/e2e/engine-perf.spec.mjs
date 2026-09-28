// Main-thread cost of the engine. A long article must be done within about 300 ms of main-thread
// work; a 5,000-paragraph page (about 250,000 words) must be processed and restored in slices
// with no task over 50 ms, and turning it back on while it is still being restored must not block;
// a script that appends to every text node of a long page must not be held up for long by Skimbold;
// a chat-style stream of one word every 10 ms must stay cheap and end
// with the right text, including a stream that re-renders the whole answer as HTML for each word. The numbers are printed and kept as test annotations.

import { test, expect, collectConsoleErrors } from './fixtures.mjs';
import { openFixture, inject, isolated, frames, invariantProblems } from '../fixtures/engine/helpers.mjs';

// Playwright's trace recorder snapshots the whole DOM around every action; on a page with
// 750,000 nodes that snapshot alone blocks the page for about a second and swamps the numbers.
test.use({ trace: 'off' });

const LONG_TASK_MS = 50;

async function busyMs(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'TaskDuration').value * 1000;
}

function report(name, values) {
  const line = Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ');
  test.info().annotations.push({ type: name, description: line });
  console.log(`[${name}] ${line}`);
}

// Opens the generated article with the engine injected but off, and a CDP session for metrics.
async function openArticle(page, serviceWorker, paragraphs) {
  const tabId = await openFixture(page, serviceWorker, `/engine/perf.html?paragraphs=${paragraphs}`);
  await page.waitForFunction(() => window.perfFixture.ready);
  await inject(serviceWorker, tabId);
  await frames(page, 200);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return { tabId, cdp };
}

// Calls engine[method]() in the isolated world, then waits for the fixture to see the last
// paragraph wrapped (enable) or unwrapped (disable), and returns the measurements.
async function measure(page, serviceWorker, tabId, cdp, method) {
  const doneKey = method === 'enable' ? 'doneAt' : 'restoredAt';
  const busyBefore = await busyMs(cdp);
  await page.evaluate(() => window.perfFixture.startMeasure());
  const [{ startedAt, syncMs }] = await isolated(serviceWorker, tabId, (name) => {
    const started = performance.now();
    globalThis.Skimbold.engine[name]();
    return { startedAt: started, syncMs: performance.now() - started };
  }, [method]);
  await page.waitForFunction((key) => window.perfFixture[key] !== null, doneKey, { timeout: 60_000, polling: 250 });
  const probes = await page.evaluate(() => window.perfFixture.stopMeasure());
  const doneAt = await page.evaluate((key) => window.perfFixture[key], doneKey);
  return { ...probes, wallMs: Math.round(doneAt - startedAt), syncMs, busyMs: Math.round(await busyMs(cdp) - busyBefore) };
}

test('a long article (10,000 words) is bolded within about 300 ms of main-thread work', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  const { tabId, cdp } = await openArticle(page, serviceWorker, 200);
  const on = await measure(page, serviceWorker, tabId, cdp, 'enable');
  const off = await measure(page, serviceWorker, tabId, cdp, 'disable');
  report('article', {
    words: await page.evaluate(() => window.perfFixture.words),
    enableWallMs: on.wallMs,
    enableBusyMs: on.busyMs,
    firstSliceMs: on.syncMs.toFixed(1),
    longTasks: `[${[...on.longTasks, ...off.longTasks].join(',')}]`,
    disableWallMs: off.wallMs,
    disableBusyMs: off.busyMs,
  });
  expect(on.busyMs).toBeLessThan(300);
  expect(on.longTasks).toEqual([]);
  expect(off.longTasks).toEqual([]);
  expect(errors).toEqual([]);
});

// A stress test (tagged @stress): another process competing for the same CPU can add a stray long
// task (a garbage-collection step landing in a frame). So it runs on its own once every other test
// has finished (the 'stress' project in playwright.config.mjs), measures up to three rounds of
// enable and disable, reports each, and needs one round that is clean on every count. On a shared
// CI runner a round that is never clean is reported as a warning rather than failing the build,
// while local runs keep the strict check.
test('a 5,000-paragraph page is processed and restored in slices without a long task', { tag: '@stress' }, async ({ page, serviceWorker }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  const { tabId, cdp } = await openArticle(page, serviceWorker, 5000);
  await page.evaluate(() => { window.originalHtml = document.getElementById('article').innerHTML; });

  const rounds = [];
  for (let round = 1; round <= 3; round++) {
    await page.evaluate(() => window.perfFixture.reset());
    const on = await measure(page, serviceWorker, tabId, cdp, 'enable');
    const processed = await page.evaluate(() => [...document.querySelectorAll('#article > p')].filter((p) => p.querySelector('skb-w')).length);
    const off = await measure(page, serviceWorker, tabId, cdp, 'disable');
    report(`long page, round ${round}`, {
      words: await page.evaluate(() => window.perfFixture.words),
      paragraphs: processed,
      enableWallMs: on.wallMs,
      enableBusyMs: on.busyMs,
      firstSliceMs: on.syncMs.toFixed(1),
      enableLongTasks: `[${on.longTasks.join(',')}]`,
      enableMaxProbeGapMs: on.maxGap,
      enableMaxFrameGapMs: on.maxFrameGap,
      frames: on.frames,
      disableWallMs: off.wallMs,
      disableFirstSliceMs: off.syncMs.toFixed(1),
      disableLongTasks: `[${off.longTasks.join(',')}]`,
      disableMaxProbeGapMs: off.maxGap,
    });
    expect(processed).toBe(5000);
    expect(on.syncMs).toBeLessThan(LONG_TASK_MS);
    expect(off.syncMs).toBeLessThan(LONG_TASK_MS);
    expect(await page.evaluate(() => document.querySelectorAll('skb-w').length)).toBe(0);
    expect(await page.evaluate(() => document.getElementById('article').innerHTML === window.originalHtml)).toBe(true);
    // Clean: no long task, and page timers and animation frames kept running.
    const summary = { longTasks: [...on.longTasks, ...off.longTasks], maxGap: Math.max(on.maxGap, off.maxGap), maxFrameGap: on.maxFrameGap };
    rounds.push(summary);
    if (summary.longTasks.length === 0 && summary.maxGap < 2 * LONG_TASK_MS && summary.maxFrameGap < 2 * LONG_TASK_MS) break;
  }
  const clean = rounds.find((round) => round.longTasks.length === 0 && round.maxGap < 2 * LONG_TASK_MS && round.maxFrameGap < 2 * LONG_TASK_MS);
  if (!clean && process.env.CI) {
    test.info().annotations.push({ type: 'warning', description: `no clean round on this runner: ${JSON.stringify(rounds)}` });
    console.warn(`[long page] no clean round on this runner: ${JSON.stringify(rounds)}`);
  } else {
    expect(clean, 'no round was free of long tasks and gaps. This test needs an otherwise idle machine '
      + `(test/README.md, "The stress test"): ${JSON.stringify(rounds)}`).toBeDefined();
  }
  expect(errors).toEqual([]);
});

// Turned back on while a long page is still being restored, the engine keeps what is still bolded
// and bolds the rest; restoring it all first blocked the page for 0.1 to 0.4 s.
test('turning back on while a long page is being restored blocks for no time and bolds every paragraph once', async ({ page, serviceWorker }) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const { tabId, cdp } = await openArticle(page, serviceWorker, 2000);
  const original = await page.evaluate(() => document.getElementById('article').innerHTML);
  await measure(page, serviceWorker, tabId, cdp, 'enable');
  const [{ wrapped, syncMs }] = await isolated(serviceWorker, tabId, async () => {
    const { engine } = globalThis.Skimbold;
    engine.disable();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const left = document.querySelectorAll('skb-w').length;
    const started = performance.now();
    engine.enable();
    return { wrapped: left, syncMs: performance.now() - started };
  });
  report('back on during a restore', { wrappersLeft: wrapped, syncMs: syncMs.toFixed(1) });
  expect(wrapped).toBeGreaterThan(500);
  expect(syncMs).toBeLessThan(LONG_TASK_MS);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#article > p')].filter((p) => p.querySelector('skb-w') === null).length), { timeout: 30_000 }).toBe(0);
  expect(await invariantProblems(page, '#article')).toEqual([]);
  await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.disable());
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('skb-w').length), { timeout: 30_000 }).toBe(0);
  expect(await page.evaluate(() => document.getElementById('article').innerHTML)).toBe(original);
  expect(errors).toEqual([]);
});

// A script that walks the text nodes and appends to each one writes into the text inside every
// wrapper as well, so each wrapper is taken apart where it stands and bolded afresh. On a long page
// that once took 1.6 s in one task. The task still holds the page's own walk, which meets about
// 100 times as many text nodes while Skimbold is on, and the layout of what it changed (read by the
// page here, so it is not counted as Skimbold's); what follows them in the task is Skimbold's.
test('a text walker that appends to every node of a long page keeps its words without blocking it', async ({ page, serviceWorker }) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const appendToEvery = () => new Promise((resolve) => {
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    observer.observe({ type: 'longtask' });
    const started = performance.now();
    const walker = document.createTreeWalker(document.getElementById('article'), NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) node.data += ' ';
    const walked = performance.now();
    void document.body.offsetHeight;
    const laidOut = performance.now();
    // Mutation observers, Skimbold's among them, run in the microtask checkpoint after this script.
    let observersMs = 0;
    queueMicrotask(() => { observersMs = performance.now() - laidOut; });
    requestAnimationFrame(() => setTimeout(() => {
      for (const entry of observer.takeRecords()) longTasks.push(Math.round(entry.duration));
      observer.disconnect();
      resolve({
        nodes: nodes.length, walkMs: Math.round(walked - started), layoutMs: Math.round(laidOut - walked),
        observersMs: Math.round(observersMs), longTasks,
      });
    }, 0));
  });
  // The appended spaces also land between the pieces the bolding split words into.
  const letters = () => page.evaluate(() => document.getElementById('article').innerText.replace(/\s+/g, ''));
  const unbolded = () => page.evaluate(() => [...document.querySelectorAll('#article > p')].filter((p) => p.querySelector('skb-b') === null).length);

  await page.goto('/engine/perf.html?paragraphs=2000');
  await page.waitForFunction(() => window.perfFixture.ready);
  const plain = await page.evaluate(appendToEvery);
  const text = await letters();
  const { tabId, cdp } = await openArticle(page, serviceWorker, 2000);
  await measure(page, serviceWorker, tabId, cdp, 'enable');
  await frames(page, 200);
  const on = await page.evaluate(appendToEvery);
  report('walker appending to every node', {
    plainNodes: plain.nodes,
    plainWalkMs: plain.walkMs,
    plainLayoutMs: plain.layoutMs,
    nodes: on.nodes,
    walkMs: on.walkMs,
    layoutMs: on.layoutMs,
    skimboldMs: on.observersMs,
    longTasks: `[${on.longTasks.join(',')}]`,
  });
  // Measured: about 190 ms (mostly sorting some 200,000 mutation records; wrappers are taken apart
  // for 4 ms, the rest in later slices), against 950 ms before.
  expect(on.observersMs).toBeLessThan(500);
  expect(await letters()).toBe(text);
  await expect.poll(unbolded, { timeout: 30_000 }).toBe(0);
  expect(await letters()).toBe(text);
  expect(await invariantProblems(page, '#article')).toEqual([]);
  await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.disable());
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('skb-w, skb-b').length), { timeout: 30_000 }).toBe(0);
  expect(await letters()).toBe(text);
  expect(errors).toEqual([]);
});

test('streaming a word every 10 ms stays cheap and ends with the right text', async ({ page, serviceWorker }) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const tabId = await openFixture(page, serviceWorker, '/engine/stream.html');
  await inject(serviceWorker, tabId);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const stream = async (mode) => {
    const before = await busyMs(cdp);
    const result = await page.evaluate((m) => window.streamFixture.run(m, 3_000), mode);
    await frames(page, 50);
    return { ...result, busyMs: Math.round(await busyMs(cdp) - before) };
  };

  // Over 3 s of streaming the engine may add at most 0.9 s of main-thread work (30 %). Other work
  // on the machine inflates a measurement now and then (the rewrite mode measured 510 to 1,141 ms
  // on the same code), so a mode that goes over gets a second try, as the stress test gets three.
  const BUDGET_MS = 900;
  for (const mode of ['append', 'rewrite', 'html']) {
    let extraMs = Infinity;
    for (let attempt = 1; attempt <= 2 && extraMs >= BUDGET_MS; attempt++) {
      const baseline = await stream(mode);
      await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.enable());
      const measured = await stream(mode);
      // An answer re-rendered wholesale is bolded once it stops changing.
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('#answer skb-b').length)).toBeGreaterThan(measured.words / 2);
      const answer = await page.evaluate(() => ({
        text: document.getElementById('answer').innerText,
        bold: document.querySelectorAll('#answer skb-b').length,
      }));
      extraMs = measured.busyMs - baseline.busyMs;
      report(`stream ${mode}, try ${attempt}`, {
        words: measured.words,
        baselineBusyMs: baseline.busyMs,
        engineBusyMs: measured.busyMs,
        extraPerWordMs: (extraMs / measured.words).toFixed(2),
      });
      // Paragraph breaks aside (the html mode renders paragraphs), the words are the stream's.
      expect(answer.text.replace(/\s+/g, ' ')).toBe(measured.text);
      expect(answer.bold).toBeGreaterThan(measured.words / 2);
      expect(await invariantProblems(page, '#answer')).toEqual([]);
      await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.disable());
      expect(await page.evaluate(() => document.getElementById('answer').innerText.replace(/\s+/g, ' '))).toBe(measured.text);
    }
    expect(extraMs, `stream ${mode}`).toBeLessThan(BUDGET_MS);
  }
  expect(errors).toEqual([]);
});
