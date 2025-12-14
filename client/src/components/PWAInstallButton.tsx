import React, { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Download, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { usePWA, registerServiceWorker } from "../hooks/usePWA";

export default function PWAInstaller() {
  const { isInstallable, isInstalled, installApp } = usePWA();  
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const location = useLocation();

  useEffect(() => {
    // 서비스워커 미등록 시 등록 시도
    if ("serviceWorker" in navigator && !navigator.serviceWorker.controller) {
      registerServiceWorker();
    }
    // 홈에서는 설치 가능 이벤트가 없어도 항상 배너 노출
    if (location.pathname === "/" && !isInstalled) {
      setShowInstallPrompt(true);
    } else {
      setShowInstallPrompt(false);
    }
  }, [location, isInstalled]);

  // 클릭 시 무조건 installApp 실행
  const handleInstallClick = () => {
    installApp();
  };

  if (!showInstallPrompt || isInstalled) return null;

  return (
    <div className="fixed bottom-24 left-4 right-4 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4 md:bottom-6 pointer-events-auto">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white">
            자동매매 설치
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
             앱을 설치하세요
          </p>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <Button
            size="sm"
            onClick={handleInstallClick}
            className="bg-primary hover:bg-primary/90"
            disabled={!isInstallable}
          >
            <Download className="w-4 h-4 mr-1" /> 설치
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setShowInstallPrompt(false)}
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
