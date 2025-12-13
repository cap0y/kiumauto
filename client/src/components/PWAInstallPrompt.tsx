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

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      console.log('🚀 PWA 설치 프롬프트 감지됨');
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowInstallPrompt(true);
    };

    const handleAppInstalled = () => {
      console.log('✅ PWA가 설치되었습니다');
      setDeferredPrompt(null);
      setShowInstallPrompt(false);
    };

    // 무조건 팝업 표시 (이미 설치되어 있지 않은 경우)
    const checkAndShowPrompt = () => {
      console.log('🔍 PWA 설치 팝업 확인 시작');
      
      // 이미 설치되어 있으면 표시하지 않음
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
      if (isStandalone) {
        console.log('✅ 이미 PWA로 설치되어 있습니다');
        return;
      }

      console.log('📱 PWA 설치 가능 상태:', {
        isStandalone,
        hasManifest: !!document.querySelector('link[rel="manifest"]'),
        hasServiceWorker: 'serviceWorker' in navigator,
        protocol: window.location.protocol,
        hostname: window.location.hostname
      });

      // Service Worker 준비 대기 (최대 3초)
      const showPrompt = () => {
        console.log('✅ PWA 설치 팝업 표시');
        setShowInstallPrompt(true);
      };

      if ('serviceWorker' in navigator) {
        Promise.race([
          navigator.serviceWorker.ready,
          new Promise(resolve => setTimeout(resolve, 3000))
        ]).then(() => {
          setTimeout(showPrompt, 1000);
        }).catch(() => {
          setTimeout(showPrompt, 1000);
        });
      } else {
        // Service Worker가 없어도 팝업 표시
        setTimeout(showPrompt, 2000);
      }
    };

    // 이벤트 리스너 등록
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    // Service Worker 업데이트 감지
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        setShowUpdateAvailable(true);
      });
    }

    // 자동 팝업 표시 확인
    checkAndShowPrompt();

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      // beforeinstallprompt 이벤트가 있는 경우 - 바로 브라우저 네이티브 설치 프롬프트 표시
      console.log('📱 PWA 설치 프롬프트 표시');
      try {
        // 모달을 먼저 닫고 브라우저 네이티브 프롬프트 표시
        setShowInstallPrompt(false);
        
        // 브라우저 네이티브 설치 프롬프트 표시
        await deferredPrompt.prompt();
        
        const { outcome } = await deferredPrompt.userChoice;
        
        if (outcome === "accepted") {
          console.log("✅ 사용자가 PWA 설치를 승인했습니다");
        } else {
          console.log("❌ 사용자가 PWA 설치를 거부했습니다");
          // 거부한 경우 모달 다시 표시
          setShowInstallPrompt(true);
        }
        
        setDeferredPrompt(null);
      } catch (error) {
        console.error('❌ 설치 프롬프트 표시 중 오류:', error);
        // 오류 발생 시 모달 다시 표시
        setShowInstallPrompt(true);
      }
    } else {
      // beforeinstallprompt 이벤트가 없는 경우
      console.log('⚠️ beforeinstallprompt 이벤트가 없습니다.');
      // 모달은 계속 표시 (사용자가 브라우저에서 직접 설치해야 함)
    }
  };

  const handleDismissInstall = () => {
    console.log('🚫 PWA 설치 프롬프트 닫기');
    setShowInstallPrompt(false);
    // 24시간 동안 다시 표시하지 않음
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
  };

  const handleUpdateClick = () => {
    window.location.reload();
  };

  const shouldShowInstallPrompt = () => {
    if (!showInstallPrompt) {
      console.log('❌ showInstallPrompt가 false입니다');
      return false;
    }
    if (window.matchMedia("(display-mode: standalone)").matches) {
      console.log('❌ 이미 standalone 모드입니다');
      return false;
    }
    console.log('✅ 팝업 표시 조건 충족');
    return true;
  };

  // 디버깅: 상태 로그
  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    console.log('🎨 PWA 설치 팝업 상태:', {
      showInstallPrompt,
      deferredPrompt: !!deferredPrompt,
      showUpdateAvailable,
      isStandalone,
      shouldShow: showInstallPrompt && !isStandalone
    });
  }, [showInstallPrompt, deferredPrompt, showUpdateAvailable]);

  if (!shouldShowInstallPrompt() && !showUpdateAvailable) return null;

  return (
    <>
      {/* PWA 설치 프롬프트 - 네이티브 앱 설치 프롬프트 스타일 */}
      {shouldShowInstallPrompt() && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-end justify-center p-4 pb-6">
          <div className="bg-gray-800 text-white rounded-3xl shadow-2xl w-full max-w-[320px] border border-gray-700 overflow-hidden">
            {/* 헤더 */}
            <div className="px-6 py-5 border-b border-gray-700">
              <h2 className="text-2xl font-bold">앱 설치</h2>
            </div>
            
            {/* 앱 정보 */}
            <div className="px-6 py-6">
              <div className="flex items-center gap-5 mb-6">
                {/* 앱 아이콘 - 큰 사이즈 */}
                <div className="w-20 h-20 bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-xl">
                  <Download className="w-10 h-10 text-white" />
                </div>
                
                {/* 앱 이름 및 도메인 */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-2xl font-bold mb-1 truncate">키움증권 자동매매</h3>
                  <p className="text-sm text-gray-400 truncate">{window.location.hostname}</p>
                </div>
              </div>
            </div>
            
            {/* 버튼 */}
            <div className="px-6 py-5 border-t border-gray-700 flex gap-3">
              <Button
                size="lg"
                variant="ghost"
                onClick={handleDismissInstall}
                className="flex-1 text-blue-400 hover:text-blue-300 hover:bg-gray-700/50 h-14 text-lg font-medium"
              >
                취소
              </Button>
              <Button
                size="lg"
                onClick={handleInstallClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-14 text-lg font-semibold shadow-lg"
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
