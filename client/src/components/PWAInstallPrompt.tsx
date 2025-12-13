import React, { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Download, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [showUpdateAvailable, setShowUpdateAvailable] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);

  useEffect(() => {
    // PWA 설치 가능 여부 진단
    const diagnosePWA = () => {
      const diagnostics = {
        isHTTPS: window.location.protocol === 'https:' || window.location.hostname === 'localhost',
        hasManifest: !!document.querySelector('link[rel="manifest"]'),
        hasServiceWorker: 'serviceWorker' in navigator,
        isStandalone: window.matchMedia("(display-mode: standalone)").matches,
        userAgent: navigator.userAgent,
        url: window.location.href
      };
      
      console.log('🔍 PWA 진단 정보:', diagnostics);
      
      // Service Worker 상태 확인
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
          console.log('📋 등록된 Service Worker:', registrations.length);
          registrations.forEach((reg, index) => {
            console.log(`  SW ${index + 1}:`, {
              scope: reg.scope,
              active: reg.active?.state,
              installing: reg.installing?.state,
              waiting: reg.waiting?.state
            });
          });
        });
      }
      
      // manifest.json 확인
      const manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
      if (manifestLink) {
        fetch(manifestLink.href)
          .then(res => res.json())
          .then(manifest => {
            console.log('📱 manifest.json 내용:', manifest);
          })
          .catch(err => {
            console.error('❌ manifest.json 로드 실패:', err);
          });
      }
    };

    const handleBeforeInstallPrompt = (e: Event) => {
      console.log('🚀 PWA 설치 프롬프트 감지됨', e);
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowInstallPrompt(true);
    };

    // 개발 모드에서 테스트용: localStorage에서 테스트 모드 확인
    const testMode = localStorage.getItem('pwa-test-mode') === 'true';
    if (testMode && !window.matchMedia("(display-mode: standalone)").matches) {
      setIsTestMode(true);
      setShowInstallPrompt(true);
    }

    // 개발 환경에서 자동으로 팝업 표시 (테스트용)
    const isDev = window.location.hostname === 'localhost' || 
                  window.location.hostname === '127.0.0.1' ||
                  window.location.hostname.includes('localhost');
    
    if (isDev && !window.matchMedia("(display-mode: standalone)").matches) {
      setTimeout(() => {
        console.log('🧪 개발 모드: PWA 설치 팝업 자동 표시');
        setShowInstallPrompt(true);
        setIsTestMode(true);
      }, 2000);
    }

    const handleAppInstalled = () => {
      console.log('✅ PWA가 설치되었습니다');
      setDeferredPrompt(null);
      setShowInstallPrompt(false);
    };

    // 진단 실행
    diagnosePWA();

    // 이벤트 리스너 등록
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    // Service Worker 업데이트 감지
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        console.log('🔄 Service Worker 컨트롤러 변경됨');
        setShowUpdateAvailable(true);
      });
      
      // Service Worker 준비 상태 확인
      navigator.serviceWorker.ready.then(registration => {
        console.log('✅ Service Worker 준비됨:', registration.scope);
      }).catch(err => {
        console.error('❌ Service Worker 준비 실패:', err);
      });
    }

    // beforeinstallprompt 이벤트가 발생하지 않는 경우 진단
    const timeoutId = setTimeout(() => {
      if (!deferredPrompt && !window.matchMedia("(display-mode: standalone)").matches) {
        console.warn('⚠️ beforeinstallprompt 이벤트가 발생하지 않았습니다.');
        console.warn('가능한 원인:');
        console.warn('  1. 이미 PWA가 설치되어 있음');
        console.warn('  2. HTTPS가 아님 (Replit은 HTTPS 제공)');
        console.warn('  3. manifest.json 문제');
        console.warn('  4. Service Worker 미등록');
        console.warn('  5. 브라우저 미지원 (Chrome, Edge 권장)');
        console.warn('  6. PWA 설치 조건 미충족 (최소 2회 방문 필요할 수 있음)');
      }
    }, 5000);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    // 테스트 모드이거나 deferredPrompt가 있는 경우
    if (deferredPrompt) {
      console.log('📱 PWA 설치 시작');
      deferredPrompt.prompt();
      
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === "accepted") {
        console.log("✅ 사용자가 PWA 설치를 승인했습니다");
      } else {
        console.log("❌ 사용자가 PWA 설치를 거부했습니다");
      }
      
      setDeferredPrompt(null);
      setShowInstallPrompt(false);
    } else if (isTestMode) {
      // 테스트 모드: 브라우저 기본 설치 프롬프트 안내
      console.log('📱 테스트 모드: 실제 설치를 위해서는 브라우저의 설치 메뉴를 사용하세요');
      alert('PWA 설치를 위해서는:\n\nChrome/Edge: 주소창 오른쪽의 설치 아이콘 클릭\n또는 메뉴 > 앱 설치\n\nSafari iOS: 공유 버튼 > 홈 화면에 추가');
      setShowInstallPrompt(false);
    }
  };

  const handleDismissInstall = () => {
    console.log('🚫 PWA 설치 프롬프트 닫기');
    setShowInstallPrompt(false);
  };

  const handleUpdateClick = () => {
    window.location.reload();
  };

  const shouldShowInstallPrompt = () => {
    if (!showInstallPrompt) return false;
    if (window.matchMedia("(display-mode: standalone)").matches) return false;
    return true;
  };

  // 개발자 도구에서 수동으로 팝업 표시하는 함수 (전역으로 노출)
  useEffect(() => {
    (window as any).showPWAInstallPrompt = () => {
      console.log('🔧 수동으로 PWA 설치 팝업 표시');
      setShowInstallPrompt(true);
      setIsTestMode(true);
    };
    
    (window as any).hidePWAInstallPrompt = () => {
      console.log('🔧 PWA 설치 팝업 숨김');
      setShowInstallPrompt(false);
    };

    return () => {
      delete (window as any).showPWAInstallPrompt;
      delete (window as any).hidePWAInstallPrompt;
    };
  }, []);

  if (!shouldShowInstallPrompt() && !showUpdateAvailable) return null;

  return (
    <>
      {/* PWA 설치 프롬프트 - 작고 깔끔한 디자인 */}
      {shouldShowInstallPrompt() && (
        <div className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[9999] md:bottom-6">
          <div className="bg-gray-900 text-white rounded-2xl shadow-2xl p-4 max-w-[280px] border border-gray-700">
            <div className="flex items-start mb-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center mr-3 flex-shrink-0">
                <Download className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold">앱 설치하기</h3>
                <p className="text-xs text-gray-300 mt-0.5">
                  빠른 접근을 위해 설치해세요
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismissInstall}
                className="flex-1 text-gray-300 hover:text-white hover:bg-gray-800 h-9"
              >
                취소
              </Button>
              <Button
                size="sm"
                onClick={handleInstallClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-9"
              >
                추가
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 업데이트 알림 */}
      {showUpdateAvailable && (
        <div className="fixed top-4 left-4 right-4 z-50 bg-blue-600 text-white rounded-lg shadow-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h3 className="text-sm font-medium">새 버전 사용 가능</h3>
              <p className="text-xs opacity-90 mt-1">
                새로운 기능과 개선사항이 포함된 업데이트가 있습니다
              </p>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleUpdateClick}
                className="bg-white text-blue-600 hover:bg-gray-100"
              >
                업데이트
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowUpdateAvailable(false)}
                className="text-white hover:bg-blue-700"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
