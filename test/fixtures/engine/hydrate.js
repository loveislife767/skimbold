// Hydrates the server-rendered markup of hydrate.html on the load event (React 18). Any mismatch
// between the markup and what the app renders is reported as a console error by React.
(function () {
  'use strict';

  const h = React.createElement;

  function App() {
    const [count, setCount] = React.useState(0);
    return h('main', { id: 'app' },
      h('h1', null, 'Hydrated article'),
      h('p', { id: 'lede' }, 'Server rendered words that the client takes over.'),
      h('p', { id: 'count' }, 'You clicked ', count, ' times'),
      h('button', { id: 'click', onClick: () => setCount(count + 1) }, 'Click me'));
  }

  window.hydrated = false;
  window.addEventListener('load', () => {
    ReactDOM.hydrateRoot(document.getElementById('root'), h(App), {
      onRecoverableError: (error) => console.error('hydration:', error.message),
    });
    requestAnimationFrame(() => { window.hydrated = true; });
  });
})();
