// Greb Meals service worker: app shell cache + network-first API reads,
// so an opened shopping list still shows in a store with bad signal.
const SHELL = "meals-shell-v1";
const DATA = "meals-data-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

function cacheable(url) {
  return url.pathname.startsWith("/api/lists") || url.pathname.startsWith("/api/recipes") || url.pathname.startsWith("/api/plans") || url.pathname === "/api/aisles";
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/calendar.ics") return;

  if (url.pathname.startsWith("/api/")) {
    if (!cacheable(url)) return;
    e.respondWith(
      fetch(req, { redirect: "manual" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.json({ error: "You're offline." }, { status: 503 }))),
    );
    return;
  }

  // Navigations: network first, fall back to the cached shell.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed build assets: cache first.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
