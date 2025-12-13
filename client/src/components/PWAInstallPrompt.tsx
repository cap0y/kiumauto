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

    // 이벤트 리스너 등록
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    // Service Worker 업데이트 감지 (등록은 main.tsx에서 수행)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        setShowUpdateAvailable(true);
      });
    }

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    
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

  if (!shouldShowInstallPrompt() && !showUpdateAvailable) return null;

  return (
    <>
      {/* PWA 설치 프롬프트 - 네이티브 앱 설치 프롬프트 스타일 */}
      {shouldShowInstallPrompt() && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
          <div className="bg-gray-800 text-white rounded-2xl shadow-2xl w-full max-w-[400px] border border-gray-700 overflow-hidden">
            {/* 헤더 */}
            <div className="px-6 py-4 border-b border-gray-700">
              <h2 className="text-lg font-semibold">앱 설치</h2>
            </div>
            
            {/* 앱 정보 */}
            <div className="px-6 py-5">
              <div className="flex items-center gap-4 mb-4">
                {/* 앱 아이콘 */}
                <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg">
                  <Download className="w-8 h-8 text-white" />
                </div>
                
                {/* 앱 이름 및 도메인 */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-xl font-semibold mb-1 truncate">키움증권 자동매매</h3>
                  <p className="text-sm text-gray-400 truncate">{window.location.hostname}</p>
                </div>
              </div>
              
              <p className="text-sm text-gray-300 mb-4">
                빠른 접근을 위해 앱을 설치하세요
              </p>
            </div>
            
            {/* 버튼 */}
            <div className="px-6 py-4 border-t border-gray-700 flex gap-3">
              <Button
                size="lg"
                variant="ghost"
                onClick={handleDismissInstall}
                className="flex-1 text-gray-300 hover:text-white hover:bg-gray-700 h-12 text-base"
              >
                취소
              </Button>
              <Button
                size="lg"
                onClick={handleInstallClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-12 text-base font-medium"
              >
                설치
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
