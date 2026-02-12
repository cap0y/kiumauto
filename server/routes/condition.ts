/**
 * 조건식 관련 라우터 (키움증권 REST API 연동)
 * 순위정보 API를 사용하여 실제 종목 조회
 */
import { Router, Request, Response } from 'express'
import { KiwoomService } from '../services/kiwoomService'
import { StockConditionService } from '../services/stockConditionService'

const router = Router()
const kiwoomService = KiwoomService.getInstance()
const stockConditionService = StockConditionService.getInstance()

// 조건식 인터페이스
interface Condition {
  id: string
  name: string
  description: string
  enabled: boolean
}

/**
 * 사용 가능한 조건식 목록 조회
 * GET /api/conditions
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    console.log('조건식 목록 조회 요청 받음')
    
    const conditions = stockConditionService.getAvailableConditions()
    
    console.log('조건식 개수:', conditions.length)
    res.json({
      success: true,
      conditions: conditions,
      count: conditions.length,
    })
  } catch (error: any) {
    console.error('조건식 목록 조회 오류:', error)
    res.status(500).json({
      success: false,
      error: '조건식 목록 조회 실패',
      detail: error.message,
    })
  }
})

/**
 * 조건식 검색 실행 (키움증권 순위정보 API 사용)
 * POST /api/conditions/search
 * Body: { conditions: Condition[] }
 */
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { conditions } = req.body

    if (!Array.isArray(conditions)) {
      return res.status(400).json({
        success: false,
        error: '조건식 배열이 필요합니다',
      })
    }

    // 연결 확인
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        success: false,
        error: '키움증권 API에 먼저 연결해주세요',
      })
    }

    const enabledConditions = conditions.filter((c: Condition) => c.enabled)
    
    if (enabledConditions.length === 0) {
      return res.json({
        success: true,
        stocks: [],
        count: 0,
        appliedConditions: [],
      })
    }

    console.log('=== 조건식 검색 시작 ===')
    console.log('선택된 조건식:', enabledConditions.map(c => c.name).join(', '))

    // 모든 선택된 조건식에 대해 순위정보 조회
    const allStocks: any[] = []
    const stockMap = new Map() // 중복 제거용

    for (const condition of enabledConditions) {
      try {
        console.log(`조건식 조회 중: ${condition.name} (${condition.id})`)
        
        // 키움증권 순위정보 API 호출
        const response = await kiwoomService.getRankingInfo(condition.id)
        
        // 키움증권 API 응답 구조 확인 (output 또는 output1 필드)
        let stocks: any[] = []
        if (response) {
          if (Array.isArray(response.output)) {
            stocks = response.output
          } else if (Array.isArray(response.output1)) {
            stocks = response.output1
          } else if (response.output && typeof response.output === 'object') {
            stocks = [response.output]
          } else if (response.output1 && typeof response.output1 === 'object') {
            stocks = [response.output1]
          }
        }
        
        console.log(`응답 데이터 구조 확인:`, {
          hasOutput: !!response?.output,
          hasOutput1: !!response?.output1,
          outputType: typeof response?.output,
          output1Type: typeof response?.output1,
          stocksLength: stocks.length
        })
        
        for (const stock of stocks) {
          // 키움증권 API 응답 필드명 (다양한 형식 지원)
          const code = stock.stk_cd || stock.STK_CD || stock.종목코드 || stock.ISCD || stock.code || ''
          const name = stock.stk_nm || stock.STK_NM || stock.종목명 || stock.HANNAME || stock.name || ''
          const price = parseFloat(stock.prc || stock.PRC || stock.현재가 || stock.PRICE || stock.price || '0')
          const changeRate = parseFloat(
            stock.prdy_chng_rt || 
            stock.PRDY_CHNG_RT || 
            stock.전일대비율 || 
            stock.RATE || 
            stock.changeRate || 
            stock.changePercent || 
            '0'
          )
          const volume = parseFloat(
            stock.acml_vol || 
            stock.ACML_VOL || 
            stock.누적거래량 || 
            stock.VOLUME || 
            stock.volume || 
            '0'
          )
          
          // 시가, 고가 파싱 (다양한 필드명 지원)
          const openPrice = parseFloat(
            stock.open_pric || 
            stock.OPEN_PRIC || 
            stock.open_price || 
            stock.OPEN_PRICE || 
            stock.open || 
            stock.OPEN || 
            stock.시가 || 
            '0'
          )
          const highPrice = parseFloat(
            stock.high_pric || 
            stock.HIGH_PRIC || 
            stock.high_price || 
            stock.HIGH_PRICE || 
            stock.high || 
            stock.HIGH || 
            stock.고가 || 
            '0'
          )
          
          // 전일대비 변동 금액 계산 (등락률과 현재가로 계산)
          const change = changeRate !== 0 && price > 0 
            ? (price * changeRate / 100) 
            : parseFloat(stock.pred_pre || stock.PRED_PRE || stock.전일대비 || stock.DIFF || stock.diff || '0')
          
          if (code && code !== '0000' && !stockMap.has(code)) {
            stockMap.set(code, {
              code: code.toString().padStart(6, '0'), // 6자리 종목코드로 정규화
              name: name || `종목${code}`,
              price: price || 0,
              change: change, // 전일대비 변동 금액
              changeRate: changeRate || 0, // 전일대비 등락률
              volume: volume || 0,
              openPrice: openPrice || 0, // 시가
              highPrice: highPrice || 0, // 고가
              marketCap: 0,
            })
          }
        }
        
        console.log(`${condition.name}: ${stocks.length}개 종목 조회 완료 (중복 제거 후 ${stockMap.size}개)`)
      } catch (error: any) {
        console.error(`${condition.name} 조회 오류:`, error.message)
        console.error('오류 상세:', error.response?.data || error)
        // 오류가 발생해도 계속 진행
      }
    }

    // Map을 배열로 변환
    const resultStocks = Array.from(stockMap.values())
    
    console.log(`=== 총 ${resultStocks.length}개 종목 조회 완료 ===`)
    
    res.json({
      success: true,
      stocks: resultStocks,
      count: resultStocks.length,
      appliedConditions: enabledConditions.map((c: Condition) => c.name),
    })
  } catch (error: any) {
    console.error('조건식 검색 오류:', error)
    res.status(500).json({
      success: false,
      error: '조건식 검색 실패',
      detail: error.message,
    })
  }
})

/**
 * 실시간 급등주 조회 (거래량급증)
 * GET /api/conditions/surge
 */
router.get('/surge', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        success: false,
        error: '키움증권 API에 먼저 연결해주세요',
      })
    }

    // ka10023: 거래량급증요청
    const response = await kiwoomService.getRankingInfo('ka10023')
    
    const stocks: any[] = []
    if (response) {
      let data: any[] = []
      if (Array.isArray(response.output)) {
        data = response.output
      } else if (Array.isArray(response.output1)) {
        data = response.output1
      } else if (response.output && typeof response.output === 'object') {
        data = [response.output]
      } else if (response.output1 && typeof response.output1 === 'object') {
        data = [response.output1]
      }
      
      for (const stock of data) {
        stocks.push({
          code: stock.stk_cd || stock.STK_CD || stock.종목코드 || stock.ISCD || stock.code || '',
          name: stock.stk_nm || stock.STK_NM || stock.종목명 || stock.HANNAME || stock.name || '',
          price: parseFloat(stock.prc || stock.PRC || stock.현재가 || stock.PRICE || stock.price || '0'),
          changeRate: parseFloat(
            stock.prdy_chng_rt || 
            stock.PRDY_CHNG_RT || 
            stock.전일대비율 || 
            stock.RATE || 
            stock.changeRate || 
            stock.changePercent || 
            '0'
          ),
          volume: parseFloat(
            stock.acml_vol || 
            stock.ACML_VOL || 
            stock.누적거래량 || 
            stock.VOLUME || 
            stock.volume || 
            '0'
          ),
        })
      }
    }
    
    res.json({
      success: true,
      stocks: stocks,
      count: stocks.length,
    })
  } catch (error: any) {
    console.error('급등주 조회 오류:', error)
    res.status(500).json({
      success: false,
      error: '급등주 조회 실패',
      detail: error.message,
    })
  }
})

/**
 * 주식 상세 정보 조회
 * GET /api/conditions/stock/:code
 */
router.get('/stock/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params
    
    if (!kiwoomService.isConnected()) {
      return res.status(400).json({
        success: false,
        error: '키움증권 API에 먼저 연결해주세요',
      })
    }

    // 키움증권 API를 통한 종목 상세 정보 조회
    try {
      const stockDetail = await kiwoomService.getCurrentPrice(code)
      
      if (stockDetail && stockDetail.code) {
        return res.json({
          success: true,
          stock: {
            code: stockDetail.code,
            name: stockDetail.name || `종목${code}`,
            price: stockDetail.price || 0,
            changeRate: stockDetail.changePercent || 0,
            volume: stockDetail.volume || 0,
          },
        })
      }
    } catch (apiError: any) {
      console.error('키움증권 API 종목 조회 오류:', apiError.message)
    }

    // API 조회 실패 시 StockConditionService 사용
    const stock = await stockConditionService.getStockDetail(code)
    
    if (!stock) {
      return res.status(404).json({
        success: false,
        error: '종목을 찾을 수 없습니다',
      })
    }

    res.json({
      success: true,
      stock: stock,
    })
  } catch (error: any) {
    console.error('주식 상세 정보 조회 오류:', error)
    res.status(500).json({
      success: false,
      error: '주식 상세 정보 조회 실패',
      detail: error.message,
    })
  }
})

export default router

