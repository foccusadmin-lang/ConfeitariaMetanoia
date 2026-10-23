// Minimal service worker: makes the app installable. It deliberately caches
// nothing, so every visit loads the latest deployed version (orders and
// statuses are live Firestore data and must never be served stale).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
