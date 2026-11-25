/**
 * 키움증권 연결 관련 라우터
 *
 * 세션(라이선스 키)마다 독립된 KiwoomService를 쓴다.
 * 전역 인스턴스를 쓰면 A가 연결할 때 B의 토큰을 덮어써서
 * A의 주문이 B 계좌로 나가는 사고가 난다.
 */
import { Router, Request, Response } from 'express'
import { getKiwoom, getUserKey } from '../middleware/auth'
import { kiwoomRegistry } from '../services/kiwoomRegistry'

const router = Router()

// 키움증권 API 연결
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { appkey, secretkey, host } = req.body

    if (!appkey || !secretkey) {
      return res.status(400).json({
        success: false,
        message: 'appkey와 secretkey가 필요합니다'
      })
    }

    // host가 없으면 키움증권 실제 운영 서버 사용 (기본값)
    const apiHost = host || 'https://api.kiwoom.com'
    const kiwoomService = getKiwoom(req)

    // 같은 키움 계정으로 이미 다른 세션이 연결돼 있으면 거부한다.
    // (키움은 계정당 WebSocket 1연결만 허용 — 둘 다 붙으면 시세가 서로 끊긴다)
    const identity = `${apiHost.replace(/\/$/, '')}::${String(appkey).trim()}`
    const duplicateKey = kiwoomRegistry.findDuplicate(identity, getUserKey(req))
    if (duplicateKey) {
      return res.status(409).json({
        success: false,
        error: '이미 같은 키움 계정으로 연결된 세션이 있습니다',
        detail: '동일 계정은 한 곳에서만 연결할 수 있습니다. 기존 세션에서 연결을 해제한 뒤 다시 시도하세요.',
        code: 'DUPLICATE_ACCOUNT_CONNECTION',
      })
    }

    await kiwoomService.connect(apiHost, appkey, secretkey)

    // REST API 연결 성공 후 WebSocket도 자동 연결 시도
    try {
      await kiwoomService.connectWebSocket()
      console.log('[WebSocket] 자동 연결 성공')
    } catch (wsError: any) {
      console.warn('[WebSocket] 자동 연결 실패 (나중에 수동 연결 가능):', wsError.message)
    }

    res.json({
      success: true,
      status: 'connected',
      message: '키움증권 API 연결 성공',
      webSocketConnected: kiwoomService.isWebSocketConnected()
    })
  } catch (error: any) {
    console.error('키움증권 연결 오류:', error)
    res.status(500).json({
      success: false,
      error: '연결 실패',
      message: error.message
    })
  }
})

// 키움증권 API 연결 해제 — 세션도 함께 정리한다
router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    const userKey = getUserKey(req)
    // 다른 사람 세션에 영향을 주지 않도록 이 사용자의 인스턴스만 제거
    kiwoomRegistry.remove(userKey)

    res.json({
      success: true,
      status: 'disconnected',
      message: '키움증권 API 연결 해제 성공'
    })
  } catch (error: any) {
    console.error('키움증권 연결 해제 오류:', error)
    res.status(500).json({
      success: false,
      error: '연결 해제 실패',
      message: error.message
    })
  }
})

// 연결 상태 확인
router.get('/status', (req: Request, res: Response) => {
  const kiwoomService = getKiwoom(req)
  res.json({
    success: true,
    connected: kiwoomService.isConnected(),
    webSocketConnected: kiwoomService.isWebSocketConnected(),
    // 이 세션만의 상태 (다른 사용자 연결 여부는 노출하지 않는다)
    timestamp: new Date().toISOString(),
  })
})

// WebSocket 실시간 시세 연결
router.post('/websocket/connect', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        success: false,
        error: '키움증권 API에 먼저 연결해주세요'
      })
    }

    await kiwoomService.connectWebSocket()

    res.json({
      success: true,
      message: 'WebSocket 실시간 시세 연결 성공'
    })
  } catch (error: any) {
    console.error('WebSocket 연결 오류:', error)
    res.status(500).json({
      success: false,
      error: 'WebSocket 연결 실패',
      message: error.message
    })
  }
})

// WebSocket 실시간 시세 등록
router.post('/websocket/register', async (req: Request, res: Response) => {
  try {
    const { codes } = req.body

    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({
        success: false,
        error: '종목코드 배열이 필요합니다'
      })
    }

    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isWebSocketConnected()) {
      return res.status(400).json({
        success: false,
        error: 'WebSocket이 연결되지 않았습니다'
      })
    }

    kiwoomService.registerRealTimeStocks(codes)

    res.json({
      success: true,
      message: `${codes.length}개 종목 실시간 시세 등록 완료`
    })
  } catch (error: any) {
    console.error('실시간 시세 등록 오류:', error)
    res.status(500).json({
      success: false,
      error: '실시간 시세 등록 실패',
      message: error.message
    })
  }
})

// WebSocket 연결 해제 (API 연결은 유지)
router.post('/websocket/disconnect', async (req: Request, res: Response) => {
  try {
    getKiwoom(req).disconnectWebSocket()

    res.json({
      success: true,
      message: 'WebSocket 연결 해제 성공'
    })
  } catch (error: any) {
    console.error('WebSocket 연결 해제 오류:', error)
    res.status(500).json({
      success: false,
      error: 'WebSocket 연결 해제 실패',
      message: error.message
    })
  }
})

export default router
