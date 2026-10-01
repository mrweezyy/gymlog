// Intentionally does NOT cache anything. gymlog.html is updated often via a
// fresh GitHub upload with no cache-busting/versioning scheme, so caching
// here would risk the app serving a stale build after a deploy. This file
// exists purely to satisfy the browser's "installable" criteria.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', (e) => {});
