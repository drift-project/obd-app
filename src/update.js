// A new release of the app comes with a new service worker, which stores all
// of it and then takes over the open page (see sw.js). The page goes on
// running the files it was loaded with until it is loaded again: at once when
// nobody has touched it yet, otherwise when the driver chooses, and never in
// the middle of a recording.

/**
 * Watches `container` (navigator.serviceWorker) for a new release taking
 * over. `busy()` tells whether a recording runs and `touched()` whether the
 * page was used since it was loaded. A release that takes over an idle page
 * nobody has touched reloads it with `reload()`; otherwise `offer()` is
 * called. Returns a function that tells whether a release waits for the page
 * to be loaded again.
 */
export function watchUpdates(container, { busy, touched, reload, offer }) {
  // A page loaded without a worker (the first visit, or a reload past the cache) came straight from the server:
  // the first worker to take it over brings nothing newer.
  const before = container.controller;
  let waiting = false;
  container.addEventListener('controllerchange', () => {
    if (!before || waiting) return;
    waiting = true;
    if (!busy() && !touched()) reload();
    else offer();
  });
  return () => waiting;
}
