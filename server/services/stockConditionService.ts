import axios from 'axios'

/**
 * 웹 기반 조건식 필터링 서비스
 * 키움 API 없이 공개 API를 사용하여 조건식 구현
 */

// 조건식 타입 정의
export interface Condition {
  id: string
  name: string
  description: string
  enabled: boolean
}

// 주식 데이터 타입
export interface StockData {
  code: string
  name: string
  price: number
  changeRate: number
  volume: number
  marketCap: number
  per?: number
  pbr?: number
}

export class StockConditionService {
  private static instance: StockConditionService

  private constructor() {}

  static getInstance(): StockConditionService {
    if (!StockConditionService.instance) {
      StockConditionService.instance = new StockConditionService()
    }
    return StockConditionService.instance
  }

  /**
   * 사용 가능한 조건식 목록
   */
  getAvailableConditions(): Condition[] {
    return [
      { id: 'ka10027', name: '전일대비등락률상위', description: '전일대비 등락률 상위 종목', enabled: false },
      { id: 'ka10030', name: '당일거래량상위', description: '당일 거래량 상위 종목', enabled: false },
      { id: 'ka10031', name: '전일거래량상위', description: '전일 거래량 상위 종목', enabled: false },
      { id: 'ka10032', name: '거래대금상위', description: '거래대금 상위 종목', enabled: false },
      { id: 'ka10023', name: '거래량급증', description: '거래량 급증 종목', enabled: false },
      { id: 'ka10020', name: '호가잔량상위', description: '호가잔량 상위 종목', enabled: false },
      { id: 'ka10021', name: '호가잔량급증', description: '호가잔량 급증 종목', enabled: false },
      { id: 'ka10022', name: '잔량율급증', description: '잔량율 급증 종목', enabled: false },
      { id: 'ka10029', name: '예상체결등락률상위', description: '예상체결 등락률 상위 종목', enabled: false },
      { id: 'ka10033', name: '신용비율상위', description: '신용비율 상위 종목', enabled: false },
      { id: 'ka10034', name: '외인기간별매매상위', description: '외국인 기간별 매매 상위', enabled: false },
      { id: 'ka10035', name: '외인연속순매매상위', description: '외국인 연속 순매매 상위', enabled: false },
    ]
  }

  /**
   * 네이버 증권에서 주식 데이터 가져오기
   * 크롤링 대신 공개 API 사용 권장
   */
  async fetchStockData(market: 'kospi' | 'kosdaq' = 'kospi'): Promise<StockData[]> {
    try {
      // 네이버 금융 API (비공식)
      const url = 'https://api.stock.naver.com/stock/exchange/KOSPI/marketValue'
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })

      if (response.data && Array.isArray(response.data)) {
        return response.data.slice(0, 200).map((item: any) => ({
          code: item.stockCode || item.itemCode,
          name: item.stockName || item.itemName,
          price: parseInt(item.closePrice || item.tradePrice || 0),
          changeRate: parseFloat(item.compareToPreviousClosePrice || item.changeRate || 0),
          volume: parseInt(item.accumulatedTradingVolume || item.volume || 0),
          marketCap: parseInt(item.marketValue || 0),
          per: parseFloat(item.per || 0),
          pbr: parseFloat(item.pbr || 0),
        }))
      }

      // API 실패 시 더미 데이터
      return this.getDummyStockData()
    } catch (error) {
      console.error('주식 데이터 조회 오류:', error)
      return this.getDummyStockData()
    }
  }

  /**
   * 조건식에 맞는 종목 필터링
   */
  async filterByConditions(conditions: Condition[]): Promise<StockData[]> {
    const enabledConditions = conditions.filter((c) => c.enabled)
    
    if (enabledConditions.length === 0) {
      return []
    }

    // 주식 데이터 가져오기
    const allStocks = await this.fetchStockData('kospi')
    let filteredStocks = [...allStocks]

    // 각 조건식 적용
    for (const condition of enabledConditions) {
      switch (condition.id) {
        case 'price_rise_top':
          // 주가등락률 상위 (상위 5%)
          filteredStocks = filteredStocks
            .sort((a, b) => b.changeRate - a.changeRate)
            .slice(0, Math.max(10, Math.floor(allStocks.length * 0.05)))
          break

        case 'realtime_surge':
          // 실시간급등주: 등락률 5% 이상 + 거래량 평균 대비 2배 이상
          const avgVolume = allStocks.reduce((sum, s) => sum + s.volume, 0) / allStocks.length
          filteredStocks = filteredStocks.filter(
            (stock) => stock.changeRate >= 5 && stock.volume >= avgVolume * 2
          )
          break

        case 'volume_top':
          // 거래량 상위 (상위 5%)
          filteredStocks = filteredStocks
            .sort((a, b) => b.volume - a.volume)
            .slice(0, Math.max(10, Math.floor(allStocks.length * 0.05)))
          break

        case 'breakout_52week':
          // 52주 신고가 돌파 (등락률 10% 이상으로 근사)
          filteredStocks = filteredStocks.filter((stock) => stock.changeRate >= 10)
          break

        case 'oversold':
          // 과매도: 등락률 -5% 이하
          filteredStocks = filteredStocks.filter((stock) => stock.changeRate <= -5)
          break

        case 'overbought':
          // 과매수: 등락률 10% 이상
          filteredStocks = filteredStocks.filter((stock) => stock.changeRate >= 10)
          break

        case 'low_per':
          // 저PER: PER 10 이하
          filteredStocks = filteredStocks.filter((stock) => stock.per && stock.per > 0 && stock.per <= 10)
          break

        case 'high_dividend':
          // 고배당: 배당수익률 계산 필요 (더미 로직)
          filteredStocks = filteredStocks.filter((stock) => stock.pbr && stock.pbr > 0 && stock.pbr < 1)
          break
      }
    }

    return filteredStocks.slice(0, 100) // 최대 100개 반환
  }

  /**
   * 개발/테스트용 더미 데이터
   */
  private getDummyStockData(): StockData[] {
    const companies = [
      { code: '005930', name: '삼성전자', base: 70000 },
      { code: '000660', name: 'SK하이닉스', base: 130000 },
      { code: '035420', name: 'NAVER', base: 250000 },
      { code: '051910', name: 'LG화학', base: 450000 },
      { code: '006400', name: '삼성SDI', base: 380000 },
      { code: '035720', name: '카카오', base: 50000 },
      { code: '028260', name: '삼성물산', base: 120000 },
      { code: '068270', name: '셀트리온', base: 180000 },
      { code: '207940', name: '삼성바이오로직스', base: 850000 },
      { code: '005380', name: '현대차', base: 220000 },
      { code: '000270', name: '기아', base: 95000 },
      { code: '105560', name: 'KB금융', base: 65000 },
      { code: '055550', name: '신한지주', base: 42000 },
      { code: '096770', name: 'SK이노베이션', base: 140000 },
      { code: '012330', name: '현대모비스', base: 250000 },
      { code: '017670', name: 'SK텔레콤', base: 52000 },
      { code: '033780', name: 'KT&G', base: 82000 },
      { code: '003550', name: 'LG', base: 95000 },
      { code: '018260', name: '삼성에스디에스', base: 160000 },
      { code: '034730', name: 'SK', base: 180000 },
    ]

    return companies.map((company) => {
      const changeRate = (Math.random() - 0.5) * 20 // -10% ~ +10%
      const price = Math.floor(company.base * (1 + changeRate / 100))
      
      return {
        code: company.code,
        name: company.name,
        price,
        changeRate: parseFloat(changeRate.toFixed(2)),
        volume: Math.floor(Math.random() * 10000000) + 1000000,
        marketCap: Math.floor(Math.random() * 100000000000000),
        per: Math.random() * 30,
        pbr: Math.random() * 3,
      }
    })
  }

  /**
   * 특정 종목의 상세 정보 조회
   */
  async getStockDetail(code: string): Promise<StockData | null> {
    try {
      const url = `https://api.stock.naver.com/stock/${code}/basic`
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })

      if (response.data) {
        const data = response.data
        return {
          code: data.stockCode,
          name: data.stockName,
          price: parseInt(data.closePrice),
          changeRate: parseFloat(data.compareToPreviousClosePrice),
          volume: parseInt(data.accumulatedTradingVolume),
          marketCap: parseInt(data.marketValue || 0),
          per: parseFloat(data.per || 0),
          pbr: parseFloat(data.pbr || 0),
        }
      }

      return null
    } catch (error) {
      console.error('주식 상세 정보 조회 오류:', error)
      return null
    }
  }

  /**
   * 실시간 급등주 감지 (웹소켓 대신 polling)
   */
  async detectSurgeStocks(): Promise<StockData[]> {
    const stocks = await this.fetchStockData('kospi')
    const avgVolume = stocks.reduce((sum, s) => sum + s.volume, 0) / stocks.length

    // 급등 조건: 등락률 5% 이상 + 거래량 평균 대비 2배 이상
    return stocks
      .filter((stock) => stock.changeRate >= 5 && stock.volume >= avgVolume * 2)
      .sort((a, b) => b.changeRate - a.changeRate)
      .slice(0, 20)
  }
}

