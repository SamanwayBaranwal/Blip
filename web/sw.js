// Service worker: makes the app installable, keeps it opening when the Mac is unreachable (so it can say
// "offline since …" instead of a blank page), and shows push notifications.
const SHELL = "blip-shell-v1";
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/app.js", "/styles.css", "/vendor/preact.mjs", "/vendor/hooks.mjs", "/vendor/htm.mjs"]).catch(() => {})));
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The app itself always comes fresh from the Mac when it's reachable; the saved copy is only a fallback.
// Nothing under /api or /login is ever stored.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api") || url.pathname.startsWith("/login")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "/" : req).then((hit) => hit || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Blip", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Blip", {
      body: data.body || "",
      tag: data.tag,
      silent: !!data.silent,
      icon: "/icon-512.png",
      badge: "/icon-512.png",
      data: { botId: data.botId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const botId = event.notification.data && event.notification.data.botId;
  const url = botId ? `/?bot=${encodeURIComponent(botId)}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        w.postMessage({ type: "open-bot", botId });
        return w.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
