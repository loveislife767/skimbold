import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { createZip, readZip } from '../../scripts/lib/zip.mjs';

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

function sampleEntries() {
  return [
    { name: 'manifest.json', data: JSON.stringify({ name: 'Skimbold', version: '1.0.0' }, null, 2) },
    { name: 'shared/core.js', data: '// core\n'.repeat(500) },
    { name: 'icons/icon-16.png', data: randomBytes(700) },
    { name: 'vendor/pdfjs/LICENSE', data: 'Apache License\n' },
    { name: 'reader/ünïcødé names — ok.txt', data: 'Grüße, мир, שלום\n' },
    { name: 'empty.txt', data: '' },
    { name: 'random.bin', data: randomBytes(4096) },
    { name: 'docs/a.pdf', data: Buffer.from('%PDF-1.7\n' + 'x'.repeat(2000)) },
  ];
}

function python() {
  for (const cmd of ['python', 'python3']) {
    const probe = spawnSync(cmd, ['-c', 'import zipfile'], { encoding: 'utf8' });
    if (probe.status === 0) return cmd;
  }
  return null;
}

test('round-trips every entry byte for byte through our own reader', () => {
  const entries = sampleEntries();
  const zip = createZip(entries);
  const read = readZip(zip);
  const byName = new Map(entries.map((e) => [e.name, Buffer.from(e.data)]));
  assert.equal(read.length, entries.length);
  for (const entry of read) {
    assert.ok(byName.has(entry.name), `unexpected entry ${entry.name}`);
    assert.equal(sha1(entry.data), sha1(byName.get(entry.name)), entry.name);
    assert.equal(entry.crc32, zlib.crc32(byName.get(entry.name)), `${entry.name} CRC`);
  }
});

test('sorts entries, fixes the timestamp and sets the UTF-8 flag', () => {
  const read = readZip(createZip(sampleEntries()));
  const names = read.map((e) => e.name);
  assert.deepEqual(names, [...names].sort());
  for (const entry of read) {
    assert.equal(entry.dosTime, 0, entry.name);
    assert.equal(entry.dosDate, (1 << 5) | 1, entry.name);
    assert.equal(entry.flags & 0x0800, 0x0800, entry.name);
    assert.equal(entry.externalAttributes >>> 16, 0o100644, entry.name);
  }
});

test('stores already-compressed formats and deflates text', () => {
  const read = readZip(createZip(sampleEntries()));
  const method = Object.fromEntries(read.map((e) => [e.name, e.method]));
  assert.equal(method['icons/icon-16.png'], 0);
  assert.equal(method['docs/a.pdf'], 0);
  assert.equal(method['shared/core.js'], 8);
  assert.equal(method['manifest.json'], 8);
  assert.equal(method['empty.txt'], 0);
  // Random bytes do not shrink, so they are stored rather than inflated by deflate.
  assert.equal(method['random.bin'], 0);
});

test('is deterministic regardless of input order', () => {
  const entries = sampleEntries();
  const a = createZip(entries);
  const b = createZip([...entries].reverse());
  assert.equal(sha1(a), sha1(b));
});

test('converts backslashes and rejects unsafe or duplicate names', () => {
  const [entry] = readZip(createZip([{ name: 'shared\\core.js', data: 'x' }]));
  assert.equal(entry.name, 'shared/core.js');
  for (const bad of ['../evil.js', '/abs.js', 'C:/x.js', 'a//b.js', 'dir/', './x.js', '']) {
    assert.throws(() => createZip([{ name: bad, data: 'x' }]), undefined, bad);
  }
  assert.throws(() => createZip([{ name: 'a.js', data: '1' }, { name: 'a.js', data: '2' }]), /duplicate/);
});

test('reader detects corruption', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello hello hello hello hello' }]);
  const broken = Buffer.from(zip);
  // Flip a byte inside the compressed body (after the 30-byte header and 5-byte name).
  broken[36] ^= 0xff;
  assert.throws(() => readZip(broken));
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some text padding it out')), /end of central directory/);
});

test('Python zipfile accepts the archive and reads identical bytes', (t) => {
  const py = python();
  if (!py) {
    t.skip('Python is not installed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'skimbold-zip-'));
  try {
    const entries = sampleEntries();
    const file = join(dir, 'sample.zip');
    writeFileSync(file, createZip(entries));
    const script = [
      'import hashlib, json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'bad = z.testzip()',
      'out = {"bad": bad, "files": {i.filename: {"sha1": hashlib.sha1(z.read(i)).hexdigest(), "utf8": bool(i.flag_bits & 0x800), "date": list(i.date_time)} for i in z.infolist()}}',
      'print(json.dumps(out))',
    ].join('\n');
    const run = spawnSync(py, ['-c', script, file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.bad, null, 'testzip found a bad CRC');
    assert.equal(Object.keys(result.files).length, entries.length);
    for (const { name, data } of entries) {
      const info = result.files[name];
      assert.ok(info, `Python did not see ${name}`);
      assert.equal(info.sha1, sha1(Buffer.from(data)), name);
      assert.equal(info.utf8, true, name);
      assert.deepEqual(info.date, [1980, 1, 1, 0, 0, 0], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
