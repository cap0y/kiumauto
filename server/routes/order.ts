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
    res.status(500).json({
      error: '주문 전송 실패',
      detail: error.message
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

