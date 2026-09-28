import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GECKO_ID,
  build,
  firefoxManifest,
  isShippable,
  listFiles,
  manifestFileReferences,
  siteFileMap,
} from '../../scripts/build.mjs';
import { findViolations } from '../../scripts/check-no-network.mjs';
import { readZip } from '../../scripts/lib/zip.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const realManifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));

function tempRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), 'skimbold-build-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

const MINI_MANIFEST = {
  manifest_version: 3,
  name: 'Skimbold',
  version: '1.2.3',
  minimum_chrome_version: '121',
  icons: { 16: 'icons/icon-16.png' },
  action: { default_popup: 'popup/popup.html' },
  background: { service_worker: 'background.js' },
  options_ui: { page: 'options/options.html', open_in_tab: true },
};

function miniRepo(overrides = {}) {
  return tempRoot({
    'package.json': JSON.stringify({ name: 'skimbold', version: '1.2.3' }),
    'extension/manifest.json': JSON.stringify(MINI_MANIFEST, null, 2),
    'extension/background.js': "importScripts('shared/settings.js');\n",
    'extension/shared/settings.js': '// settings\n',
    'extension/shared/core.js': '// core\n',
    'extension/shared/theme.css': ':root{}\n',
    'extension/icons/icon-16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'extension/icons/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'extension/popup/popup.html': '<!doctype html><title>Popup</title>',
    'extension/options/options.html': '<!doctype html><title>Options</title>',
    'extension/content/engine.js': '// engine\n',
    'extension/reader/reader.html': '<!doctype html><script src="../shared/core.js"></script>',
    'extension/reader/reader.js': 'async function load(url) { return fetch(url); }\n',
    'extension/vendor/pdfjs/pdf.min.mjs': 'fetch(x); new XMLHttpRequest();\n',
    'extension/.DS_Store': 'junk',
    'extension/popup/Thumbs.db': 'junk',
    'site/index.html': '<!doctype html><link rel="stylesheet" href="shared/theme.css">',
    'site/404.html': '<!doctype html><title>Not found</title>',
    ...overrides,
  });
}

test('firefoxManifest applies exactly the spec §11 changes', () => {
  const ff = firefoxManifest(realManifest);
  assert.deepEqual(ff.background, { scripts: ['shared/settings.js', 'background.js'] });
  assert.equal('minimum_chrome_version' in ff, false);
  assert.deepEqual(ff.browser_specific_settings, {
    gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
    gecko_android: { strict_min_version: '142.0' },
  });
  assert.equal(GECKO_ID, 'skimbold@loveislife767.github.io');
  // Firefox's default MV3 policy would upgrade the Reader's http:// PDF downloads to https://.
  assert.deepEqual(ff.content_security_policy, { extension_pages: "script-src 'self'" });
  assert.equal(JSON.stringify(ff.content_security_policy).includes('upgrade-insecure-requests'), false);

  // Everything else is carried over untouched and in the same order.
  const added = ['background', 'minimum_chrome_version', 'browser_specific_settings', 'content_security_policy'];
  const rest = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !added.includes(k)));
  assert.deepEqual(rest(ff), rest(realManifest));
  const order = Object.keys(ff).filter((k) => !['browser_specific_settings', 'content_security_policy'].includes(k));
  assert.deepEqual(order, Object.keys(realManifest).filter((k) => k !== 'minimum_chrome_version'));
});

test('firefoxManifest does not modify its input', () => {
  const input = structuredClone(realManifest);
  const ff = firefoxManifest(input);
  assert.deepEqual(input, realManifest);
  ff.permissions?.push('tabs');
  assert.deepEqual(input, realManifest);
});

test('the Chromium manifest stays clean of Firefox keys', () => {
  assert.equal('browser_specific_settings' in realManifest, false);
  assert.equal(typeof realManifest.background.service_worker, 'string');
});

test('isShippable drops dev junk and hidden files only', () => {
  for (const junk of ['.DS_Store', 'popup/.DS_Store', 'Thumbs.db', 'icons/thumbs.db', 'desktop.ini', '.git/config', '.vscode/settings.json', '._icon.png', 'popup/popup.js~', 'reader/.reader.js.swp', 'a.orig', 'debug.log', 'x.bak']) {
    assert.equal(isShippable(junk), false, junk);
  }
  for (const keep of ['manifest.json', 'vendor/pdfjs/LICENSE', 'icons/icon-16.png', 'reader/pdf-text.js', 'popup/popup.html']) {
    assert.equal(isShippable(keep), true, keep);
  }
});

test('listFiles returns sorted forward-slash paths without junk', () => {
  const root = miniRepo();
  try {
    const files = listFiles(join(root, 'extension'));
    assert.deepEqual(files, [...files].sort());
    assert.ok(files.includes('shared/core.js'));
    assert.ok(files.includes('vendor/pdfjs/pdf.min.mjs'));
    assert.ok(!files.some((f) => f.includes('\\')));
    assert.ok(!files.includes('.DS_Store'));
    assert.ok(!files.includes('popup/Thumbs.db'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifestFileReferences lists every file the manifest points at', () => {
  const refs = manifestFileReferences({
    ...MINI_MANIFEST,
    action: { default_popup: 'popup/popup.html', default_icon: { 32: 'icons/icon-32.png' } },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content/engine.js'], css: ['content/a.css'] }],
  });
  assert.deepEqual(refs, [
    'background.js', 'content/a.css', 'content/engine.js', 'icons/icon-16.png', 'icons/icon-32.png', 'options/options.html', 'popup/popup.html',
  ]);
  assert.deepEqual(manifestFileReferences(firefoxManifest(realManifest)).filter((r) => r.endsWith('.js')), ['background.js', 'shared/settings.js']);
});

test('siteFileMap is the site plus the web Reader in the same layout', () => {
  const site = siteFileMap(ROOT).map((f) => f.to);
  for (const expected of ['index.html', 'privacy.html', '404.html', 'reader/reader.html', 'shared/core.js', 'shared/settings.js', 'shared/theme.css', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/pdfjs/LICENSE', 'icons/icon.svg']) {
    assert.ok(site.includes(expected), `dist/site is missing ${expected}`);
  }
  for (const path of site) {
    assert.ok(!/^(?:popup|options|content)\//.test(path), `${path} is extension-only`);
    assert.notEqual(path, 'manifest.json');
    assert.notEqual(path, 'background.js');
  }
});

test('build writes both zips, the Firefox folder and the site', () => {
  const root = miniRepo();
  const out = join(root, 'dist');
  try {
    const result = build({ root, outDir: out, log: () => {} });
    assert.equal(result.version, '1.2.3');

    const chromium = readZip(readFileSync(join(out, 'skimbold-1.2.3-chromium.zip')));
    const names = chromium.map((e) => e.name);
    assert.deepEqual(names, result.files);
    assert.ok(names.includes('vendor/pdfjs/pdf.min.mjs'));
    assert.ok(!names.some((n) => n.includes('DS_Store') || n.includes('Thumbs')));
    const chromiumManifest = chromium.find((e) => e.name === 'manifest.json').data;
    assert.ok(chromiumManifest.equals(readFileSync(join(root, 'extension', 'manifest.json'))), 'Chromium manifest must be the source file as-is');

    const firefox = readZip(readFileSync(join(out, 'skimbold-1.2.3-firefox.zip')));
    assert.deepEqual(firefox.map((e) => e.name), names);
    const ffManifest = JSON.parse(firefox.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    assert.deepEqual(ffManifest, firefoxManifest(MINI_MANIFEST));
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'firefox', 'manifest.json'), 'utf8')), ffManifest);
    assert.equal(readFileSync(join(out, 'firefox', 'shared', 'core.js'), 'utf8'), '// core\n');

    assert.deepEqual(result.siteFiles, [
      '404.html', 'icons/icon-16.png', 'icons/icon.svg', 'index.html', 'reader/reader.html', 'reader/reader.js',
      'shared/core.js', 'shared/settings.js', 'shared/theme.css', 'vendor/pdfjs/pdf.min.mjs',
    ]);
    assert.equal(readFileSync(join(out, 'site', 'shared', 'theme.css'), 'utf8'), ':root{}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build output is deterministic', () => {
  const root = miniRepo();
  try {
    build({ root, outDir: join(root, 'a'), log: () => {} });
    build({ root, outDir: join(root, 'b'), log: () => {} });
    for (const name of ['skimbold-1.2.3-chromium.zip', 'skimbold-1.2.3-firefox.zip']) {
      assert.ok(readFileSync(join(root, 'a', name)).equals(readFileSync(join(root, 'b', name))), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build refuses a version mismatch, a network call or a missing manifest file', () => {
  const cases = [
    [{ 'package.json': JSON.stringify({ version: '9.9.9' }) }, /Version mismatch.*1\.2\.3.*9\.9\.9/],
    [{ 'extension/popup/popup.js': "fetch('https://example.com/collect');\n" }, /check-no-network.*popup\/popup\.js:1/s],
    [{ 'extension/manifest.json': JSON.stringify({ ...MINI_MANIFEST, options_ui: { page: 'options/missing.html' } }) }, /options\/missing\.html/],
  ];
  for (const [overrides, message] of cases) {
    const root = miniRepo(overrides);
    try {
      assert.throws(() => build({ root, outDir: join(root, 'dist'), log: () => {} }), message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('check-no-network flags network use, remote loads, eval and the trademark', () => {
  const word = ['Bi', 'onic'].join('');
  const root = tempRoot({
    'extension/content/a.js': [
      'fetch(url);',
      'const x = new XMLHttpRequest();',
      "const s = new WebSocket('wss://x');",
      "new EventSource('/s');",
      'navigator.sendBeacon(u, d);',
      "importScripts('https://cdn.example.com/lib.js');",
      "import('https://cdn.example.com/m.mjs');",
      "script.src = 'https://cdn.example.com/x.js';",
      "new Worker('https://cdn.example.com/w.js');",
      "eval('1+1');",
      "new Function('return 1');",
      "setTimeout('go()', 10);",
    ].join('\n'),
    'extension/popup/popup.html': [
      '<script',
      '  src="https://cdn.example.com/x.js"></script>',
      '<link rel="stylesheet" href="//fonts.example.com/f.css">',
      '<img src="http://tracker.example.com/p.gif">',
    ].join('\n'),
    'extension/popup/popup.css': "@import url('https://fonts.example.com/f.css');\n.a { background: url(https://x.example.com/i.png); }\n",
    'extension/reader/reader.js': 'fetch(url);\nnew XMLHttpRequest();\n',
    'extension/vendor/pdfjs/pdf.min.mjs': 'fetch(x); eval(y);\n',
    'site/index.html': `<link rel="canonical" href="https://loveislife767.github.io/skimbold/">\n<a href="https://github.com/">GitHub</a>\n<p>${word}</p>\n`,
    'site/site.js': "const u = new URL('https://github.com/loveislife767/skimbold'); const f = typeof fetchLater;\n",
    'store/listing-chrome.md': `Not a ${word.toLowerCase()} clone.\n`,
    'docs/specs/design.md': `# Design\n\nUnlike ${word}, it is free.\n`,
  });
  try {
    const found = findViolations(root).map((v) => `${v.file}:${v.line}:${v.rule}`);
    assert.deepEqual(found, [
      // docs/ is checked for the trademark too.
      'docs/specs/design.md:3:trademark',
      'extension/content/a.js:1:fetch',
      'extension/content/a.js:2:xhr',
      'extension/content/a.js:3:websocket',
      'extension/content/a.js:4:eventsource',
      'extension/content/a.js:5:beacon',
      'extension/content/a.js:6:remote-importScripts',
      'extension/content/a.js:7:remote-import',
      'extension/content/a.js:8:remote-src',
      'extension/content/a.js:9:remote-worker',
      'extension/content/a.js:10:eval',
      'extension/content/a.js:11:function-constructor',
      'extension/content/a.js:12:string-timer',
      'extension/popup/popup.css:1:remote-css-import',
      'extension/popup/popup.css:2:remote-css-url',
      'extension/popup/popup.html:1:remote-script',
      'extension/popup/popup.html:3:remote-link',
      'extension/popup/popup.html:4:remote-media',
      // reader/ may fetch (user-requested PDF), but nothing else.
      'extension/reader/reader.js:2:xhr',
      'site/index.html:3:trademark',
      'store/listing-chrome.md:1:trademark',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the repository itself passes check-no-network', () => {
  assert.deepEqual(findViolations(ROOT), []);
});
