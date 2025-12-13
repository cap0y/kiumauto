// 캐시 버전을 타임스탬프로 동적 생성하여 새 배포 시 자동 갱신
const CACHE_VERSION = Date.now();
const CACHE_NAME = `auto-app-cache-v${CACHE_VERSION}`;
const STATIC_CACHE_NAME = `auto-static-cache-v${CACHE_VERSION}`;

// 정적 리소스만 사전 캐시
const urlsToCache = ["/manifest.json", "/logo.svg"];

// 캐시 전략별 URL 패턴 정의
const NETWORK_FIRST_PATTERNS = [
  /\.html$/,
  /\.js$/,
  /\.css$/,
  /\/api\//,
  /\/$/, // 루트 경로
];

const CACHE_FIRST_PATTERNS = [
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.svg$/,
  /\.woff$/,
  /\.woff2$/,
  /\.ttf$/,
];

// 캐시 전략을 판단하는 헬퍼 함수
function shouldUseNetworkFirst(url) {
  return NETWORK_FIRST_PATTERNS.some((pattern) => pattern.test(url));
}

function shouldUseCacheFirst(url) {
  return CACHE_FIRST_PATTERNS.some((pattern) => pattern.test(url));
}

// Install event
self.addEventListener("install", (event) => {
  console.log(`Service Worker installing (seniorang) v${CACHE_VERSION}...`);
  self.skipWaiting(); // 즉시 활성화
  event.waitUntil(
    caches
      .open(STATIC_CACHE_NAME)
      .then((cache) => {
        console.log("Opened static cache");
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.log("Static cache failed:", err);
      }),
  );
});

// Fetch event - 개선된 캐시 전략
self.addEventListener("fetch", (event) => {
  // GET 요청만 캐시 처리 (POST, PUT, DELETE 등은 캐시하지 않음)
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = event.request.url;

  // 네트워크 우선 전략 (HTML, JS, CSS, API)
  if (shouldUseNetworkFirst(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // 네트워크 응답이 성공적이면 캐시에 저장
          if (
            response &&
            response.status === 200 &&
            response.type === "basic"
          ) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // 네트워크 실패 시 캐시에서 찾기
          console.log("Network failed, trying cache for:", url);
          return caches.match(event.request);
        }),
    );
  }
  // 캐시 우선 전략 (이미지, 폰트 등 정적 리소스)
  else if (shouldUseCacheFirst(url)) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request).then((response) => {
          if (
            response &&
            response.status === 200 &&
            response.type === "basic"
          ) {
            const responseToCache = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        });
      }),
    );
  }
  // 기타 요청은 네트워크만 사용 (캐시하지 않음)
  else {
    event.respondWith(fetch(event.request));
  }
});

// Activate event - 개선된 캐시 정리
self.addEventListener("activate", (event) => {
  console.log(`Service Worker activating (seniorang) v${CACHE_VERSION}...`);
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // 현재 버전이 아닌 모든 캐시 삭제
            if (cacheName !== CACHE_NAME && cacheName !== STATIC_CACHE_NAME) {
              console.log("Deleting old cache:", cacheName);
              return caches.delete(cacheName);
            }
          }),
        );
      })
      .then(() => {
        console.log("Service Worker activated and claiming clients");
        return self.clients.claim(); // 모든 클라이언트에 즉시 적용
      }),
  );
});

// Push notification event
self.addEventListener("push", (event) => {
  const options = {
    body: event.data ? event.data.text() : "새로운 알림이 있습니다",
    icon: "/logo.svg",
    badge: "/logo.svg",
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: "2",
    },
    actions: [
      {
        action: "explore",
        title: "확인하기",
        icon: "/logo.svg",
      },
      {
        action: "close",
        title: "닫기",
      },
    ],
  };

  event.waitUntil(self.registration.showNotification("AI아바타", options));
});

// Notification click event
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "explore") {
    event.waitUntil(clients.openWindow("/"));
  }
});

// Service Worker 업데이트 감지 및 클라이언트 알림
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    console.log("Received SKIP_WAITING message, activating new Service Worker");
    self.skipWaiting();
  }

  if (event.data && event.data.type === "CHECK_UPDATE") {
    // 클라이언트에게 새 버전 사용 가능 여부 알림
    event.ports[0].postMessage({
      type: "UPDATE_AVAILABLE",
      version: CACHE_VERSION,
    });
  }
});

// 클라이언트에게 새 Service Worker 활성화 알림
self.addEventListener("controllerchange", () => {
  console.log("Controller changed - new Service Worker is active");
  // 모든 클라이언트에게 새로고침 권장 메시지 전송
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => {
      client.postMessage({
        type: "SW_UPDATED",
        message: "새 버전이 사용 가능합니다. 페이지를 새로고침하세요.",
        version: CACHE_VERSION,
      });
    });
  });
});
