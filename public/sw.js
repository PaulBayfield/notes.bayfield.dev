// Caches the app shell so the installed web app opens offline. Documents themselves are kept
// offline by y-indexeddb; API and collaboration traffic is never touched here.
const CACHE = "notes-shell-v1";
const scope = new URL(self.registration.scope);
const shell = new URL("./", scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(shell)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only the app's own files: skip Outline's API, uploads, and anything outside the scope.
  if (req.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // Pages: always try the network so updates land, and fall back to the cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(shell, copy));
          }
          return res;
        })
        .catch(() => caches.match(shell)),
    );
    return;
  }

  // Hashed assets never change, so serve them from the cache once seen.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith(scope.pathname + "assets/")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
