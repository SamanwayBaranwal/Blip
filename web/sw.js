// Service worker: makes the app installable and shows push notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
