/**
 * 매매 전략 유틸리티
 * MainFrame.cs의 매매 전략 로직을 TypeScript로 구현
 */

export interface StockData {
  code: string
  name: string
  currentPrice: number
  changePercent: number
  volume: number
  highPrice: number
  lowPrice: number
  openPrice: number
  candles?: CandleData[]
}

export interface CandleData {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TradingSettings {
  기본매수?: any
  장시작급등주?: any
  볼린저밴드?: any
  장마감종가배팅?: any
  스캘핑매수?: any
  돌파매수?: any
}

/**
 * 기본매수 조건 확인
 */
export function checkBasicBuyCondition(
  stock: StockData,
  settings: TradingSettings['기본매수']
): boolean {
  if (!settings) return false

  // 거래량 증가율 체크
  if (settings.거래량증가율기준) {
    // 거래량 증가율 계산 로직 필요
  }

  // 최소 등락률 체크
  if (stock.changePercent < settings.최소등락률 || stock.changePercent > settings.최대등락률) {
    return false
  }

  // 최소 거래대금 체크
  const tradingAmount = stock.currentPrice * stock.volume
  if (tradingAmount < settings.최소거래대금) {
    return false
  }

  return true
}

/**
 * 장시작급등주 매수 조건 확인
 */
export function checkEarlyRiseCondition(
  stock: StockData,
  settings: TradingSettings['장시작급등주']
): boolean {
  if (!settings) return false

  const now = new Date()
  const startHour = settings.시작시간_시 || 9
  const startMin = settings.시작시간_분 || 0
  const endHour = settings.종료시간_시 || 9
  const endMin = settings.종료시간_분 || 5

  // 시간 체크
  const currentTime = now.getHours() * 60 + now.getMinutes()
  const startTime = startHour * 60 + startMin
  const endTime = endHour * 60 + endMin

  if (currentTime < startTime || currentTime > endTime) {
    return false
  }

  // 최소 등락률 체크
  if (stock.changePercent < settings.최소등락률) {
    return false
  }

  // 거래량 증가율 체크
  if (settings.거래량증가율기준) {
    // 거래량 증가율 계산 로직 필요
  }

  return true
}

/**
 * 볼린저밴드 매수 조건 확인
 */
export function checkBollingerBandCondition(
  stock: StockData,
  settings: TradingSettings['볼린저밴드']
): boolean {
  if (!settings || !stock.candles || stock.candles.length < 20) {
    return false
  }

  // 볼린저밴드 계산
  const closes = stock.candles.map(c => c.close)
  const ma20 = calculateMA(closes, 20)
  const std = calculateStd(closes, ma20, 20)
  
  const upperBand = ma20 + (2 * std)
  const lowerBand = ma20 - (2 * std)

  // 하단 밴드 근처에서 매수
  const bandPosition = (stock.currentPrice - lowerBand) / (upperBand - lowerBand)
  
  if (bandPosition < 0.2) { // 하단 20% 영역
    return true
  }

  return false
}

/**
 * 스캘핑매수 조건 확인
 */
export function checkScalpingCondition(
  stock: StockData,
  settings: TradingSettings['스캘핑매수']
): boolean {
  if (!settings || !stock.candles || stock.candles.length < 5) {
    return false
  }

  // 저점 확인
  const lows = stock.candles.map(c => c.low)
  const recentLow = Math.min(...lows.slice(-5))
  
  // 저점 대비 상승률
  const riseFromLow = ((stock.currentPrice - recentLow) / recentLow) * 100
  
  if (riseFromLow < settings.저점후최소상승률) {
    return false
  }

  // 거래량 증가 확인
  if (settings.저점후거래량증가기준) {
    const recentVolume = stock.candles.slice(-1)[0].volume
    const avgVolume = stock.candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5
    
    if (recentVolume < avgVolume * settings.저점후거래량증가기준) {
      return false
    }
  }

  return true
}

/**
 * 돌파매수 조건 확인
 */
export function checkBreakoutCondition(
  stock: StockData,
  settings: TradingSettings['돌파매수']
): boolean {
  if (!settings || !stock.candles || stock.candles.length < 20) {
    return false
  }

  // 이전 고점 확인
  const highs = stock.candles.map(c => c.high)
  const previousHigh = Math.max(...highs.slice(0, -1))
  
  // 고점 돌파 확인
  const breakoutRate = ((stock.currentPrice - previousHigh) / previousHigh) * 100
  
  if (breakoutRate < settings.돌파기준율) {
    return false
  }

  // 거래량 증가 확인
  const recentVolume = stock.candles.slice(-1)[0].volume
  const avgVolume = stock.candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5
  
  if (recentVolume < avgVolume * settings.거래량돌파배율) {
    return false
  }

  return true
}

/**
 * 이동평균 계산
 */
function calculateMA(values: number[], period: number): number {
  if (values.length < period) return 0
  const sum = values.slice(-period).reduce((a, b) => a + b, 0)
  return sum / period
}

/**
 * 표준편차 계산
 */
function calculateStd(values: number[], mean: number, period: number): number {
  if (values.length < period) return 0
  const recentValues = values.slice(-period)
  const variance = recentValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period
  return Math.sqrt(variance)
}

/**
 * RSI 계산
 */
export function calculateRSI(candles: CandleData[], period: number = 14): number {
  if (candles.length < period + 1) return 50

  const changes: number[] = []
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close)
  }

  const gains = changes.filter(c => c > 0)
  const losses = changes.filter(c => c < 0).map(c => Math.abs(c))

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

