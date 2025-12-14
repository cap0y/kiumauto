import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function usePWA() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    console.log('[usePWA] 훅 초기화');

    // PWA 설치 가능 여부 확인
    const handleBeforeInstallPrompt = (e: Event) => {
      console.log('[usePWA] beforeinstallprompt 이벤트 발생');
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsInstallable(true);
    };

    // PWA 설치 완료 확인
    const handleAppInstalled = () => {
      console.log('[usePWA] 앱 설치 완료');
      setIsInstalled(true);
      setIsInstallable(false);
      setDeferredPrompt(null);
    };

    // 이미 설치된 상태인지 확인
    const checkInstallationStatus = () => {
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                          (window.navigator as any).standalone === true ||
                          document.referrer.includes('android-app://');

      if (isStandalone) {
        setIsInstalled(true);
        console.log('[usePWA] 이미 설치된 상태로 실행 중');
      } else {
        console.log('[usePWA] 브라우저에서 실행 중');

        // 브라우저에서 실행 중이면 3초 후 설치 가능으로 표시 (fallback)
        setTimeout(() => {
          if (!deferredPrompt && !isInstalled) {
            console.log('[usePWA] fallback으로 설치 가능 상태 활성화');
            setIsInstallable(true);
          }
        }, 3000);
      }
    };

    // 페이지 로드 시 상태 확인
    checkInstallationStatus();

    // 이벤트 리스너 등록
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    // PWA 설치 가능 상태를 위한 fallback (7초 후)
    const fallbackTimer = setTimeout(() => {
      if (!deferredPrompt && !isInstalled) {
        console.log('[usePWA] 7초 후 fallback 활성화');
        setIsInstallable(true);
      }
    }, 7000);

    // 주기적으로 설치 상태 체크 (모바일에서 브라우저 메뉴 사용 시)
    const installCheckInterval = setInterval(() => {
      if (window.matchMedia('(display-mode: standalone)').matches) {
        if (!isInstalled) {
          setIsInstalled(true);
          setIsInstallable(false);
          console.log('[usePWA] 설치 상태 변경 감지');
        }
      }
    }, 3000);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      clearTimeout(fallbackTimer);
      clearInterval(installCheckInterval);
    };
  }, [deferredPrompt, isInstalled]);

  const installApp = async () => {
    // deferredPrompt가 없으면 이벤트가 발생할 때까지 최대 3초 대기
    if (!deferredPrompt) {
      console.log('[usePWA] deferredPrompt가 없음 - 이벤트 대기 중...');
      
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[usePWA] 이벤트 대기 타임아웃');
          resolve(false);
        }, 3000);
        
        const handler = (e: Event) => {
          console.log('[usePWA] beforeinstallprompt 이벤트 감지됨 (대기 중)');
          e.preventDefault();
          clearTimeout(timeout);
          window.removeEventListener('beforeinstallprompt', handler);
          
          const promptEvent = e as BeforeInstallPromptEvent;
          setDeferredPrompt(promptEvent);
          setIsInstallable(true);
          
          // 즉시 프롬프트 표시
          promptEvent.prompt().then(() => {
            return promptEvent.userChoice;
          }).then(({ outcome }) => {
            if (outcome === 'accepted') {
              setIsInstalled(true);
              setIsInstallable(false);
              console.log('[usePWA] 설치 승인됨');
              resolve(true);
            } else {
              console.log('[usePWA] 설치 거부됨');
              resolve(false);
            }
            setDeferredPrompt(null);
          }).catch((error) => {
            console.error('[usePWA] 설치 중 오류:', error);
            resolve(false);
            setDeferredPrompt(null);
          });
        };
        
        window.addEventListener('beforeinstallprompt', handler, { once: true });
      });
    }

    try {
      console.log('[usePWA] 설치 프롬프트 실행');
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;

      if (outcome === 'accepted') {
        setIsInstalled(true);
        setIsInstallable(false);
        console.log('[usePWA] 설치 승인됨');
        return true;
      } else {
        console.log('[usePWA] 설치 거부됨');
        return false;
      }
    } catch (error) {
      console.error('[usePWA] 설치 중 오류:', error);
      return false;
    } finally {
      setDeferredPrompt(null);
    }
  };

  return {
    isInstallable,
    isInstalled,
    installApp
  };
}

export function usePWAStatus() {
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const checkStandalone = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || 
                        (window.navigator as any).standalone === true ||
                        document.referrer.includes('android-app://');
      setIsStandalone(standalone);
      console.log('[usePWAStatus] 스탠드얼론 모드:', standalone);
    };

    checkStandalone();

    // 미디어 쿼리 변경 감지
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    mediaQuery.addListener(checkStandalone);

    return () => {
      mediaQuery.removeListener(checkStandalone);
    };
  }, []);

  return { isStandalone };
}

// 서비스 워커 등록
export const registerServiceWorker = async () => {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      });

      // 기존 updatefound confirm 로직 제거 - UI 컴포넌트에서 컨트롤
      // registration.addEventListener('updatefound', () => { /* removed */ });

      console.log('[PWA] 서비스 워커 등록 성공:', registration.scope);
      return registration;
    } catch (error) {
      console.error('[PWA] 서비스 워커 등록 실패:', error);
      return null;
    }
  } else {
    console.log('[PWA] 서비스 워커를 지원하지 않는 브라우저');
    return null;
  }
};