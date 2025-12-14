// Bump CACHE_VERSION when deploying to ensure clients get fresh assets
const CACHE_VERSION = "v4";
const CACHE_NAME = `dcsoft-gw-${CACHE_VERSION}`;
const urlsToCache = ["/", "/manifest.json", "/images/decomsoft-logo.svg"];

// Install event
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .catch(() => {}),
  );
});

// Fetch event
self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Bypass non-GET
  if (req.method !== "GET") {
    event.respondWith(fetch(req));
    return;
  }

  // Always bypass caching for API calls to avoid stale data (e.g., chat)
  try {
    const url = new URL(req.url);
    const isSameOrigin = url.origin === self.location.origin;
    if (isSameOrigin && url.pathname.startsWith("/api/")) {
      event.respondWith(fetch(req));
      return;
    }
  } catch (_) {}

  // Network-first for navigation and HTML
  if (
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html")
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Stale-while-revalidate for static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});

// Activate event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME && name.startsWith("dcsoft-gw-")) {
              return caches.delete(name);
            }
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Push notification event
self.addEventListener("push", (event) => {
  const options = {
    body: event.data ? event.data.text() : "새로운 알림이 있습니다",
    icon: "/images/decomsoft-logo.svg",
    badge: "/images/decomsoft-logo.svg",
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: "2",
    },
    actions: [
      {
        action: "explore",
        title: "확인하기",
        icon: "/images/decomsoft-logo.svg",
      },
      {
        action: "close",
        title: "닫기",
      },
    ],
  };

  event.waitUntil(self.registration.showNotification("디컴소프트", options));
});

// Notification click event
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "explore") {
    event.waitUntil(clients.openWindow("/"));
  }
});
