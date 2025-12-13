/**
 * 키움증권 연결 관련 라우터
 */
import { Router, Request, Response } from 'express'
import { KiwoomService } from '../services/kiwoomService'

const router = Router()
const kiwoomService = KiwoomService.getInstance()

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

// 키움증권 API 연결 해제
router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    await kiwoomService.disconnect()

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
  const isConnected = kiwoomService.isConnected()
  const isWebSocketConnected = kiwoomService.isWebSocketConnected()
  res.json({
    success: true,
    connected: isConnected,
    webSocketConnected: isWebSocketConnected,
    timestamp: new Date().toISOString()
  })
})

// WebSocket 실시간 시세 연결
router.post('/websocket/connect', async (req: Request, res: Response) => {
  try {
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

// WebSocket 연결 해제
router.post('/websocket/disconnect', async (req: Request, res: Response) => {
  try {
    kiwoomService.disconnectWebSocket()

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

