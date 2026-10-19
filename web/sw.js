// Service worker: makes the app installable, keeps it opening when the Mac is unreachable (so it can say
// "offline since …" instead of a blank page), and shows push notifications.
const SHELL = "blip-shell-v3";
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
      // Quick answers on the notification itself (Android, and Chrome on desktop; iPhone shows just the text).
      actions: data.card ? data.card.actions : [],
      requireInteraction: !!data.card,
      data: { botId: data.botId, cardId: data.card && data.card.id, url: data.url },
    }),
  );
});

/** Answers a card from a notification button. If it can't (expired, signed out, offline), opens the app instead. */
async function answerFromNotification(cardId, value, botId, title) {
  try {
    const res = await fetch(`/api/card/${encodeURIComponent(cardId)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(String(res.status));
    await self.registration.showNotification("Blip", { body: `Done: ${title}`, tag: `answered-${cardId}`, silent: true, icon: "/icon-512.png", data: { botId } });
    setTimeout(() => self.registration.getNotifications({ tag: `answered-${cardId}` }).then((list) => list.forEach((n) => n.close())), 4000);
  } catch {
    await openApp(botId);
  }
}

function openApp(botId) {
  const url = botId ? `/?bot=${encodeURIComponent(botId)}` : "/";
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const w of windows) {
      w.postMessage({ type: "open-bot", botId });
      return w.focus();
    }
    return self.clients.openWindow(url);
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action && data.cardId) {
    const label = ((event.notification.actions || []).find((a) => a.action === event.action) || {}).title || event.action;
    return event.waitUntil(answerFromNotification(data.cardId, event.action, data.botId, label));
  }
  // "Blip has a new link": open Blip at its new address (the link signs this phone in).
  if (data.url && /^https:\/\//.test(data.url)) return event.waitUntil(self.clients.openWindow(data.url));
  event.waitUntil(openApp(data.botId));
});
