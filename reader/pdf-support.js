/*
 * Recent JavaScript that the vendored pdf.js (pdfjs-dist 6.3.289, modern build, unmodified)
 * calls without checking for it: Promise.try, Uint8Array hex and base64, Map and WeakMap
 * getOrInsert(Computed), Math.sumPrecise, URL.parse, Response.prototype.bytes and async
 * iteration of a ReadableStream. Loaded before pdf.js in the Reader page (reader.js) and in
 * its worker (pdf-worker.mjs), so PDFs also open in browsers from before those arrived. Each
 * one is added only where the browser lacks it. pdf.js also needs the Iterator global (Chrome
 * 122, Firefox 131, Safari 18.4), which is too big to add; reader.js tells the reader to
 * update the browser instead.
 *
 * Works as a classic script and as a module (no imports, exports or top-level this).
 */
(function () {
  'use strict';

  function add(target, name, value) {
    if (!target || typeof target[name] === 'function') return;
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  }

  add(Promise, 'try', function (callback, ...args) {
    return new Promise((resolve) => {
      resolve(callback(...args));
    });
  });

  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  add(Uint8Array.prototype, 'toHex', function () {
    let out = '';
    for (let i = 0; i < this.length; i++) out += HEX[this[i]];
    return out;
  });
  add(Uint8Array, 'fromHex', function (text) {
    if (typeof text !== 'string' || text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw new SyntaxError('Uint8Array.fromHex: not a hex string');
    const bytes = new Uint8Array(text.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.substr(i * 2, 2), 16);
    return bytes;
  });
  add(Uint8Array.prototype, 'toBase64', function () {
    let binary = '';
    for (let i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  add(Uint8Array, 'fromBase64', function (text) {
    const binary = atob(String(text).replace(/[\t\n\f\r ]+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });

  for (const Collection of [Map, WeakMap]) {
    add(Collection.prototype, 'getOrInsert', function (key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    });
    add(Collection.prototype, 'getOrInsertComputed', function (key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    });
  }

  // Neumaier's compensated sum: exact for the integer sums pdf.js makes, and close for any other.
  add(Math, 'sumPrecise', function (items) {
    let sum = 0;
    let compensation = 0;
    let empty = true;
    for (const value of items) {
      if (typeof value !== 'number') throw new TypeError('Math.sumPrecise: every item must be a number');
      empty = false;
      const next = sum + value;
      compensation += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    }
    return empty ? -0 : sum + compensation;
  });

  add(URL, 'parse', function (url, base) {
    try {
      return base === undefined ? new URL(url) : new URL(url, base);
    } catch {
      return null;
    }
  });

  if (typeof Response === 'function') {
    add(Response.prototype, 'bytes', async function () {
      return new Uint8Array(await this.arrayBuffer());
    });
  }

  // for await (… of stream): getTextContent reads the text this way (Chrome 124, Safari 18.4).
  if (typeof ReadableStream === 'function') {
    const values = function ({ preventCancel = false } = {}) {
      const reader = this.getReader();
      return {
        next: () => reader.read(),
        async return(value) {
          const cancelled = preventCancel ? undefined : reader.cancel(value);
          reader.releaseLock();
          await cancelled;
          return { done: true, value };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    add(ReadableStream.prototype, 'values', values);
    add(ReadableStream.prototype, Symbol.asyncIterator, values);
  }
})();
