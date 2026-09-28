// The Reader's pdf.js worker: the unmodified pdf.js worker, after the JavaScript it needs from
// newer browsers (pdf-support.js). Imports run in order, so the additions come first.
import './pdf-support.js';
import '../vendor/pdfjs/pdf.worker.min.mjs';
