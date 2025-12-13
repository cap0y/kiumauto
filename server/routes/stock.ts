/**
 * 종목 관련 라우터
 */
import { Router, Request, Response } from 'express'
import { KiwoomService } from '../services/kiwoomService'

const router = Router()
const kiwoomService = KiwoomService.getInstance()

// 종목 리스트 조회
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const market = req.query.market as string || '0'
    const stocks = await kiwoomService.getStockList(market)
    res.json({ stocks })
  } catch (error: any) {
    console.error('종목 리스트 조회 오류:', error)
    res.status(500).json({
      error: '종목 리스트 조회 실패',
      detail: error.message
    })
  }
})

// 종목 현재가 조회
router.get('/:code/price', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const { code } = req.params
    const priceData = await kiwoomService.getCurrentPrice(code)
    res.json(priceData)
  } catch (error: any) {
    console.error('현재가 조회 오류:', error)
    res.status(500).json({
      error: '현재가 조회 실패',
      detail: error.message
    })
  }
})

// 여러 종목의 현재가 일괄 조회
router.post('/prices/batch', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const { codes } = req.body
    
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({
        error: '종목코드 배열이 필요합니다'
      })
    }

    // 최대 50개까지만 처리
    const limitedCodes = codes.slice(0, 50)
    const prices = await kiwoomService.getMultipleCurrentPrices(limitedCodes)
    
    res.json({ prices })
  } catch (error: any) {
    console.error('현재가 일괄 조회 오류:', error)
    res.status(500).json({
      error: '현재가 일괄 조회 실패',
      detail: error.message
    })
  }
})

// 차트 데이터 조회
router.get('/:code/candle', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        error: '키움증권 API에 연결되지 않았습니다'
      })
    }

    const { code } = req.params
    const period = req.query.period as string || 'min'
    const start = req.query.start as string || ''
    const end = req.query.end as string || ''

    const candles = await kiwoomService.getCandleData(code, period, start, end)
    res.json({ candles })
  } catch (error: any) {
    console.error('차트 데이터 조회 오류:', error)
    res.status(500).json({
      error: '차트 데이터 조회 실패',
      detail: error.message
    })
  }
})

export default router

