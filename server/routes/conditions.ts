import express from 'express'
import { StockConditionService, Condition } from '../services/stockConditionService'

const router = express.Router()
const conditionService = StockConditionService.getInstance()

/**
 * 사용 가능한 조건식 목록 조회
 * GET /api/conditions
 */
router.get('/', async (req, res) => {
  try {
    const conditions = conditionService.getAvailableConditions()
    res.json({
      success: true,
      data: conditions,
      count: conditions.length,
    })
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

/**
 * 조건식 검색 실행
 * POST /api/conditions/search
 * Body: { conditions: Condition[] }
 */
router.post('/search', async (req, res) => {
  try {
    const { conditions } = req.body

    if (!Array.isArray(conditions)) {
      return res.status(400).json({
        success: false,
        message: '조건식 배열이 필요합니다',
      })
    }

    const stocks = await conditionService.filterByConditions(conditions)
    
    res.json({
      success: true,
      data: stocks,
      count: stocks.length,
      appliedConditions: conditions.filter((c: Condition) => c.enabled).map((c: Condition) => c.name),
    })
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

/**
 * 실시간 급등주 조회
 * GET /api/conditions/surge
 */
router.get('/surge', async (req, res) => {
  try {
    const stocks = await conditionService.detectSurgeStocks()
    
    res.json({
      success: true,
      data: stocks,
      count: stocks.length,
    })
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

/**
 * 주식 상세 정보 조회
 * GET /api/conditions/stock/:code
 */
router.get('/stock/:code', async (req, res) => {
  try {
    const { code } = req.params
    const stock = await conditionService.getStockDetail(code)
    
    if (!stock) {
      return res.status(404).json({
        success: false,
        message: '종목을 찾을 수 없습니다',
      })
    }

    res.json({
      success: true,
      data: stock,
    })
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

export default router


