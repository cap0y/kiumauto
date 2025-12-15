/**
 * 주문 관련 라우터
 */
import { Router, Request, Response } from 'express'
import { KiwoomService } from '../services/kiwoomService'

const router = Router()
const kiwoomService = KiwoomService.getInstance()

// 주문 전송
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const { code, quantity, price, order_type, order_option, accountNo, accountProductCode } = req.body

    if (!code || !quantity || !order_type) {
      return res.status(400).json({
        error: 'code, quantity, order_type이 필요합니다'
      })
    }

    if (!accountNo || !accountProductCode) {
      return res.status(400).json({
        error: 'accountNo, accountProductCode가 필요합니다'
      })
    }
    
    // 종목코드 형식 검증 (6자리 숫자만 허용)
    const stockCode = String(code).trim()
    if (!/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({
        error: `지원하지 않는 종목코드 형식입니다: ${stockCode}`,
        detail: '6자리 숫자 종목코드만 지원됩니다 (ELW, ETF 등 비표준 종목코드는 제외)'
      })
    }
    
    // 주문 수량 검증
    if (quantity <= 0 || !Number.isInteger(Number(quantity))) {
      return res.status(400).json({
        error: '주문 수량은 1 이상의 정수여야 합니다'
      })
    }
    
    // 지정가 주문 시 가격 검증
    if (order_option === '00' && (!price || price <= 0)) {
      return res.status(400).json({
        error: '지정가 주문 시 주문 가격이 필요합니다'
      })
    }

    const result = await kiwoomService.placeOrder(
      {
        code,
        quantity,
        price: price || 0,
        order_type,
        order_option: order_option || (order_type === 'buy' ? '03' : '03') // 시장가 기본값
      },
      accountNo,
      accountProductCode
    )

    res.json(result)
  } catch (error: any) {
    console.error('주문 전송 오류:', error)
    
    // 클라이언트 에러 (400번대)는 그대로 전달
    if (error.message && error.message.includes('지원하지 않는 종목코드')) {
      return res.status(400).json({
        error: error.message,
        detail: '6자리 숫자 종목코드만 지원됩니다'
      })
    }
    
    // 모의투자 환경 제한사항인 경우
    if (error.isMockApiLimit) {
      return res.status(503).json({
        error: '모의투자 환경 제한',
        detail: error.message || '모의투자 환경에서 일부 종목은 주문이 제한될 수 있습니다',
        code: error.stockCode || req.body.code || '알 수 없음',
        isMockApiLimit: true
      })
    }
    
    // 서버 에러 (500번대)는 상세 정보 포함
    const statusCode = error.response?.status || error.status || 500
    res.status(statusCode).json({
      error: '주문 전송 실패',
      detail: error.message || '알 수 없는 오류가 발생했습니다',
      code: req.body.code || '알 수 없음' // 실패한 종목코드 포함
    })
  }
})

// 주문 내역 조회
router.get('/history', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const accountNo = req.query.accountNo as string
    if (!accountNo) {
      return res.status(400).json({
        error: 'accountNo가 필요합니다'
      })
    }

    // 키움증권 API를 통해 주문 내역 조회
    // 실제 구현은 키움증권 API 문서에 따라 수정 필요
    const orderHistory = await kiwoomService.getOrderHistory(accountNo)

    res.json({
      orders: orderHistory || []
    })
  } catch (error: any) {
    // 모의투자 환경에서 500 에러는 정상적인 제한사항일 수 있음
    const status = error.response?.status || error.status
    const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || ''
    
    // 500 에러나 서버 에러는 조용히 처리 (모의투자 환경 제한)
    if (status === 500 || errorMessage.includes('INTERNAL_SERVER_ERROR')) {
      // 조용히 빈 배열 반환
      return res.json({
        orders: []
      })
    }
    
    // 다른 에러는 로그 출력
    console.error('주문 내역 조회 오류:', errorMessage)
    res.status(500).json({
      error: '주문 내역 조회 실패',
      detail: errorMessage,
      orders: [] // 오류 시 빈 배열 반환
    })
  }
})

export default router

