import React, { useState, useEffect, useRef } from "react";
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
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      console.log('🚀 PWA 설치 프롬프트 감지됨', e);
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      deferredPromptRef.current = promptEvent;
      setDeferredPrompt(promptEvent);
      setShowInstallPrompt(true);
    };

    const handleAppInstalled = () => {
      console.log('✅ PWA가 설치되었습니다');
      setDeferredPrompt(null);
      deferredPromptRef.current = null;
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
        // deferredPromptRef에 이미 설정되어 있으면 상태 업데이트
        if (deferredPromptRef.current) {
          setDeferredPrompt(deferredPromptRef.current);
        }
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
    // deferredPromptRef에서도 확인 (상태 업데이트가 늦을 수 있음)
    const promptToUse = deferredPrompt || deferredPromptRef.current;
    
    console.log('🔘 추가 버튼 클릭됨', { 
      deferredPrompt: !!deferredPrompt,
      deferredPromptRef: !!deferredPromptRef.current,
      promptToUse: !!promptToUse
    });
    
    if (promptToUse) {
      // beforeinstallprompt 이벤트가 있는 경우 - 바로 브라우저 네이티브 설치 프롬프트 표시
      console.log('📱 PWA 설치 프롬프트 표시 시작');
      try {
        // 브라우저 네이티브 설치 프롬프트 표시
        console.log('⏳ promptToUse.prompt() 호출 중...');
        await promptToUse.prompt();
        console.log('✅ 브라우저 네이티브 프롬프트 표시됨');
        
        // 모달 닫기
        setShowInstallPrompt(false);
        
        const { outcome } = await promptToUse.userChoice;
        console.log('📊 사용자 선택 결과:', outcome);
        
        if (outcome === "accepted") {
          console.log("✅ 사용자가 PWA 설치를 승인했습니다");
        } else {
          console.log("❌ 사용자가 PWA 설치를 거부했습니다");
          // 거부한 경우 모달 다시 표시
          setShowInstallPrompt(true);
        }
        
        setDeferredPrompt(null);
        deferredPromptRef.current = null;
      } catch (error) {
        console.error('❌ 설치 프롬프트 표시 중 오류:', error);
        // 오류 발생 시 모달 다시 표시
        setShowInstallPrompt(true);
      }
    } else {
      // beforeinstallprompt 이벤트가 없는 경우 - 모달은 계속 표시
      console.warn('⚠️ beforeinstallprompt 이벤트가 없습니다. promptToUse가 null입니다.');
      console.log('🔍 현재 상태:', {
        hasServiceWorker: 'serviceWorker' in navigator,
        hasManifest: !!document.querySelector('link[rel="manifest"]'),
        isStandalone: window.matchMedia("(display-mode: standalone)").matches,
        protocol: window.location.protocol
      });
      // 모달은 계속 표시 (deferredPrompt가 설정될 때까지 대기)
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
      {/* PWA 설치 프롬프트 - 네이티브 앱 설치 프롬프트(소형 & 컴팩트) */}
      {shouldShowInstallPrompt() && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[9999] flex items-end justify-center p-2 pb-3">
          <div className="bg-gray-800 text-white rounded-xl shadow-xl w-full max-w-[220px] border border-gray-700 overflow-hidden">
            {/* 헤더 */}
            <div className="px-3 py-2 border-b border-gray-700">
              <h2 className="text-base font-bold leading-tight">앱 설치</h2>
            </div>
            
            {/* 앱 정보 */}
            <div className="px-3 py-3">
              <div className="flex items-center gap-2 mb-2">
                {/* 앱 아이콘 - 작은 사이즈 */}
                <div className="w-10 h-10 bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 rounded-lg flex items-center justify-center flex-shrink-0 shadow">
                  <Download className="w-5 h-5 text-white" />
                </div>
                
                {/* 앱 이름 및 도메인 */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold mb-0.5 truncate leading-snug">키움증권 자동매매</h3>
                  <p className="text-xs text-gray-400 truncate leading-none">{window.location.hostname}</p>
                </div>
              </div>
            </div>
            
            {/* 버튼 */}
            <div className="px-3 py-2 border-t border-gray-700 flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismissInstall}
                className="flex-1 text-blue-400 hover:text-blue-300 hover:bg-gray-700/50 h-8 text-sm font-medium min-w-0"
              >
                취소
              </Button>
              <Button
                size="sm"
                onClick={handleInstallClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-8 text-sm font-semibold shadow min-w-0"
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
