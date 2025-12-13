import { create } from 'zustand'
import { kiwoomApi } from '../api/kiwoom'

interface TradingSettings {
  maxConcurrentStocks: number
  maxDailyTrades: number
  tradingAmountPerStock: number
  commissionRate: number
}

interface DetectedStock {
  code: string
  name: string
  price: number
  changePercent: number
  volume: number
  strategy: string
  detectedAt: Date
}

interface HoldingStock {
  code: string
  name: string
  quantity: number
  avgPrice: number
  currentPrice: number
  profit: number
  profitRate: number
  buyTime: Date
  strategy: string
}

interface OrderLog {
  time: string
  type: 'buy' | 'sell' | 'info'
  message: string
}

interface TradingState {
  isRunning: boolean
  tradingStatus: {
    totalTrades: number
    successfulTrades: number
    failedTrades: number
    totalProfit: number
    startTime: Date | null
  }
  detectedStocks: DetectedStock[]
  holdingStocks: HoldingStock[]
  orderLogs: OrderLog[]
  settings: TradingSettings | null
  
  // Actions
  startTrading: (settings: TradingSettings) => Promise<void>
  stopTrading: () => Promise<void>
  addDetectedStock: (stock: DetectedStock) => void
  updateHoldingStock: (stock: HoldingStock) => void
  removeHoldingStock: (code: string) => void
  addOrderLog: (log: OrderLog) => void
  clearLogs: () => void
}

export const useTradingStore = create<TradingState>((set, get) => ({
  isRunning: false,
  tradingStatus: {
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalProfit: 0,
    startTime: null,
  },
  detectedStocks: [],
  holdingStocks: [],
  orderLogs: [],
  settings: null,

  startTrading: async (settings: TradingSettings) => {
    set({
      isRunning: true,
      settings,
      tradingStatus: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0,
        startTime: new Date(),
      },
    })

    // 자동매매 로직 시작
    const tradingInterval = setInterval(async () => {
      if (!get().isRunning) {
        clearInterval(tradingInterval)
        return
      }

      try {
        await checkAndExecuteTrading()
      } catch (error) {
        console.error('자동매매 오류:', error)
        get().addOrderLog({
          time: new Date().toLocaleTimeString(),
          type: 'info',
          message: `오류: ${error}`,
        })
      }
    }, 3000) // 3초마다 체크

    // 보유 종목 매도 조건 체크
    const sellCheckInterval = setInterval(async () => {
      if (!get().isRunning) {
        clearInterval(sellCheckInterval)
        return
      }

      try {
        await checkSellConditions()
      } catch (error) {
        console.error('매도 조건 체크 오류:', error)
      }
    }, 2000) // 2초마다 체크
  },

  stopTrading: async () => {
    set({ isRunning: false })
  },

  addDetectedStock: (stock: DetectedStock) => {
    set((state) => ({
      detectedStocks: [...state.detectedStocks.filter(s => s.code !== stock.code), stock].slice(0, 100),
    }))
  },

  updateHoldingStock: (stock: HoldingStock) => {
    set((state) => ({
      holdingStocks: state.holdingStocks.map(s => s.code === stock.code ? stock : s),
    }))
  },

  removeHoldingStock: (code: string) => {
    set((state) => ({
      holdingStocks: state.holdingStocks.filter(s => s.code !== code),
    }))
  },

  addOrderLog: (log: OrderLog) => {
    set((state) => ({
      orderLogs: [...state.orderLogs, log].slice(-100), // 최근 100개만 유지
    }))
  },

  clearLogs: () => {
    set({ orderLogs: [] })
  },
}))

// 자동매매 로직 실행
async function checkAndExecuteTrading() {
  const state = useTradingStore.getState()
  if (!state.isRunning || !state.settings) return

  try {
    // 조건 검색 종목 조회
    const stocks = await kiwoomApi.getStocks('0')
    
    // 매수 조건 확인 및 실행
    for (const stock of stocks.slice(0, 30)) {
      if (state.holdingStocks.length >= state.settings.maxConcurrentStocks) {
        break
      }

      // 매수 조건 확인 (간단한 예시)
      const shouldBuy = await checkBuyConditions(stock)
      
      if (shouldBuy) {
        await executeBuyOrder(stock, state.settings)
      }
    }
  } catch (error) {
    console.error('매매 체크 오류:', error)
  }
}

// 매수 조건 확인
async function checkBuyConditions(stock: any): Promise<boolean> {
  // MainFrame.cs의 매수 조건 로직을 여기에 구현
  // 예: 거래량 증가, 등락률 체크 등
  return false // 실제 로직 구현 필요
}

// 매수 주문 실행
async function executeBuyOrder(stock: any, settings: TradingSettings) {
  try {
    const quantity = Math.floor(settings.tradingAmountPerStock / stock.price)
    if (quantity <= 0) return

    const order = await kiwoomApi.placeOrder({
      code: stock.code,
      quantity,
      price: stock.price,
      order_type: 'buy',
      order_option: '01', // 시장가
    })

    useTradingStore.getState().addOrderLog({
      time: new Date().toLocaleTimeString(),
      type: 'buy',
      message: `${stock.name} 매수: ${quantity}주 @ ${stock.price.toLocaleString()}원`,
    })
  } catch (error) {
    console.error('매수 주문 오류:', error)
  }
}

// 매도 조건 체크
async function checkSellConditions() {
  const state = useTradingStore.getState()
  
  for (const holding of state.holdingStocks) {
    // 익절/손절 조건 체크
    const shouldSell = checkSellRules(holding)
    
    if (shouldSell) {
      await executeSellOrder(holding)
    }
  }
}

// 매도 규칙 확인
function checkSellRules(stock: HoldingStock): boolean {
  // 익절: +2% 이상
  if (stock.profitRate >= 2.0) {
    return true
  }
  
  // 손절: -1% 이하
  if (stock.profitRate <= -1.0) {
    return true
  }
  
  // Trailing Stop 등 추가 로직
  return false
}

// 매도 주문 실행
async function executeSellOrder(stock: HoldingStock) {
  try {
    const order = await kiwoomApi.placeOrder({
      code: stock.code,
      quantity: stock.quantity,
      price: stock.currentPrice,
      order_type: 'sell',
      order_option: '01', // 시장가
    })

    useTradingStore.getState().removeHoldingStock(stock.code)
    useTradingStore.getState().addOrderLog({
      time: new Date().toLocaleTimeString(),
      type: 'sell',
      message: `${stock.name} 매도: ${stock.quantity}주 @ ${stock.currentPrice.toLocaleString()}원 (수익률: ${stock.profitRate.toFixed(2)}%)`,
    })
  } catch (error) {
    console.error('매도 주문 오류:', error)
  }
}

