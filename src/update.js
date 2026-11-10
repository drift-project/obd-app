// A new release of the app comes with a new service worker, which stores the
// whole release and then waits (see sw.js). A page that has loaded all its
// files and is idle lets it take over and loads itself again; a page in use is
// offered the new release, and a page that records is never reloaded. A
// release nobody lets in takes over by itself the next time the app starts
// after all its pages were closed.

/**
 * Watches `registration`, the service worker registration of the page in
 * `container` (navigator.serviceWorker), for a new release waiting to take
 * over. `busy()` tells whether a recording runs and `touched()` whether the
 * page was used since it was loaded. A release found while the page is idle
 * and untouched takes over at once and the page is loaded again with
 * `reload()`; otherwise `offer()` is called. Returns `{ waiting, takeOver }`:
 * whether a release waits, and the function that lets it take over and loads
 * the page again.
 */
export function watchUpdates(container, registration, { busy, touched, reload, offer }) {
  let waiting = null;
  let asked = false;
  container.addEventListener('controllerchange', () => {
    if (asked) reload();
  });

  const takeOver = () => {
    if (asked) return;
    if (!waiting || waiting.state === 'redundant') {
      reload();
      return;
    }
    asked = true;
    waiting.postMessage('take-over');
  };

  const found = (worker) => {
    // A page without a worker came straight from the server: the first worker of a browser brings nothing newer.
    if (!container.controller || worker === waiting) return;
    waiting = worker;
    if (!busy() && !touched()) takeOver();
    else offer();
  };

  const follow = (worker) => {
    if (!worker) return;
    if (worker.state === 'installed') {
      found(worker);
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') found(worker);
    });
  };

  // A release may have been stored before this page was loaded, or be on its way.
  follow(registration.waiting);
  follow(registration.installing);
  registration.addEventListener('updatefound', () => follow(registration.installing));
  return { waiting: () => waiting !== null, takeOver };
}
