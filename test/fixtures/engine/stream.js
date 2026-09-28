// Streams an answer into the page one word every 10 ms, the way chat interfaces do. Three styles:
// 'append' adds a new text node per word; 'rewrite' keeps one text node and sets its whole value
// each time (what React does when a string state grows); 'html' re-renders the whole answer as
// paragraphs of markup for every word (Markdown rendered to HTML on each token), starting from an
// answer that is already about 1,500 words long.
(function () {
  'use strict';

  const WORDS = ('Tides are the rise and fall of sea levels caused by the combined pull of the moon and the sun '
    + 'on the oceans while the earth turns beneath them so most coasts see two high waters and two low '
    + 'waters every lunar day').split(' ');

  function renderHtml(answer, text) {
    const words = text.split(' ');
    const paragraphs = [];
    for (let i = 0; i < words.length; i += 60) paragraphs.push(`<p>${words.slice(i, i + 60).join(' ')}</p>`);
    answer.innerHTML = paragraphs.join('');
  }

  function run(mode, durationMs) {
    const answer = document.getElementById('answer');
    answer.textContent = '';
    const paragraph = answer.appendChild(document.createElement('p'));
    const node = paragraph.appendChild(document.createTextNode(''));
    let text = '';
    let count = 0;
    if (mode === 'html') {
      while (count < 1500) text += (count === 0 ? '' : ' ') + WORDS[count++ % WORDS.length];
      renderHtml(answer, text);
    }
    return new Promise((resolve) => {
      const started = performance.now();
      const timer = setInterval(() => {
        const word = (count === 0 ? '' : ' ') + WORDS[count % WORDS.length];
        count++;
        text += word;
        if (mode === 'append') paragraph.append(word);
        else if (mode === 'html') renderHtml(answer, text);
        else node.nodeValue = text;
        if (performance.now() - started >= durationMs) {
          clearInterval(timer);
          resolve({ text, words: count });
        }
      }, 10);
    });
  }

  window.streamFixture = { run };
})();
