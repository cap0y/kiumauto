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
  const [isInstalling, setIsInstalling] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // 이벤트 리스너를 가장 먼저 등록 (beforeinstallprompt는 페이지 로드 전에도 발생할 수 있음)
    const handleBeforeInstallPrompt = (e: Event) => {
      console.log('🚀 PWA 설치 프롬프트 감지됨', e);
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      deferredPromptRef.current = promptEvent;
      setDeferredPrompt(promptEvent);
      setShowInstallPrompt(true);
    };
    
    // 즉시 이벤트 리스너 등록
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt, { passive: false, capture: true });

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
      
      // "추가" 버튼을 눌렀는지 확인 (1시간 동안 모달 표시 안 함)
      const installClicked = localStorage.getItem('pwa-install-clicked');
      if (installClicked) {
        const clickedTime = parseInt(installClicked, 10);
        const oneHour = 60 * 60 * 1000; // 1시간
        if (Date.now() - clickedTime < oneHour) {
          console.log('⏸️ "추가" 버튼을 눌렀으므로 모달 표시 안 함');
          return;
        } else {
          // 1시간이 지났으면 플래그 제거
          localStorage.removeItem('pwa-install-clicked');
        }
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

    // appinstalled 이벤트 리스너 등록
    window.addEventListener("appinstalled", handleAppInstalled);

    // Service Worker 등록 확인 및 강제 등록 시도
    const registerServiceWorker = async () => {
      if (!('serviceWorker' in navigator)) {
        console.warn('⚠️ Service Worker를 지원하지 않는 브라우저입니다.');
        return;
      }

      try {
        // 기존 등록 확인
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          console.log('✅ Service Worker가 이미 등록되어 있습니다:', registration.scope);
          return;
        }

        // Service Worker 등록 시도
        console.log('📝 Service Worker 등록 시도 중...');
        
        // VitePWA가 생성한 Service Worker 경로 시도
        const swPaths = ['/dev-sw.js?dev-sw', '/sw.js', '/service-worker.js'];
        
        for (const swPath of swPaths) {
          try {
            const reg = await navigator.serviceWorker.register(swPath, {
              scope: '/',
              type: 'module'
            });
            console.log('✅ Service Worker 등록 성공:', swPath, reg.scope);
            break;
          } catch (err) {
            console.log('❌ Service Worker 등록 실패:', swPath, err);
          }
        }
      } catch (error) {
        console.error('❌ Service Worker 등록 중 오류:', error);
      }
    };

    // Service Worker 업데이트 감지
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        setShowUpdateAvailable(true);
      });
      
      // Service Worker 등록 시도
      registerServiceWorker();
    }

    // 자동 팝업 표시 확인
    checkAndShowPrompt();
    
    // beforeinstallprompt 이벤트가 늦게 발생할 수 있으므로 추가 대기
    const checkForPrompt = () => {
      // 이미 설정되어 있으면 스킵
      if (deferredPromptRef.current) {
        return;
      }
      
      // 이벤트가 발생했는지 확인 (이벤트는 이미 리스너에서 처리됨)
      // 여기서는 단순히 로그만 남김
      console.log('⏳ beforeinstallprompt 이벤트 대기 중...');
    };
    
    // 5초 후에도 이벤트가 없으면 로그
    setTimeout(() => {
      if (!deferredPromptRef.current) {
        console.warn('⚠️ beforeinstallprompt 이벤트가 아직 발생하지 않았습니다.');
      }
    }, 5000);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
        { capture: true }
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    // 시각적 피드백 시작
    setIsInstalling(true);
    
    // Service Worker 등록 확인 및 시도
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) {
          console.log('📝 Service Worker가 등록되지 않았습니다. 등록 시도 중...');
          const swPaths = ['/dev-sw.js?dev-sw', '/sw.js', '/service-worker.js'];
          for (const swPath of swPaths) {
            try {
              await navigator.serviceWorker.register(swPath, { scope: '/', type: 'module' });
              console.log('✅ Service Worker 등록 성공:', swPath);
              break;
            } catch (err) {
              console.log('❌ Service Worker 등록 실패:', swPath);
            }
          }
          // Service Worker 등록 후 잠시 대기
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error('❌ Service Worker 확인 중 오류:', error);
      }
    }
    
    // deferredPromptRef에서도 확인 (상태 업데이트가 늦을 수 있음)
    const promptToUse = deferredPrompt || deferredPromptRef.current;
    
    console.log('🔘 추가 버튼 클릭됨', { 
      deferredPrompt: !!deferredPrompt,
      deferredPromptRef: !!deferredPromptRef.current,
      promptToUse: !!promptToUse,
      userAgent: navigator.userAgent,
      isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
      protocol: window.location.protocol,
      hasServiceWorker: 'serviceWorker' in navigator
    });
    
    if (promptToUse) {
      // beforeinstallprompt 이벤트가 있는 경우 - 바로 브라우저 네이티브 설치 프롬프트 표시
      console.log('📱 PWA 설치 프롬프트 표시 시작');
      try {
        // 모달을 먼저 닫기 (프롬프트가 제대로 표시되도록)
        setShowInstallPrompt(false);
        
        // 브라우저 네이티브 설치 프롬프트 표시
        console.log('⏳ promptToUse.prompt() 호출 중...');
        console.log('🔍 promptToUse 상세 정보:', {
          platforms: promptToUse.platforms,
          hasPrompt: typeof promptToUse.prompt === 'function',
          hasUserChoice: typeof promptToUse.userChoice === 'object'
        });
        
        // prompt() 호출 (타임아웃 추가)
        const promptPromise = promptToUse.prompt();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('prompt() 타임아웃')), 5000)
        );
        
        await Promise.race([promptPromise, timeoutPromise]);
        console.log('✅ 브라우저 네이티브 프롬프트 표시됨');
        
        setIsInstalling(false);
        
        // userChoice 대기 (타임아웃 추가)
        const userChoicePromise = promptToUse.userChoice;
        const userChoiceTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('userChoice 타임아웃')), 30000)
        );
        
        const { outcome } = await Promise.race([userChoicePromise, userChoiceTimeoutPromise]) as any;
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
      } catch (error: any) {
        console.error('❌ 설치 프롬프트 표시 중 오류:', error);
        console.error('❌ 오류 상세:', {
          message: error?.message,
          name: error?.name,
          stack: error?.stack
        });
        setIsInstalling(false);
        // 오류 발생 시 모달 다시 표시
        setShowInstallPrompt(true);
        
        // HTTP 환경에서의 오류인지 확인
        const isHTTPS = window.location.protocol === 'https:' || 
                        window.location.hostname === 'localhost' || 
                        window.location.hostname === '127.0.0.1';
        
        if (!isHTTPS && error?.message?.includes('prompt')) {
          console.warn('⚠️ HTTP 환경에서는 설치 프롬프트가 제대로 작동하지 않을 수 있습니다.');
        }
      }
    } else {
      // beforeinstallprompt 이벤트가 없는 경우
      console.warn('⚠️ beforeinstallprompt 이벤트가 없습니다. promptToUse가 null입니다.');
      
      const isHTTPS = window.location.protocol === 'https:' || 
                      window.location.hostname === 'localhost' || 
                      window.location.hostname === '127.0.0.1';
      
      console.log('🔍 현재 상태:', {
        hasServiceWorker: 'serviceWorker' in navigator,
        hasManifest: !!document.querySelector('link[rel="manifest"]'),
        isStandalone: window.matchMedia("(display-mode: standalone)").matches,
        protocol: window.location.protocol,
        isHTTPS,
        userAgent: navigator.userAgent
      });
      
      setIsInstalling(false);
      
      // HTTPS가 아닌 경우 안내
      if (!isHTTPS) {
        alert('PWA 설치를 위해서는 HTTPS 연결이 필요합니다.\n\n현재 HTTP 환경에서는 설치할 수 없습니다.\nHTTPS로 접속해주세요.');
        return;
      }
      
      // 모바일 Safari의 경우 다른 방법 안내
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isSafari = /Safari/i.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/i.test(navigator.userAgent);
      
      if (isIOS && isSafari) {
        // iOS Safari는 beforeinstallprompt를 지원하지 않음
        alert('iOS Safari에서는 공유 버튼(□↑)을 누른 후 "홈 화면에 추가"를 선택해주세요.');
      } else {
        // Chrome, Edge 등에서 이벤트가 아직 발생하지 않은 경우
        console.log('⏳ beforeinstallprompt 이벤트 대기 중...');
        
        // 모달을 닫고 일정 시간 동안 다시 표시하지 않음
        setShowInstallPrompt(false);
        setIsInstalling(false);
        
        // "추가" 버튼을 눌렀다는 플래그 저장 (1시간 동안 모달 표시 안 함)
        localStorage.setItem('pwa-install-clicked', Date.now().toString());
        console.log('✅ 모달 닫기 - 1시간 동안 다시 표시하지 않음');
      }
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
                disabled={isInstalling}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-8 text-sm font-semibold shadow min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isInstalling ? '설치 중...' : '추가'}
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
