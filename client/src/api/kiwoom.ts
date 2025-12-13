import apiClient from './client'

export interface KiwoomConfig {
  host: string
  appkey: string
  secretkey: string
}

export interface Stock {
  code: string
  name: string
  price: number
  change: number
  changePercent: number
}

export interface TradingSettings {
  기본매수?: any
  장시작급등주?: any
  볼린저밴드?: any
  장마감종가배팅?: any
  스캘핑매수?: any
  돌파매수?: any
}

export interface OrderRequest {
  code: string
  quantity: number
  price: number
  order_type: 'buy' | 'sell'
  order_option: string
  accountNo?: string
  accountProductCode?: string
}

export const kiwoomApi = {
  // 연결
  connect: async (config: KiwoomConfig) => {
    const response = await apiClient.post('/connect', config)
    return response.data
  },

  // 상태 확인
  getStatus: async () => {
    const response = await apiClient.get('/kiwoom/status')
    return response.data
  },

  // 종목 리스트
  getStocks: async (market: string = '0') => {
    const response = await apiClient.get('/stocks', {
      params: { market }
    })
    return response.data.stocks || []
  },

  // 종목 현재가
  getStockPrice: async (code: string) => {
    const response = await apiClient.get(`/stocks/${code}/price`)
    return response.data
  },

  // 차트 데이터
  getCandle: async (code: string, period: string = 'min', start: string = '', end: string = '') => {
    const response = await apiClient.get(`/stocks/${code}/candle`, {
      params: { period, start, end }
    })
    return response.data.candles || []
  },

  // 계좌 정보
  getAccounts: async (accountNo?: string, accountProductCode?: string) => {
    const response = await apiClient.get('/accounts', {
      params: {
        accountNo: accountNo || '',
        accountProductCode: accountProductCode || '01',
      }
    })
    return response.data
  },

  // 보유 종목
  getBalance: async (accountNo?: string, accountProductCode?: string) => {
    const response = await apiClient.get('/accounts/balance', {
      params: {
        accountNo: accountNo || '',
        accountProductCode: accountProductCode || '01',
      }
    })
    return response.data.stocks || []
  },

  // 주문
  placeOrder: async (order: OrderRequest) => {
    const response = await apiClient.post('/orders', {
      ...order,
      accountNo: order.accountNo || '',
      accountProductCode: order.accountProductCode || '01',
    })
    return response.data
  },

  // 설정 조회
  getSettings: async () => {
    const response = await apiClient.get('/settings')
    return response.data
  },

  // 설정 저장
  saveSettings: async (settings: TradingSettings) => {
    const response = await apiClient.post('/settings', settings)
    return response.data
  },

  // 조건식 목록 조회 (웹 기반)
  getConditions: async () => {
    const response = await apiClient.get('/conditions')
    return response.data
  },

  // 조건식 검색 실행 (웹 기반)
  searchCondition: async (conditions: any[]) => {
    const response = await apiClient.post('/conditions/search', {
      conditions,
    })
    return response.data
  },

  // 실시간 급등주 조회
  getSurgeStocks: async () => {
    const response = await apiClient.get('/conditions/surge')
    return response.data
  },

  // 주식 상세 정보 조회
  getStockDetail: async (code: string) => {
    const response = await apiClient.get(`/conditions/stock/${code}`)
    return response.data
  },

  // 주문 내역 조회
  getOrderHistory: async (accountNo?: string) => {
    const response = await apiClient.get('/orders/history', {
      params: {
        accountNo: accountNo || '',
      }
    })
    return response.data.orders || []
  },

  // 여러 종목의 현재가 일괄 조회
  getMultipleStockPrices: async (codes: string[]) => {
    const response = await apiClient.post('/stocks/prices/batch', {
      codes
    })
    return response.data.prices || []
  },

  // WebSocket 실시간 시세 연결
  connectWebSocket: async () => {
    const response = await apiClient.post('/kiwoom/websocket/connect')
    return response.data
  },

  // WebSocket 실시간 시세 등록
  registerRealTimeStocks: async (codes: string[]) => {
    const response = await apiClient.post('/kiwoom/websocket/register', {
      codes
    })
    return response.data
  },

  // WebSocket 연결 해제
  disconnectWebSocket: async () => {
    const response = await apiClient.post('/kiwoom/websocket/disconnect')
    return response.data
  },
}

