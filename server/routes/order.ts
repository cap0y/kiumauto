/**
 * 주문 관련 라우터
 */
import { Router, Request, Response } from 'express'
import { getKiwoom } from '../middleware/auth'

const router = Router()

// 주문 전송
router.post('/', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
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

    // 키움 주문 API(kt10000/kt10001)는 계좌번호를 받지 않는다 (토큰 계좌 기준)
    
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
    // 상세 에러 로깅
    console.error('[주문 전송 오류]', {
      종목코드: req.body.code,
      수량: req.body.quantity,
      가격: req.body.price,
      주문구분: req.body.order_type,
      주문옵션: req.body.order_option,
      에러메시지: error.message,
      에러스택: error.stack,
      응답상태: error.response?.status,
      응답데이터: error.response?.data,
      isMockApiLimit: error.isMockApiLimit,
      isTradingRestricted: error.isTradingRestricted,
      returnCode: error.returnCode,
      stockCode: error.stockCode
    })
    
    // 클라이언트 에러 (400번대)는 그대로 전달
    if (error.message && error.message.includes('지원하지 않는 종목코드')) {
      return res.status(400).json({
        error: error.message,
        detail: '6자리 숫자 종목코드만 지원됩니다'
      })
    }
    
    // 모의투자 환경 제한사항인 경우 (매매제한 종목 포함)
    if (error.isMockApiLimit || error.isTradingRestricted) {
      return res.status(503).json({
        error: '모의투자 환경 제한',
        detail: error.message || '모의투자 환경에서 일부 종목은 주문이 제한될 수 있습니다',
        code: error.stockCode || req.body.code || '알 수 없음',
        isMockApiLimit: true,
        isTradingRestricted: error.isTradingRestricted || false,
        returnCode: error.returnCode
      })
    }
    
    // 서버 에러 (500번대)는 상세 정보 포함
    // 키움 비즈니스 오류는 400으로 전달해야 클라이언트가 "500"이 아닌 실제 사유를 보여줄 수 있다
    const statusCode = error.response?.status || error.status || 400
    const errorMessage = error.message || '알 수 없는 오류가 발생했습니다'
    const errorDetail = error.response?.data?.detail || error.response?.data?.message || errorMessage

    res.status(statusCode >= 500 ? statusCode : 400).json({
      error: '주문 전송 실패',
      detail: errorDetail,
      code: error.stockCode || req.body.code || '알 수 없음', // 실패한 종목코드 포함
      returnCode: error.returnCode || error.response?.data?.return_code,
      returnMsg: error.response?.data?.return_msg,
    })
  }
})

// 주문 취소 (kt10003)
router.post('/cancel', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({ error: '키움증권 API에 연결되지 않았습니다' })
    }

    const { orderNumber, stockCode, quantity } = req.body
    if (!orderNumber || !stockCode || !quantity) {
      return res.status(400).json({ error: 'orderNumber, stockCode, quantity가 필요합니다' })
    }

    const result = await kiwoomService.cancelOrder(orderNumber, stockCode, quantity)
    res.json(result)
  } catch (error: any) {
    console.error('[주문 취소 오류]', {
      주문번호: req.body.orderNumber,
      종목코드: req.body.stockCode,
      에러메시지: error.message,
      응답데이터: error.response?.data,
    })
    const statusCode = error.response?.status || 400
    res.status(statusCode >= 500 ? statusCode : 400).json({
      error: '주문 취소 실패',
      detail: error.response?.data?.detail || error.response?.data?.return_msg || error.message,
      returnCode: error.returnCode || error.response?.data?.return_code,
    })
  }
})

// 주문 내역 조회
router.get('/history', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const accountNo = req.query.accountNo as string

    // 키움 kt00007: 토큰 계좌 기준 조회 (계좌번호 파라미터 없음)
    const orderHistory = await kiwoomService.getOrderHistory(accountNo)

    res.json({
      orders: orderHistory || []
    })
  } catch (error: any) {
    console.error('주문 내역 조회 오류:', error.message)
    res.status(500).json({
      error: '주문 내역 조회 실패',
      detail: error.message,
      orders: []
    })
  }
})

export default router

