import React, { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Download, X } from "lucide-react";
import { usePWA, registerServiceWorker } from "../hooks/usePWA";

export default function PWAInstaller() {
  const { isInstallable, isInstalled, installApp } = usePWA();
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);

  useEffect(() => {
    // 서비스워커 미등록 시 등록 시도
    if ("serviceWorker" in navigator && !navigator.serviceWorker.controller) {
      registerServiceWorker();
    }
    // 설치되지 않았으면 항상 배너 노출
    if (!isInstalled) {
      // 약간의 지연 후 표시 (페이지 로드 후)
      const timer = setTimeout(() => {
        setShowInstallPrompt(true);
      }, 2000);
      return () => clearTimeout(timer);
    } else {
      setShowInstallPrompt(false);
    }
  }, [isInstalled]);

  // 클릭 시 무조건 installApp 실행
  const handleInstallClick = async () => {
    const result = await installApp();
    if (result) {
      // 설치 성공 시 모달 닫기
      setShowInstallPrompt(false);
    }
    // 설치 실패해도 모달은 계속 표시 (사용자가 다시 시도할 수 있도록)
  };

  if (!showInstallPrompt || isInstalled) return null;

  return (
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
            onClick={() => setShowInstallPrompt(false)}
            className="flex-1 text-blue-400 hover:text-blue-300 hover:bg-gray-700/50 h-8 text-sm font-medium min-w-0"
          >
            취소
          </Button>
          <Button
            size="sm"
            onClick={handleInstallClick}
            disabled={!isInstallable}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-8 text-sm font-semibold shadow min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            추가
          </Button>
        </div>
      </div>
    </div>
  );
}
