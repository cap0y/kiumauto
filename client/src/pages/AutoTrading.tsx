import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { kiwoomApi } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'
import { useThemeStore } from '../store/useThemeStore'
import toast from 'react-hot-toast'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Bar,
} from 'recharts'

// 타입 선언 (process.env 및 NodeJS 타입 지원)
declare namespace NodeJS {
  interface Timeout {}
}

declare const process: {
  env: {
    NODE_ENV?: string
  }
}

/**
 * 자동매매 메인 페이지 - MainFrame.cs 스타일 GUI
 * 데스크톱 애플리케이션과 유사한 인터페이스
 */
interface Condition {
  id: string
  name: string
  description: string
  enabled: boolean
}

interface DetectedStock {
  code: string
  name: string
  price: number
  change: number
  changePercent: number
  volume: number
  detectedCondition: string
  detectedTime: string
  startPrice?: number // 자동매매 시작 시점의 가격 (상대 변화율 계산용)
  detectedChangePercent?: number // 조건 감지 시점의 등락률 (매수 조건 비교용)
}

interface HoldingStock {
  code: string
  name: string
  quantity: number
  purchasePrice: number
  currentPrice: number
  profit: number
  profitPercent: number
  maxProfitPercent: number
}

interface OrderLog {
  id: number
  date: string
  time: string
  type: 'buy' | 'sell' | 'cancel'
  stockName: string
  stockCode: string
  quantity: number
  price: number
  status: string
  orderNumber?: string
}

interface LogMessage {
  id: number
  time: string
  message: string
  level: 'info' | 'warning' | 'error' | 'success'
}

// 차트 컴포넌트
const StockChart = ({ code, period, isConnected, stockInfo, isSelected = true }: { 
  code: string, 
  period: string, 
  isConnected: boolean,
  stockInfo?: DetectedStock | null,
  isSelected?: boolean // 선택된 종목인지 여부
}) => {
  const { connected } = useKiwoomStore() // 연결 상태 직접 확인
  const { theme } = useThemeStore() // 테마 상태 가져오기
  
  const { data: candles = [], isLoading, error } = useQuery(
    ['candle', code, period],
    () => kiwoomApi.getCandle(code, period),
    {
      enabled: (isConnected || connected) && !!code && isSelected, // 선택한 종목에 대해서만 조회
      refetchInterval: isSelected ? 10000 : false, // 선택한 종목에 대해서만 10초마다 갱신
      retry: false, // 500 에러는 재시도하지 않음
      onSuccess: (data) => {
        // 성공 시 데이터 확인 (개발 환경에서만)
        if (process.env.NODE_ENV === 'development') {
          console.log(`[차트 컴포넌트] 종목코드: ${code}, 기간: ${period}, 데이터 개수: ${data?.length || 0}`)
        }
      },
      onError: (err: any) => {
        // 에러 처리
        const status = err.response?.status || err.status
        if (process.env.NODE_ENV === 'development') {
          console.error(`[차트 컴포넌트] 종목코드: ${code}, 기간: ${period}, 에러:`, {
            status,
            message: err.response?.data?.error || err.message
          })
        }
      },
    }
  )

  // 연결 상태 확인 (둘 중 하나라도 true이면 연결된 것으로 간주)
  const isApiConnected = isConnected || connected
  
  if (!isApiConnected) {
    return (
      <div style={{ 
        padding: '20px', 
        textAlign: 'center',
        backgroundImage: theme === 'dark' 
          ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
          : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        color: theme === 'dark' ? '#9ca3af' : '#6b7280'
      }}>
        키움증권 API에 연결해주세요
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: theme === 'dark' ? '#d1d5db' : '#6b7280' }}>
        차트 데이터를 불러오는 중...
      </div>
    )
  }

  // 에러 처리 - 에러가 발생해도 종목 정보가 있으면 차트 표시 시도
  if (error) {
    const status = (error as any).response?.status || (error as any).status
    const errorMessage = (error as any).response?.data?.error || (error as any).message || ''
    
    // 디버깅을 위한 로그 (개발 환경에서만)
    if (process.env.NODE_ENV === 'development') {
      console.log('[차트 에러]', { code, period, status, errorMessage, stockInfo })
    }
    
    // 에러가 발생했지만 종목 정보가 있으면 차트 표시 시도
    if (stockInfo && stockInfo.price && stockInfo.price > 0) {
      // 아래 로직으로 진행 (차트 데이터가 없을 때 처리)
    } else {
      // 종목 정보도 없으면 에러 메시지 표시
      if (status === 500) {
        return (
          <div style={{ padding: '20px', textAlign: 'center', color: theme === 'dark' ? '#d1d5db' : '#6b7280' }}>
            차트 데이터를 불러올 수 없습니다 (서버 오류)
          </div>
        )
      }
      
      return (
        <div style={{ padding: '20px', textAlign: 'center', color: '#ef4444' }}>
          차트 데이터 조회 실패: {errorMessage || '알 수 없는 오류'}
        </div>
      )
    }
  }

  // 차트 데이터가 없을 때 종목 정보를 사용하여 대체 데이터 생성
  if (!candles || candles.length === 0) {
    // 디버깅 로그
    if (process.env.NODE_ENV === 'development') {
      console.log(`[차트 컴포넌트] 차트 데이터 없음 - 종목코드: ${code}, stockInfo:`, stockInfo)
    }
    
    // 종목 정보가 있으면 현재가를 기반으로 간단한 차트 생성
    if (stockInfo && stockInfo.price && stockInfo.price > 0) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[차트 컴포넌트] 종목 정보로 대체 차트 생성 - 가격: ${stockInfo.price}`)
      }
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      
      // 일봉인 경우 날짜만, 분봉인 경우 날짜+시간
      const dateStr = period === 'day' 
        ? `${year}${month}${day}` 
        : `${year}${month}${day}${hours}${minutes}`
      
      // 현재가를 기반으로 차트 데이터 생성 (여러 데이터 포인트 생성)
      const price = stockInfo.price
      const changePercent = stockInfo.changePercent || 0
      // 등락률이 있으면 그에 맞게, 없으면 가격의 1% 범위로 추정
      const changeRange = changePercent !== 0 
        ? Math.abs(price * (changePercent / 100))
        : price * 0.01
      
      // 여러 데이터 포인트 생성 (20개)
      const dataPointCount = 20
      const fallbackChartData: Array<{
        time: string
        open: number
        high: number
        low: number
        close: number
        volume: number
      }> = []
      
      for (let i = dataPointCount - 1; i >= 0; i--) {
        const timeOffset = period === 'day' ? i : i * (period === 'min' ? 1 : parseInt(period))
        const pointDate = new Date(now.getTime() - timeOffset * (period === 'day' ? 24 * 60 * 60 * 1000 : 60 * 1000))
        
        const pointYear = pointDate.getFullYear()
        const pointMonth = String(pointDate.getMonth() + 1).padStart(2, '0')
        const pointDay = String(pointDate.getDate()).padStart(2, '0')
        const pointHours = String(pointDate.getHours()).padStart(2, '0')
        const pointMinutes = String(pointDate.getMinutes()).padStart(2, '0')
        
        const pointDateStr = period === 'day' 
          ? `${pointYear}${pointMonth}${pointDay}` 
          : `${pointYear}${pointMonth}${pointDay}${pointHours}${pointMinutes}`
        
        // 시간에 따른 가격 변동 시뮬레이션 (현재가를 중심으로 약간의 변동)
        const progress = i / dataPointCount // 0 (과거) ~ 1 (현재)
        const randomVariation = (Math.random() - 0.5) * changeRange * 0.3 // 랜덤 변동
        const trendVariation = changePercent > 0 
          ? changeRange * progress * 0.5 // 상승 추세
          : -changeRange * progress * 0.5 // 하락 추세
        
        const pointPrice = price - trendVariation + randomVariation
        const pointHigh = pointPrice + changeRange * 0.3
        const pointLow = pointPrice - changeRange * 0.3
        const pointOpen = i === dataPointCount - 1 ? price : (fallbackChartData.length > 0 ? fallbackChartData[fallbackChartData.length - 1].close : pointPrice)
        const pointClose = pointPrice
        
        fallbackChartData.push({
          time: pointDateStr,
          open: Math.max(pointLow, pointOpen),
          high: Math.max(pointHigh, pointPrice),
          low: Math.min(pointLow, pointPrice),
          close: pointPrice,
          volume: stockInfo.volume ? Math.floor(stockInfo.volume * (0.5 + Math.random() * 0.5)) : 0,
        })
      }
      
      // 시간 순서대로 정렬 (과거 -> 현재)
      fallbackChartData.reverse()
      
      // Y축 범위 계산
      const allPrices = fallbackChartData.flatMap(d => [d.high, d.low, d.open, d.close])
      const minPrice = Math.min(...allPrices)
      const maxPrice = Math.max(...allPrices)
      const yAxisPriceRange = maxPrice - minPrice || maxPrice * 0.1
      const yAxisMin = Math.max(0, minPrice - yAxisPriceRange * 0.1)
      const yAxisMax = maxPrice + yAxisPriceRange * 0.1
      
      return (
        <div style={{ width: '100%', height: '300px', backgroundColor: theme === 'dark' ? '#1f2937' : 'transparent' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={fallbackChartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme === 'dark' ? '#4b5563' : '#e5e7eb'} />
              <XAxis 
                dataKey="time" 
                tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                tickFormatter={(value) => {
                  if (period === 'day') {
                    return value.substring(4, 8) // YYYYMMDD -> MMDD
                  }
                  return value.substring(8, 12) // HHMM
                }}
              />
              <YAxis 
                yAxisId="price"
                domain={[yAxisMin, yAxisMax]}
                tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                tickFormatter={(value) => value.toLocaleString()}
              />
              <YAxis 
                yAxisId="volume"
                orientation="right"
                tick={{ fontSize: 10, fill: theme === 'dark' ? '#9ca3af' : '#6b7280' }}
                tickFormatter={(value) => {
                  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
                  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
                  return value.toString()
                }}
              />
              <Tooltip 
                contentStyle={{
                  backgroundColor: theme === 'dark' ? '#374151' : '#ffffff',
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  borderRadius: '6px',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  fontSize: '11px',
                  padding: '4px 8px'
                }}
                labelStyle={{ 
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  fontSize: '11px',
                  marginBottom: '2px'
                }}
                itemStyle={{
                  padding: '1px 0',
                  fontSize: '11px'
                }}
                formatter={(value: any, name: string) => {
                  if (name === 'volume') {
                    return [value.toLocaleString(), '거래량']
                  }
                  return [value.toLocaleString(), name]
                }}
                labelFormatter={(label) => `시간: ${label}`}
              />
              <Bar 
                yAxisId="volume"
                dataKey="volume" 
                fill={theme === 'dark' ? '#6b7280' : '#e5e7eb'} 
                opacity={0.3}
                name="거래량"
              />
              <Line 
                yAxisId="price"
                type="monotone" 
                dataKey="close" 
                stroke="#3b82f6" 
                strokeWidth={2}
                dot={true}
                name="종가"
              />
              <Line 
                yAxisId="price"
                type="monotone" 
                dataKey="high" 
                stroke="#22c55e" 
                strokeWidth={1}
                dot={true}
                strokeDasharray="2 2"
                name="고가"
              />
              <Line 
                yAxisId="price"
                type="monotone" 
                dataKey="low" 
                stroke="#ef4444" 
                strokeWidth={1}
                dot={true}
                strokeDasharray="2 2"
                name="저가"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ padding: '8px', textAlign: 'center', fontSize: '11px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>
            * 현재가 정보를 기반으로 표시된 차트입니다
          </div>
        </div>
      )
    }
    
    // 종목 정보도 없으면 메시지 표시
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: theme === 'dark' ? '#d1d5db' : '#6b7280' }}>
        <div style={{ marginBottom: '8px' }}>
          차트 데이터가 없습니다
        </div>
        <div style={{ fontSize: '12px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>
          종목코드: {code} | 기간: {period === 'min' ? '1분' : period === 'day' ? '일봉' : `${period}분`}
        </div>
        <div style={{ fontSize: '11px', color: theme === 'dark' ? '#9ca3af' : '#6b7280', marginTop: '8px' }}>
          모의투자 환경에서는 일부 종목의 차트 데이터를 제공하지 않을 수 있습니다.
        </div>
      </div>
    )
  }

  // 차트 데이터 변환
  const chartData = candles
    .map((candle: any) => {
      const time = candle.일자 || candle.time || ''
      const open = parseFloat(candle.시가 || candle.open || '0') || 0
      const high = parseFloat(candle.고가 || candle.high || '0') || 0
      const low = parseFloat(candle.저가 || candle.low || '0') || 0
      const close = parseFloat(candle.종가 || candle.close || '0') || 0
      const volume = parseFloat(candle.거래량 || candle.volume || '0') || 0
      
      // 유효한 데이터만 반환
      if (!time || (open === 0 && high === 0 && low === 0 && close === 0)) {
        return null
      }
      
      return {
        time,
        open,
        high,
        low,
        close,
        volume,
      }
    })
    .filter((item: any) => item !== null) // null 제거
    .reverse() // 최신 데이터가 뒤에 오도록
  
  // 변환 후에도 데이터가 없으면 메시지 표시
  if (chartData.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: theme === 'dark' ? '#d1d5db' : '#6b7280' }}>
        유효한 차트 데이터가 없습니다
      </div>
    )
  }

  // Y축 범위 계산
  const prices = chartData.flatMap(d => [d.high, d.low, d.open, d.close]).filter(p => p > 0)
  let yAxisMin = 0
  let yAxisMax = 0
  
  if (prices.length > 0) {
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    const priceRange = maxPrice - minPrice || maxPrice * 0.1 // 데이터가 1개일 때를 대비
    yAxisMin = Math.max(0, minPrice - priceRange * 0.1)
    yAxisMax = maxPrice + priceRange * 0.1
  } else {
    // 가격 데이터가 없는 경우 기본값 설정
    yAxisMin = 0
    yAxisMax = 1000
  }

  return (
    <div style={{ width: '100%', height: '300px', backgroundColor: theme === 'dark' ? '#1f2937' : 'transparent' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme === 'dark' ? '#4b5563' : '#e5e7eb'} />
          <XAxis 
            dataKey="time" 
            tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
            tickFormatter={(value) => {
              if (period === 'day') {
                return value.substring(4, 8) // YYYYMMDD -> MMDD
              }
              return value.substring(8, 12) // HHMM
            }}
          />
          <YAxis 
            yAxisId="price"
            domain={[yAxisMin, yAxisMax]}
            tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
            tickFormatter={(value) => value.toLocaleString()}
          />
          <YAxis 
            yAxisId="volume"
            orientation="right"
            tick={{ fontSize: 10, fill: theme === 'dark' ? '#9ca3af' : '#6b7280' }}
            tickFormatter={(value) => {
              if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
              if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
              return value.toString()
            }}
          />
          <Tooltip 
            contentStyle={{
              backgroundColor: theme === 'dark' ? '#374151' : '#ffffff',
              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
              borderRadius: '6px',
              color: theme === 'dark' ? '#f3f4f6' : '#111827',
              fontSize: '11px',
              padding: '4px 8px'
            }}
            formatter={(value: any, name: string) => {
              if (name === 'volume') {
                return [value.toLocaleString(), '거래량']
              }
              return [value.toLocaleString(), name]
            }}
            labelFormatter={(label) => `시간: ${label}`}
            labelStyle={{ 
              color: theme === 'dark' ? '#f3f4f6' : '#111827',
              fontSize: '11px',
              marginBottom: '2px'
            }}
            itemStyle={{
              padding: '1px 0',
              fontSize: '11px'
            }}
          />
          <Bar 
            yAxisId="volume"
            dataKey="volume" 
            fill={theme === 'dark' ? '#6b7280' : '#e5e7eb'} 
            opacity={0.3}
            name="거래량"
          />
          <Line 
            yAxisId="price"
            type="monotone" 
            dataKey="close" 
            stroke="#3b82f6" 
            strokeWidth={2}
            dot={false}
            name="종가"
          />
          <Line 
            yAxisId="price"
            type="monotone" 
            dataKey="high" 
            stroke="#22c55e" 
            strokeWidth={1}
            dot={false}
            strokeDasharray="2 2"
            name="고가"
          />
          <Line 
            yAxisId="price"
            type="monotone" 
            dataKey="low" 
            stroke="#ef4444" 
            strokeWidth={1}
            dot={false}
            strokeDasharray="2 2"
            name="저가"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

const AutoTrading = () => {
  const { connected, checkStatus } = useKiwoomStore()
  const { theme, toggleTheme } = useThemeStore()
  const queryClient = useQueryClient()
  
  // 계좌 연결 상태
  const [appkey, setAppkey] = useState<string>('')
  const [secretkey, setSecretkey] = useState<string>('')
  const [licenseKey, setLicenseKey] = useState<string>('') // 발급된 키
  const [keyInfo, setKeyInfo] = useState<{ expiresAt?: string; remainingDays?: number } | null>(null) // 키 정보
  const [apiMode, setApiMode] = useState<'real' | 'virtual'>('virtual') // 실전/모의투자
  const [isConnecting, setIsConnecting] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [useLicenseKey, setUseLicenseKey] = useState<boolean>(true) // 라이선스 키 사용 여부
  const [adminCode, setAdminCode] = useState<string>('') // 관리자 코드 입력
  const [showAdminPanel, setShowAdminPanel] = useState<boolean>(false) // 관리자 패널 표시 여부
  const [showAdminIcon, setShowAdminIcon] = useState<boolean>(false) // 관리자 아이콘 표시 여부 (F12로 토글)
  const [adminValidDays, setAdminValidDays] = useState<number>(60) // 관리자 키 발급 유효기간
  const [adminIssuedBy, setAdminIssuedBy] = useState<string>('admin') // 관리자 발급자
  const [adminDescription, setAdminDescription] = useState<string>('') // 관리자 설명
  const [isIssuingKey, setIsIssuingKey] = useState<boolean>(false) // 키 발급 중
  
  const [isRunning, setIsRunning] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<string>('')
  const [conditions, setConditions] = useState<Condition[]>([])
  const [detectedStocks, setDetectedStocks] = useState<DetectedStock[]>([])
  const [watchlistStocks, setWatchlistStocks] = useState<DetectedStock[]>([]) // 선택된 종목 (지속 유지)
  
  // 검색된 종목 페이지네이션
  const [displayedStockCount, setDisplayedStockCount] = useState<number>(20) // 표시할 종목 수
  const stocksScrollRef = useRef<HTMLDivElement>(null)
  
  // 컬럼 너비 상태
  const [columnWidths, setColumnWidths] = useState<{ [key: string]: number }>({
    name: 80,
    price: 80,
    change: 70,
    changePercent: 70,
    openPercent: 70,
    highPercent: 70,
    volume: 90,
    action: 60,
    detectedTime: 100
  })
  const [resizingColumn, setResizingColumn] = useState<string | null>(null)
  const [resizeStartX, setResizeStartX] = useState<number>(0)
  const [resizeStartWidth, setResizeStartWidth] = useState<number>(0)
  
  // 차트 관련 상태
  const [selectedStockForChart, setSelectedStockForChart] = useState<DetectedStock | null>(null)
  const [chartPeriod, setChartPeriod] = useState<'min' | '5' | '15' | '30' | '60' | 'day'>('5')
  
  const [holdingStocks, setHoldingStocks] = useState<HoldingStock[]>([])
  const [orderLogs, setOrderLogs] = useState<OrderLog[]>([])
  const [logs, setLogs] = useState<LogMessage[]>([])
  const [showLogSection, setShowLogSection] = useState<boolean>(false) // 로그 섹션 표시 여부
  const [activeTab, setActiveTab] = useState<'orders' | 'conditions' | 'strategies'>('orders')
  const [buyType, setBuyType] = useState<'cash' | 'credit'>('cash')
  const [selectedConditionText, setSelectedConditionText] = useState<string>('선택된 조건식이 없습니다. 조건식을 체크해주세요.')
  
  // 매매 제한 추적 (종목당 매매횟수, 당일 매매종목수)
  const [stockTradeCounts, setStockTradeCounts] = useState<Map<string, number>>(new Map()) // 종목별 매매 횟수
  const [dailyTradedStocks, setDailyTradedStocks] = useState<Set<string>>(new Set()) // 당일 매매한 종목 목록
  const [dailyTradeCount, setDailyTradeCount] = useState<number>(0) // 당일 매매 종목 수
  
  // 매매설정 상태 (useTradingConditions 제거 - 각 전략별 체크박스로 대체)
  const [amountPerStock, setAmountPerStock] = useState<number>(50000)
  const [maxSimultaneousBuy, setMaxSimultaneousBuy] = useState<number>(10)
  const [tradeLimitPerStock, setTradeLimitPerStock] = useState<number>(30)
  const [maxDailyStocks, setMaxDailyStocks] = useState<number>(50)
  const [feePercent, setFeePercent] = useState<number>(0.92)
  
  // 매매시간 설정
  const [startHour, setStartHour] = useState<number>(9)
  const [startMinute, setStartMinute] = useState<number>(0)
  const [endHour, setEndHour] = useState<number>(15)
  const [endMinute, setEndMinute] = useState<number>(19)
  const [endSecond, setEndSecond] = useState<number>(59)
  const [dropSellTime, setDropSellTime] = useState<boolean>(true)
  const [dropSellStartHour, setDropSellStartHour] = useState<number>(15)
  const [dropSellStartMinute, setDropSellStartMinute] = useState<number>(19)
  const [dropSellEndSecond, setDropSellEndSecond] = useState<number>(59)
  
  // 매수/매도 가격지정
  const [profitTarget, setProfitTarget] = useState<number>(10.0)
  const [profitType, setProfitType] = useState<'market' | 'limit'>('market')
  const [lossLimit, setLossLimit] = useState<number>(-1.5)
  const [lossType, setLossType] = useState<'market' | 'limit'>('limit')
  const [lossPriceOffset, setLossPriceOffset] = useState<number>(0)
  
  // 기타조건
  const [autoStart, setAutoStart] = useState<boolean>(false)
  const [trailingStop, setTrailingStop] = useState<boolean>(true)
  const [trailingProfitThreshold, setTrailingProfitThreshold] = useState<number>(1.0)
  const [trailingDropThreshold, setTrailingDropThreshold] = useState<number>(-0.5)
  
  // 매매기법
  const [strategyMarketOpen, setStrategyMarketOpen] = useState<boolean>(true)
  const [strategyBollinger, setStrategyBollinger] = useState<boolean>(true)
  const [strategyTrendline, setStrategyTrendline] = useState<boolean>(true)
  const [strategyMartingale, setStrategyMartingale] = useState<boolean>(true)
  const [strategyScalping, setStrategyScalping] = useState<boolean>(true)
  const [strategyBreakout, setStrategyBreakout] = useState<boolean>(true)
  const [strategyMarketClose, setStrategyMarketClose] = useState<boolean>(false) // 장마감급등주매수
  
  // 장마감종가배팅매수 설정값
  const [marketCloseBuy, setMarketCloseBuy] = useState({
    minCandleCount: 5, // 최소 차트 데이터 개수
    recentCandleCount: 5, // 최근분봉 개수
    priceRiseCheckPeriod: 2, // 가격상승률 체크 기간 (인덱스)
    shortTermPeriod: 3, // 단기이동평균 기간
    minPriceRise: 1.0, // 최소 가격 상승률 (%)
    avgVolumePeriod: 3, // 평균거래량 계산 기간
    volumeIncreaseRate: 100000, // 거래량증가율기준 (%)
    minTradingAmount: 10, // 최소거래대금 (억 단위)
    maxVolatility: 0.5 // 변동성상한 (%)
  })
  const [strategyBasicBuy, setStrategyBasicBuy] = useState<boolean>(true) // 기본매수설정
  
  // 사용자수식
  const [buyFormula1, setBuyFormula1] = useState<boolean>(true) // My 매수수식 1
  const [buyFormula2, setBuyFormula2] = useState<boolean>(false) // My 매수수식 2
  const [sellFormula1, setSellFormula1] = useState<boolean>(true) // My 매도수식 1
  const [sellFormula2, setSellFormula2] = useState<boolean>(false) // My 매도수식 2
  
  // 기본매수설정
  const [basicBuy, setBasicBuy] = useState({
    volumeIncreaseRate: 500.00,
    minTradingAmount: 10,
    minFluctuation: 2.00,
    maxFluctuation: 15.00,
    consecutiveRises: 2.00,
    rsiLower: 60.00,
    rsiUpper: 85.00,
    buyPriceAdjustment: 0.30,
    minVolume: 100000.00,
    institutionBuy: 10000.00,
    foreignBuy: 10000.00
  })
  
  // 장시작급등주매수
  const [marketOpenBuy, setMarketOpenBuy] = useState({
    volumeIncreaseRate: 70000.00,
    minTradingAmount: 1,
    minFluctuation: 3.00,
    buyPriceAdjustment: 1.00,
    highDropLimit: -3.00,
    startHour: 9,
    startMinute: 0,
    endHour: 9,
    endMinute: 5,
    minConsecutiveRises: 0.00,
    volumeRatioLimit: 50.00,
    currentMinRise: 0.50,
    prevMinRise: 0.50,
    minBullishRatio: 60.00,
    rsiLower: 45.00,
    rsiUpper: 90.00,
    movingAvgRequired: 0.00,
    recentCandleCount: 10, // 최근분봉 개수
    consecutiveRiseCheckCount: 5, // 연속상승봉 체크 개수
    shortTermPeriod: 3, // 단기이동평균 기간
    midTermPeriod: 5, // 중기이동평균 기간
    avgVolumePeriod: 4, // 평균거래량 계산 기간
    recentHighPeriod: 3, // 최근고가 계산 기간
    bullishRatioCheckCount: 5, // 양봉비율 체크 개수
    rsiPeriod: 14 // RSI 계산 기간
  })
  
  // 볼린저밴드매수
  const [bollingerBuy, setBollingerBuy] = useState({
    shortTermPeriod: 5.00,
    midTermPeriod: 20.00,
    bollingerPeriod: 20.00, // 볼린저밴드 계산 기간
    bollingerMultiplier: 2.00, // 볼린저밴드 배수
    openHighBounceLimit: 3.00,
    openHighBounceLimitUse: 1.00,
    movingAvgRequired: 1.00,
    movingAvgPeriod: 3.00, // 이동평균 기간
    instantVolumeIncrease: 100000.00,
    instantVolumeUse: 1.00,
    volumeCompareCount: 1.00,
    recentCandleCount: 5, // 최근분봉 개수
    priceRiseCheckPeriod: 2, // 가격상승률 체크 기간 (인덱스)
    minPriceRise: 2.0 // 최소 가격 상승률 (%)
  })
  
  // 스캘핑매수 설정값
  const [scalpingBuy, setScalpingBuy] = useState({
    minTradingAmount: 50.00, // 최소거래대금 (억 단위)
    volumeIncreaseRate: 500.00, // 거래량 급증 기준 (%)
    lowerBandDeviation: 2.00, // 하단밴드이탈률 (%)
    volumeIncreaseAfterLow: 1.50, // 저점후거래량증가기준 (배)
    rsiLower: 45.00, // RSI 하한
    rsiUpper: 70.00, // RSI 상한
    minPriceRise: 1.0, // 최소 가격 상승률 (%)
    pullbackDepthMin: 1.0, // 풀백 깊이 최소 (%)
    pullbackDepthMax: 10.0, // 풀백 깊이 최대 (%)
    minRiseAfterLow: 0.5, // 저점 이후 최소 상승률 (%)
    minRiseCandles: 2, // 저점 이후 최소 상승 봉 개수
    minCandleCount: 20, // 최소 차트 데이터 개수
    recentCandleCount: 5, // 최근분봉 개수
    shortTermPeriod: 3, // 단기이동평균 기간
    priceRiseCheckThreshold: 1.5, // 가격상승률 체크 임계값 (%)
    prevVolumePeriod: 1, // 이전봉거래량 계산 기간
    fullCandleCount: 20, // 전체분봉 개수
    peakValleySearchStart: 2, // 고점저점 탐색 시작 인덱스
    rsiPeriod: 14 // RSI 계산 기간
  })
  
  // 돌파매수 설정값
  const [breakoutBuy, setBreakoutBuy] = useState({
    volumeIncreaseRate: 70000.00, // 거래량증가율기준 (%)
    volume1MinCoeff: 0.8, // 거래량1분증가율계수
    volume3MinCoeff: 0.7, // 거래량3분증가율계수
    volume5MinCoeff: 0.6, // 거래량5분증가율계수
    minTradingAmount: 50.00, // 최소거래대금 (억 단위)
    prevHighRiseRate: 1.0, // 이전고점대비상승률 (%)
    prevHighRiseRelaxCoeff: 0.7, // 이전고점대비상승률완화계수
    minShortRise: 1.5, // 최소단기상승률 (%)
    min3MinRise: 2.0, // 최소3분상승률 (%)
    minFluctuation: 10.0, // 최소등락률 (%)
    maxFluctuation: 25.0, // 최대등락률 (%)
    minFluctuationRelaxCoeff: 0.8, // 최소등락률완화계수
    maxFluctuationExpandCoeff: 1.1, // 최대등락률확장계수
    rsiLower: 45.00, // RSI 하한
    rsiLowerRelaxCoeff: 0.9, // RSI하한완화계수
    recentCandleCount: 10, // 최근분봉 개수
    volume3MinPeriod: 3, // 3분 평균거래량 계산 기간
    volume5MinPeriod: 5, // 5분 평균거래량 계산 기간
    prevHighPeriod: 3, // 이전고점 계산 기간
    shortTermPeriod: 3, // 단기이동평균 기간
    priceRiseCheckThreshold: 2.0, // 가격상승률 체크 임계값 (%)
    priceRiseCheckPeriod: 2, // 가격상승률 체크 기간 (인덱스)
    rsiPeriod: 14 // RSI 계산 기간
  })
  
  const logIdRef = useRef(0)
  const logContainerRef = useRef<HTMLDivElement>(null)

  // 분봉 데이터 타입 정의
  interface CandleData {
    일자: string
    시가: number
    고가: number
    저가: number
    종가: number
    거래량: number
  }

  // 유틸리티 함수들
  // RSI 계산 함수
  const calculateRSI = (candles: CandleData[], period: number = 14): number => {
    if (!candles || candles.length < period + 1) {
      return 50 // 기본값
    }

    let gainSum = 0
    let lossSum = 0

    // 첫 번째 평균 계산
    for (let i = 1; i <= period; i++) {
      const change = candles[i - 1].종가 - candles[i].종가
      if (change >= 0) {
        gainSum += change
      } else {
        lossSum -= change
      }
    }

    const avgGain = gainSum / period
    const avgLoss = lossSum / period

    if (avgLoss === 0) {
      return 100
    }

    const rs = avgGain / avgLoss
    const rsi = 100 - (100 / (1 + rs))
    return rsi
  }

  // 이동평균 계산 함수
  const calculateMA = (candles: CandleData[], period: number, priceType: '시가' | '고가' | '저가' | '종가' = '종가'): number[] => {
    if (!candles || candles.length < period) {
      return []
    }

    const result: number[] = []
    let sum = 0

    // 첫 번째 MA 계산
    for (let i = 0; i < period; i++) {
      sum += candles[i][priceType]
    }
    result.push(sum / period)

    // 이후 MA는 이전 값을 활용하여 계산
    for (let i = 1; i <= candles.length - period; i++) {
      sum = sum - candles[i - 1][priceType] + candles[i + period - 1][priceType]
      result.push(sum / period)
    }

    return result
  }

  // 볼린저밴드 계산 함수
  const calculateBollingerBands = (candles: CandleData[], period: number = 20, multiplier: number = 2): { upper: number, middle: number, lower: number }[] => {
    if (!candles || candles.length < period) {
      return []
    }

    const result: { upper: number, middle: number, lower: number }[] = []
    
    // 가격 데이터 미리 계산 (TP = (고가 + 저가 + 종가) / 3)
    const prices = candles.map(c => (c.고가 + c.저가 + c.종가) / 3.0)
    
    let sum = prices.slice(0, period).reduce((a, b) => a + b, 0)
    let mean = sum / period

    // 첫 번째 표준편차 계산
    let squareSum = prices.slice(0, period)
      .map(p => Math.pow(p - mean, 2))
      .reduce((a, b) => a + b, 0)
    let stdDev = Math.sqrt(squareSum / period)

    result.push({
      upper: mean + multiplier * stdDev,
      middle: mean,
      lower: mean - multiplier * stdDev
    })

    // 이후 값들은 이전 계산을 활용
    for (let i = 1; i <= prices.length - period; i++) {
      // 평균 업데이트
      sum = sum - prices[i - 1] + prices[i + period - 1]
      mean = sum / period

      // 표준편차 업데이트
      squareSum = prices.slice(i, i + period)
        .map(p => Math.pow(p - mean, 2))
        .reduce((a, b) => a + b, 0)
      stdDev = Math.sqrt(squareSum / period)

      result.push({
        upper: mean + multiplier * stdDev,
        middle: mean,
        lower: mean - multiplier * stdDev
      })
    }

    return result
  }

  // 호가단위 조정 함수
  const adjustToHogaUnit = (price: number): number => {
    if (price < 1000) return price
    if (price < 5000) return Math.floor(price / 5) * 5
    if (price < 10000) return Math.floor(price / 10) * 10
    if (price < 50000) return Math.floor(price / 50) * 50
    if (price < 100000) return Math.floor(price / 100) * 100
    if (price < 500000) return Math.floor(price / 500) * 500
    return Math.floor(price / 1000) * 1000
  }

  // 조건식 목록 조회 (웹 기반 자체 조건식)
  const { data: conditionList = [] } = useQuery(
    'conditions',
    () => kiwoomApi.getConditions(),
    {
      enabled: true, // 항상 조회 가능 (키움 연결 불필요)
      onSuccess: (data) => {
        if (data) {
          // 새 API 응답 형식: { success: true, conditions: [...] }
          const conditionsData = data.conditions || data
          if (Array.isArray(conditionsData)) {
            setConditions(conditionsData.map((cond: any) => ({
              id: cond.id || '',
              name: cond.name || '',
              description: cond.description || '',
              enabled: false, // 기본값은 비활성
            })))
          }
        }
      },
    }
  )

  // 계좌 목록 조회
  const { data: accountData } = useQuery(
    'accounts',
    () => kiwoomApi.getAccounts(),
    {
      enabled: isConnected, // 키움증권 API 연결 상태 확인
      onSuccess: (data) => {
        console.log('계좌 조회 성공:', data)
        if (Array.isArray(data)) {
          if (data.length > 0 && !selectedAccount) {
            setSelectedAccount(data[0])
          }
        }
        else if (data?.accounts && Array.isArray(data.accounts) && data.accounts.length > 0) {
          if (!selectedAccount) {
            setSelectedAccount(data.accounts[0])
          }
        }
        else if (data?.accountNumber && !selectedAccount) {
          setSelectedAccount(data.accountNumber)
        }
      },
      onError: (error: any) => {
        console.error('계좌 조회 오류:', error)
        addLog('계좌 조회 실패. 계좌번호를 직접 입력해주세요.', 'warning')
      }
    }
  )

  const accounts = Array.isArray(accountData) 
    ? accountData 
    : accountData?.accounts || []

  // 계좌 정보 조회 (예수금, 총평가금액 등)
  const { data: accountInfoData, error: accountInfoError } = useQuery(
    ['accountInfo', selectedAccount],
    () => {
      if (!selectedAccount) return Promise.resolve(null)
      
      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'
      
      return (kiwoomApi.getAccounts as any)(accountNo, accountProductCode)
    },
    {
      enabled: isConnected && !!selectedAccount,
      refetchInterval: isRunning ? 30000 : 60000, // 요청 빈도 감소 (30초/1분)
      retry: false, // 자동 재시도 비활성화
      retryOnMount: false,
      onSuccess: (data: any) => {
        // 응답에 에러가 포함된 경우 (요청 제한 에러는 로그 남기지 않음)
        if (data?.error && !data.error.includes('허용된 요청 개수를 초과')) {
          addLog(`계좌 정보 조회: ${data.error}`, 'warning')
        }
      },
      onError: (error: any) => {
        // 요청 제한 에러는 로그 남기지 않음
        const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || ''
        if (!errorMessage.includes('허용된 요청 개수를 초과')) {
          addLog(`계좌 정보 조회 오류: ${errorMessage}`, 'error')
        }
      }
    }
  )

  // 계좌 잔고 조회
  const { data: balanceData, error: balanceError } = useQuery(
    ['balance', selectedAccount],
    () => {
      if (!selectedAccount) return Promise.resolve([])
      
      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'
      
      return kiwoomApi.getBalance(accountNo, accountProductCode)
    },
    {
      enabled: isConnected && !!selectedAccount,
      refetchInterval: false, // 계좌 잔고는 자동 갱신 비활성화 (수동 갱신만)
      retry: false, // 자동 재시도 비활성화
      retryOnMount: false,
      onSuccess: (data) => {
        // 에러가 포함된 경우 처리 (요청 제한 에러는 로그 남기지 않음)
        if (data?.error) {
          if (!data.error.includes('허용된 요청 개수를 초과')) {
            addLog(`계좌 잔고 조회 오류: ${data.error}`, 'warning')
          }
          setHoldingStocks([])
          return
        }
        
        if (Array.isArray(data)) {
          setHoldingStocks(data.map((stock: any) => ({
            code: stock.code || stock.종목코드 || '',
            name: stock.name || stock.종목명 || '',
            quantity: stock.quantity || stock.보유수량 || 0,
            purchasePrice: stock.purchasePrice || stock.매입가 || 0,
            currentPrice: stock.currentPrice || stock.현재가 || 0,
            profit: stock.profit || stock.평가손익 || 0,
            profitPercent: stock.profitPercent || stock.수익률 || 0,
            maxProfitPercent: stock.maxProfitPercent || stock.maxProfitPercent || 0,
          })))
        } else if (data?.stocks && Array.isArray(data.stocks)) {
          setHoldingStocks(data.stocks.map((stock: any) => ({
            code: stock.code || stock.종목코드 || '',
            name: stock.name || stock.종목명 || '',
            quantity: stock.quantity || stock.보유수량 || 0,
            purchasePrice: stock.purchasePrice || stock.매입가 || 0,
            currentPrice: stock.currentPrice || stock.현재가 || 0,
            profit: stock.profit || stock.평가손익 || 0,
            profitPercent: stock.profitPercent || stock.수익률 || 0,
            maxProfitPercent: stock.maxProfitPercent || stock.maxProfitPercent || 0,
          })))
        }
      },
      onError: (error: any) => {
        if (error.response?.data?.error) {
          addLog(`계좌 잔고 조회 오류: ${error.response.data.error}`, 'error')
        }
        setHoldingStocks([])
      },
    }
  )

  // 주문 리스트 조회
  const { data: ordersData } = useQuery(
    ['orders', selectedAccount],
    () => {
      if (!selectedAccount) return Promise.resolve([])
      return kiwoomApi.getOrderHistory(selectedAccount)
    },
    {
      enabled: connected && !!selectedAccount,
      refetchInterval: isRunning ? 3000 : false,
      onSuccess: (data) => {
        if (Array.isArray(data)) {
          setOrderLogs(data.map((order: any, idx: number) => ({
            id: order.id || idx,
            date: order.date || new Date().toLocaleDateString('ko-KR'),
            time: order.time || new Date().toLocaleTimeString('ko-KR'),
            type: order.type || 'buy',
            stockName: order.stockName || order.종목명 || '',
            stockCode: order.stockCode || order.종목코드 || '',
            quantity: order.quantity || order.수량 || 0,
            price: order.price || order.가격 || 0,
            status: order.status || order.주문상태 || '접수',
            orderNumber: order.orderNumber || order.주문번호,
          })))
        }
      },
    }
  )

  // 로그 추가
  const addLog = (message: string, level: LogMessage['level'] = 'info') => {
    const newLog: LogMessage = {
      id: logIdRef.current++,
      time: new Date().toLocaleTimeString('ko-KR'),
      message,
      level,
    }
    setLogs(prev => [...prev.slice(-199), newLog]) // 최대 200개 유지
    
    // 로그가 추가되면 자동으로 로그 섹션 표시
    setShowLogSection(true)
    
    // 로그 스크롤 자동 이동
    setTimeout(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
      }
    }, 100)
  }

  // displayedStockCount와 detectedStocks.length를 ref로 관리하여 클로저 문제 해결
  const displayedStockCountRef = useRef<number>(20)
  const detectedStocksLengthRef = useRef<number>(0)
  
  useEffect(() => {
    displayedStockCountRef.current = displayedStockCount
  }, [displayedStockCount])
  
  useEffect(() => {
    detectedStocksLengthRef.current = detectedStocks.length
  }, [detectedStocks.length])

  // detectedStocks의 길이가 크게 증가할 때만 초기화 (새로운 검색 결과가 들어올 때)
  const prevDetectedStocksLengthRef = useRef<number>(0)
  useEffect(() => {
    const currentLength = detectedStocks.length
    const prevLength = prevDetectedStocksLengthRef.current
    
    // displayedStockCount 초기화 제거 - 모든 종목 표시
    // 길이가 크게 증가했을 때도 초기화하지 않음 (모든 종목 표시 유지)
    prevDetectedStocksLengthRef.current = currentLength
  }, [detectedStocks.length])

  // 모든 종목 표시하므로 무한 스크롤 로직 제거

  // 검색된 종목 실시간 시세 업데이트 (WebSocket 사용)
  useEffect(() => {
    // 연결 상태 확인 (엄격하게)
    if (!isConnected || !connected || detectedStocks.length === 0) {
      return
    }

    let ws: WebSocket | null = null
    let isMounted = true
    let registeredCodes: string[] = []
    let wsConnected = false

    const connectWebSocket = async () => {
      try {
        // 서버의 WebSocket에 연결 (Vite 프록시를 통해 /ws 경로로 연결)
        // Vite 프록시가 자동으로 서버(포트 3000)로 전달합니다
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsHost = window.location.host
        const wsUrl = `${wsProtocol}//${wsHost}/ws`
        ws = new WebSocket(wsUrl)

        ws.onopen = async () => {
          console.log('[실시간 시세] WebSocket 연결 성공')
          wsConnected = true
          
          // 서버에 WebSocket 연결 요청 (키움증권 WebSocket 연결)
          try {
            await kiwoomApi.connectWebSocket()
          } catch (error: any) {
            console.warn('[실시간 시세] 서버 WebSocket 연결 실패:', error.message)
          }

          // 검색된 종목에 대한 실시간 시세 등록
          const currentCodes = detectedStocks.map(stock => stock.code)
          if (currentCodes.length > 0) {
            try {
              await kiwoomApi.registerRealTimeStocks(currentCodes)
              registeredCodes = currentCodes
              console.log(`[실시간 시세] ${currentCodes.length}개 종목 등록 완료`)
            } catch (error: any) {
              console.error('[실시간 시세] 종목 등록 실패:', error.message)
            }
          }
        }

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data)
            
            // 실시간 시세 데이터 수신
            if (message.type === 'realtime' && message.data?.trnm === 'REAL' && message.data?.data) {
              message.data.data.forEach((item: any) => {
                if (item.type === '00' && item.values && item.item) {
                  // 주식체결 데이터 파싱
                  const code = item.item
                  const values = item.values
                  
                  // FID 값 파싱 (키움증권 실시간 시세 필드)
                  // '10': 현재가, '11': 전일대비, '12': 등락률, '13': 누적거래량
                  const currentPrice = parseFloat(values['10'] || '0')
                  const change = parseFloat(values['11'] || '0')
                  const changePercent = parseFloat(values['12'] || '0')
                  const volume = parseFloat(values['13'] || '0')

                  if (currentPrice > 0 && isMounted) {
                    // 검색된 종목 업데이트
                    setDetectedStocks(prevStocks => {
                      return prevStocks.map(stock => {
                        if (stock.code === code) {
                          return {
                            ...stock,
                            price: currentPrice,
                            change: change,
                            changePercent: changePercent,
                            volume: volume,
                          }
                        }
                        return stock
                      })
                    })

                    // 선택된 종목도 업데이트
                    setWatchlistStocks(prevWatchlist => {
                      if (prevWatchlist.length === 0) return prevWatchlist
                      
                      return prevWatchlist.map(stock => {
                        if (stock.code === code) {
                          return {
                            ...stock,
                            price: currentPrice,
                            change: change,
                            changePercent: changePercent,
                            volume: volume,
                          }
                        }
                        return stock
                      })
                    })
                  }
                }
              })
            }
          } catch (error) {
            console.error('[실시간 시세] 메시지 파싱 오류:', error)
          }
        }

        ws.onerror = (error) => {
          console.error('[실시간 시세] WebSocket 오류:', error)
        }

        ws.onclose = () => {
          console.log('[실시간 시세] WebSocket 연결 종료')
          ws = null
          wsConnected = false
          
          // 재연결 시도 (3초 후)
          if (isMounted && isConnected && connected && detectedStocks.length > 0) {
            setTimeout(() => {
              if (isMounted) {
                connectWebSocket()
              }
            }, 3000)
          }
        }
      } catch (error) {
        console.error('[실시간 시세] WebSocket 연결 오류:', error)
      }
    }

    // WebSocket 연결 시작
    connectWebSocket()

    // 종목이 추가되면 실시간 시세 등록
    const currentCodes = detectedStocks.map(stock => stock.code)
    const newCodes = currentCodes.filter(code => !registeredCodes.includes(code))
    if (newCodes.length > 0 && wsConnected) {
      kiwoomApi.registerRealTimeStocks(newCodes).catch(console.error)
      registeredCodes = [...registeredCodes, ...newCodes]
    }

    return () => {
      isMounted = false
      if (ws) {
        ws.close()
      }
      // 서버 WebSocket 연결 해제는 하지 않음 (다른 클라이언트가 사용할 수 있음)
    }
  }, [isConnected, connected, detectedStocks.length]) // 연결 상태와 종목 개수 확인

  // 차트 데이터로 검색된 종목 화면 갱신 (주기적으로 차트 데이터 조회하여 가격 정보 업데이트)
  // 조건검색 직후에는 차트 데이터 조회를 지연시켜 API 제한 방지
  const lastSearchTimeRef = useRef<number>(0)
  
  useEffect(() => {
    if (!isConnected || !connected || detectedStocks.length === 0) {
      return
    }

    let isMounted = true
    let intervalId: number | null = null

    const updateStocksFromChartData = async () => {
      if (!isMounted || detectedStocks.length === 0) {
        return
      }

      // 조건검색 직후 30초 이내에는 차트 데이터 조회하지 않음 (API 제한 방지)
      const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
      if (timeSinceLastSearch < 30000) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[차트 갱신] 조건검색 직후 대기 중 (${Math.ceil((30000 - timeSinceLastSearch) / 1000)}초 남음)`)
        }
        return
      }

      try {
        // 검색된 종목들에 대해 차트 데이터 조회하여 최신 가격 정보 업데이트 (모든 종목)
        // API 제한을 고려하여 배치 크기를 줄이고 딜레이를 늘림
        const batchSize = 3 // 한 번에 3개씩 처리 (5개에서 줄임)
        const delayBetweenBatches = 2000 // 배치 간 2초 딜레이 (500ms에서 증가)
        
        for (let i = 0; i < detectedStocks.length; i += batchSize) {
          if (!isMounted) break
          
          const batch = detectedStocks.slice(i, i + batchSize)
          const batchPromises = batch.map(async (stock) => {
            try {
              // 분봉 차트 데이터 조회 (최신 데이터 1개만 필요)
              const candles = await kiwoomApi.getCandle(stock.code, 'min')
              
              if (candles && candles.length > 0 && isMounted) {
                // 최신 차트 데이터에서 종가를 가져와서 가격 정보 업데이트
                const latestCandle = candles[0]
                const closePrice = parseFloat(latestCandle.종가 || latestCandle.close || '0') || 0
                const volume = parseFloat(latestCandle.거래량 || latestCandle.volume || '0') || 0
                
                if (closePrice > 0) {
                  // detectedStocks 업데이트 (가격이 변경된 경우만)
                  setDetectedStocks(prevStocks => {
                    return prevStocks.map(s => {
                      if (s.code === stock.code && s.price !== closePrice) {
                        // 가격 변화율 계산
                        const change = closePrice - (s.startPrice || closePrice)
                        const changePercent = s.startPrice && s.startPrice > 0
                          ? ((closePrice - s.startPrice) / s.startPrice) * 100
                          : 0
                        
                        return {
                          ...s,
                          price: closePrice,
                          change: change,
                          changePercent: changePercent,
                          volume: volume > 0 ? volume : s.volume,
                        }
                      }
                      return s
                    })
                  })
                }
              }
            } catch (error: any) {
              // API 제한 에러(429)는 조용히 처리
              if (error.response?.status === 429) {
                if (process.env.NODE_ENV === 'development') {
                  console.log(`[차트 갱신] ${stock.code} API 제한으로 건너뜀`)
                }
                return
              }
              // 개별 종목 조회 실패는 조용히 처리
              if (process.env.NODE_ENV === 'development') {
                console.log(`[차트 갱신] ${stock.code} 조회 실패:`, error)
              }
            }
          })

          await Promise.all(batchPromises)
          
          // 배치 간 딜레이 (API 호출 제한 방지)
          if (i + batchSize < detectedStocks.length && isMounted) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
          }
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[차트 갱신] 오류:', error)
        }
      }
    }

    // 첫 실행은 조건검색 후 충분한 시간이 지난 후 (30초 후)
    const timeoutId = window.setTimeout(() => {
      updateStocksFromChartData()
      
      // 이후 30초마다 차트 데이터로 갱신 (15초에서 30초로 증가)
      intervalId = window.setInterval(() => {
        if (isMounted) {
          updateStocksFromChartData()
        }
      }, 30000) // 30초마다
    }, 30000) // 첫 실행은 30초 후

    return () => {
      isMounted = false
      window.clearTimeout(timeoutId)
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [isConnected, connected, detectedStocks.length])

  // 컬럼 리사이즈 핸들러
  const handleResizeStart = (column: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setResizingColumn(column)
    setResizeStartX(e.clientX)
    setResizeStartWidth(columnWidths[column])
  }

  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!resizingColumn) return
      
      const diff = e.clientX - resizeStartX
      const newWidth = Math.max(50, resizeStartWidth + diff) // 최소 50px
      setColumnWidths(prev => ({
        ...prev,
        [resizingColumn]: newWidth
      }))
    }

    const handleResizeEnd = () => {
      setResizingColumn(null)
    }

    if (resizingColumn) {
      document.addEventListener('mousemove', handleResizeMove)
      document.addEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      
      return () => {
        document.removeEventListener('mousemove', handleResizeMove)
        document.removeEventListener('mouseup', handleResizeEnd)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [resizingColumn, resizeStartX, resizeStartWidth])

  // 라이선스 키 검증 (유효성만 확인)
  const validateLicenseKey = async (key: string) => {
    try {
      const response = await fetch('/api/auth/validate-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: key.trim() })
      })

      const data = await response.json()
      
      if (data.success) {
        setKeyInfo({
          expiresAt: data.expiresAt,
          remainingDays: data.remainingDays
        })
        return { success: true }
      } else {
        throw new Error(data.message || '키 검증 실패')
      }
    } catch (error: any) {
      throw error
    }
  }

  // 키움 API 연결
  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const finalAppkey = appkey.trim()
      const finalSecretkey = secretkey.trim()

      // 라이선스 키 필수 체크
      if (!licenseKey.trim()) {
        addLog('라이선스 키를 입력해주세요', 'error')
        setIsConnecting(false)
        return
      }

      // App Key와 Secret Key 필수 체크
      if (!finalAppkey || !finalSecretkey) {
        addLog('App Key와 Secret Key를 입력해주세요', 'error')
        setIsConnecting(false)
        return
      }

      // 라이선스 키 유효성 검증 (필수)
      try {
        await validateLicenseKey(licenseKey.trim())
        if (keyInfo?.remainingDays !== undefined) {
          addLog(`라이선스 키 검증 성공 (남은 기간: ${keyInfo.remainingDays}일)`, 'success')
        }
      } catch (error: any) {
        addLog(`라이선스 키 검증 실패: ${error.message}`, 'error')
        setIsConnecting(false)
        return
      }

      // API 호스트 설정 (모의투자/실전투자) - 키움증권
      const host = apiMode === 'real' 
        ? 'https://api.kiwoom.com'        // 실전투자
        : 'https://mockapi.kiwoom.com'    // 모의투자 (KRX만 지원)

      console.log('=== 프론트엔드 연결 요청 (키움증권) ===')
      console.log('API 모드:', apiMode)
      console.log('Host:', host)
      console.log('AppKey 길이:', finalAppkey.length)
      console.log('SecretKey 길이:', finalSecretkey.length)

      // localStorage에 저장 (trim된 값)
      localStorage.setItem('kiwoom_appkey', finalAppkey)
      localStorage.setItem('kiwoom_secretkey', finalSecretkey)
      localStorage.setItem('kiwoom_apimode', apiMode)
      if (useLicenseKey && licenseKey.trim()) {
        localStorage.setItem('kiwoom_license_key', licenseKey.trim())
      }

      // API 연결 시도 (백엔드에 요청)
      const response = await fetch('/api/kiwoom/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          appkey: finalAppkey, 
          secretkey: finalSecretkey, 
          host 
        })
      })

      const data = await response.json()

      if (data.success) {
        setIsConnected(true)
        // useKiwoomStore의 connected 상태 업데이트
        await checkStatus()
        setShowLoginModal(false)
        addLog(`키움증권 API 연결 성공 (${apiMode === 'real' ? '실전투자' : '모의투자'})`, 'success')
      } else {
        throw new Error(data.message || '연결 실패')
      }
    } catch (error: any) {
      addLog(`API 연결 실패: ${error.message}`, 'error')
    } finally {
      setIsConnecting(false)
    }
  }

  // 키움 API 연결 해제
  const handleDisconnect = async () => {
    try {
      await fetch('/api/kiwoom/disconnect', { method: 'POST' })
      setIsConnected(false)
      // useKiwoomStore의 connected 상태 업데이트
      await checkStatus()
      addLog('키움증권 API 연결 해제', 'warning')
    } catch (error: any) {
      addLog(`API 연결 해제 실패: ${error.message}`, 'error')
    }
  }

  // 조건식 선택/해제
  const toggleCondition = (id: string) => {
    if (isRunning) {
      return
    }
    
    const updatedConditions = conditions.map(c => 
      c.id === id ? { ...c, enabled: !c.enabled } : c
    )
    setConditions(updatedConditions)
  }

  // 시작 버튼 클릭
  const handleStart = async () => {
    const enabledConditions = conditions.filter(c => c.enabled)
    if (enabledConditions.length === 0) {
      addLog('조건식을 최소 1개 이상 선택해주세요', 'error')
      return
    }

    if (!selectedAccount) {
      addLog('계좌를 선택해주세요', 'error')
      return
    }

    try {
      addLog('조건식 검색 시작...', 'info')
      
      // 웹 기반 조건식 검색 실행
      const result = await kiwoomApi.searchCondition(conditions)
      
      if (result.success && result.stocks && result.stocks.length > 0) {
        // 검색된 종목 추가
        // 자동매매 시작 시점의 가격과 등락률을 저장
        const newStocks: DetectedStock[] = result.stocks.map((stock: any) => ({
          code: stock.code,
          name: stock.name,
          price: stock.price,
          change: stock.price * (stock.changeRate / 100),
          changePercent: stock.changeRate,
          volume: stock.volume,
          detectedCondition: result.appliedConditions.join(', '),
          detectedTime: new Date().toLocaleTimeString(),
          startPrice: stock.price, // 자동매매 시작 시점의 가격 저장
          detectedChangePercent: stock.changeRate, // 조건 감지 시점의 등락률 저장 (매수 조건 비교용)
        }))
        
        setDetectedStocks(newStocks)
        
        // 조건검색 시간 기록 (차트 데이터 조회 지연용)
        lastSearchTimeRef.current = Date.now()
        
        // 선택된 종목도 업데이트 (가격만 갱신)
        if (watchlistStocks.length > 0) {
          const updatedWatchlist = watchlistStocks.map(watchStock => {
            const foundStock = newStocks.find(s => s.code === watchStock.code)
            if (foundStock) {
              return {
                ...foundStock,
                detectedTime: watchStock.detectedTime // 최초 추가 시간 유지
              }
            }
            return watchStock
          })
          setWatchlistStocks(updatedWatchlist)
          addLog(`선택된 종목 ${updatedWatchlist.length}개 업데이트`, 'info')
        }
        
        addLog(`${result.stocks.length}개 종목 검색 완료 (차트 데이터는 30초 후부터 조회됩니다)`, 'success')
      } else {
        addLog('검색된 종목이 없습니다', 'warning')
      }

      setIsRunning(true)
      addLog('자동매매 시작', 'success')
    } catch (error: any) {
      addLog(`자동매매 시작 실패: ${error.message}`, 'error')
    }
  }

  // 정지 버튼 클릭
  const handleStop = async () => {
    setIsRunning(false)
    addLog('자동매매 중지', 'warning')
  }

  // 분봉 데이터 가져오기
  const getCandleData = async (code: string): Promise<CandleData[]> => {
    try {
      const candles = await kiwoomApi.getCandle(code, 'min')
      if (!candles || candles.length === 0) {
        return []
      }
      
      // API 응답을 CandleData 형식으로 변환
      return candles.map((c: any) => ({
        일자: c.일자 || c.time || '',
        시가: parseFloat(c.시가 || c.open || '0') || 0,
        고가: parseFloat(c.고가 || c.high || '0') || 0,
        저가: parseFloat(c.저가 || c.low || '0') || 0,
        종가: parseFloat(c.종가 || c.close || '0') || 0,
        거래량: parseFloat(c.거래량 || c.volume || '0') || 0,
      }))
    } catch (error) {
      console.error(`[분봉데이터] ${code} 조회 실패:`, error)
      return []
    }
  }

  // 1. 장시작급등주매수 함수 (C# 버전과 동일)
  const 장시작급등주매수 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      if (!candles || candles.length < marketOpenBuy.shortTermPeriod) {
        return false
      }

      const 최근분봉 = candles.slice(0, marketOpenBuy.recentCandleCount)
      const 현재가 = stock.price
      const 현재봉시가 = 최근분봉[0].시가
      const 전봉종가 = 최근분봉[1].종가
      const 전봉시가 = 최근분봉[1].시가

      // 1. 연속 상승 패턴 확인
      let 연속상승봉수 = 0
      for (let i = 0; i < Math.min(marketOpenBuy.consecutiveRiseCheckCount, 최근분봉.length); i++) {
        if (i + 1 < 최근분봉.length && 
            최근분봉[i].종가 > 최근분봉[i].시가 && 
            최근분봉[i].종가 > 최근분봉[i + 1].종가) {
          연속상승봉수++
        } else {
          break
        }
      }

      const 연속상승패턴 = 연속상승봉수 >= marketOpenBuy.minConsecutiveRises
      if (!연속상승패턴) {
        return false
      }

      // 2. 이동평균선 확인 (설정값 사용)
      const 단기이동평균 = 최근분봉.slice(0, marketOpenBuy.shortTermPeriod).reduce((sum, c) => sum + c.종가, 0) / marketOpenBuy.shortTermPeriod
      const 중기이동평균 = 최근분봉.slice(0, marketOpenBuy.midTermPeriod).reduce((sum, c) => sum + c.종가, 0) / marketOpenBuy.midTermPeriod
      const 이동평균선정배열 = 현재가 > 단기이동평균 && 단기이동평균 > 중기이동평균

      if (marketOpenBuy.movingAvgRequired > 0 && !이동평균선정배열) {
        return false
      }

      // 3. 거래량 증가 패턴 확인 (설정값 사용)
      const 현재봉거래량 = 최근분봉[0].거래량
      const 평균거래량 = 최근분봉.slice(1, 1 + marketOpenBuy.avgVolumePeriod).reduce((sum, c) => sum + c.거래량, 0) / marketOpenBuy.avgVolumePeriod
      const 거래량증가율 = ((현재봉거래량 / Math.max(평균거래량, 1)) - 1) * 100

      if (거래량증가율 < marketOpenBuy.volumeRatioLimit) {
        return false
      }

      // 4. 상승 추세 유지 확인
      const 현재봉상승률 = ((현재가 - 현재봉시가) / 현재봉시가) * 100
      const 전봉상승률 = ((전봉종가 - 전봉시가) / 전봉시가) * 100

      if (현재봉상승률 <= marketOpenBuy.currentMinRise || 전봉상승률 <= marketOpenBuy.prevMinRise) {
        return false
      }

      // 5. 폭락 패턴 필터링 (설정값 사용)
      const 최근고가 = Math.max(...최근분봉.slice(0, marketOpenBuy.recentHighPeriod).map(c => c.고가))
      const 고가대비하락률 = ((현재가 - 최근고가) / 최근고가) * 100

      if (고가대비하락률 < marketOpenBuy.highDropLimit) {
        return false
      }

      // 6. 양봉 비율 체크 (설정값 사용)
      let 양봉수 = 0
      let 음봉수 = 0
      for (let i = 0; i < Math.min(marketOpenBuy.bullishRatioCheckCount, 최근분봉.length); i++) {
        if (최근분봉[i].종가 >= 최근분봉[i].시가) {
          양봉수++
        } else {
          음봉수++
        }
      }

      const 양봉비율 = (양봉수 / (양봉수 + 음봉수)) * 100
      if (양봉비율 < marketOpenBuy.minBullishRatio) {
        return false
      }

      // 7. RSI 조건 확인 (설정값 사용)
      const rsi = calculateRSI(candles, marketOpenBuy.rsiPeriod)
      if (rsi < marketOpenBuy.rsiLower || rsi > marketOpenBuy.rsiUpper) {
        return false
      }

      // 8. 거래대금 체크
      const 거래대금 = 현재가 * stock.volume
      const 최소거래대금 = marketOpenBuy.minTradingAmount * 100000000 // 억 단위
      if (거래대금 < 최소거래대금) {
        return false
      }

      // 모든 조건 통과
      addLog(`[장시작급등주매수 성공] ${stock.name} - 연속상승봉:${연속상승봉수}개, 거래량증가율:${거래량증가율.toFixed(2)}%, RSI:${rsi.toFixed(2)}`, 'success')
      return true
    } catch (error: any) {
      console.error(`[장시작급등주매수] ${stock.name} 오류:`, error)
      return false
    }
  }

  // 2. 볼린저밴드매수 함수 (C# 버전과 동일)
  const 볼린저밴드매수 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      if (!candles || candles.length < bollingerBuy.shortTermPeriod) {
        return false
      }

      const 최근분봉 = candles.slice(0, bollingerBuy.recentCandleCount)
      const 현재가 = stock.price

      // 볼린저밴드 계산 (설정값 사용)
      const bollingerPeriod = Math.round(bollingerBuy.bollingerPeriod || 20)
      const bollingerMultiplier = bollingerBuy.bollingerMultiplier || 2
      const bollingerBands = calculateBollingerBands(candles, bollingerPeriod, bollingerMultiplier)
      if (bollingerBands.length === 0) {
        return false
      }

      const 하단밴드 = bollingerBands[0].lower
      const 중심선 = bollingerBands[0].middle
      const 상단밴드 = bollingerBands[0].upper

      // 1. 시가와 고가의 변동 체크
      if (bollingerBuy.openHighBounceLimitUse > 0) {
        const 시가 = 최근분봉[0].시가
        const 고가 = 최근분봉[0].고가
        const 시가고가변동률 = ((고가 - 시가) / 시가) * 100

        if (시가고가변동률 > bollingerBuy.openHighBounceLimit) {
          return false
        }
      }

      // 2. 가격 상승률 계산 (설정값 사용)
      let 최근가격상승률 = 0
      let 최근3분가격상승률 = 0

      if (최근분봉.length > 1) {
        최근가격상승률 = ((현재가 - 최근분봉[1].종가) / 최근분봉[1].종가) * 100
      }

      if (최근분봉.length > bollingerBuy.priceRiseCheckPeriod + 1) {
        const idx = Math.min(bollingerBuy.priceRiseCheckPeriod, 최근분봉.length - 1)
        최근3분가격상승률 = ((현재가 - 최근분봉[idx].종가) / 최근분봉[idx].종가) * 100
      }

      // 3. 단기 이동평균선 확인 (설정값 사용)
      const 종가리스트 = 최근분봉.map(c => c.종가)
      const movingAvgPeriod = Math.round(bollingerBuy.movingAvgPeriod || 3)
      const 단기이동평균 = 종가리스트.slice(0, movingAvgPeriod).reduce((sum, p) => sum + p, 0) / movingAvgPeriod

      if (bollingerBuy.movingAvgRequired > 0 && 현재가 < 단기이동평균 && 최근가격상승률 < bollingerBuy.minPriceRise) {
        return false
      }

      // 4. 거래량 분석 - 순간 거래량 폭증 감지
      let 순간거래량증가율 = 0
      if (bollingerBuy.instantVolumeUse > 0 && 최근분봉.length > bollingerBuy.volumeCompareCount) {
        const 현재봉거래량 = 최근분봉[0].거래량
        const 이전봉거래량 = 최근분봉.slice(1, 1 + bollingerBuy.volumeCompareCount)
          .reduce((sum, c) => sum + c.거래량, 0) / bollingerBuy.volumeCompareCount
        순간거래량증가율 = 이전봉거래량 > 0 
          ? ((현재봉거래량 / 이전봉거래량) - 1) * 100 
          : 0

        if (순간거래량증가율 < bollingerBuy.instantVolumeIncrease) {
          return false
        }
      } else {
        return false
      }

      // 모든 조건 충족
      addLog(`[볼린저밴드매수 성공] ${stock.name} - 거래량폭증:${순간거래량증가율.toFixed(2)}%, 가격상승률:${최근가격상승률.toFixed(2)}%`, 'success')
      return true
    } catch (error: any) {
      console.error(`[볼린저밴드매수] ${stock.name} 오류:`, error)
      return false
    }
  }

  // 3. 장마감종가배팅매수 함수 (C# 버전과 동일)
  const 장마감종가배팅매수 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      if (!candles || candles.length < marketCloseBuy.minCandleCount) {
        return false
      }

      const 최근분봉 = candles.slice(0, marketCloseBuy.recentCandleCount)
      const 현재가 = stock.price

      // 1. 가격 상승률 계산 (설정값 사용)
      let 최근가격상승률 = 0
      let 최근3분가격상승률 = 0

      if (최근분봉.length > 1) {
        최근가격상승률 = ((현재가 - 최근분봉[1].종가) / 최근분봉[1].종가) * 100
      }

      if (최근분봉.length > marketCloseBuy.priceRiseCheckPeriod + 1) {
        const idx = Math.min(marketCloseBuy.priceRiseCheckPeriod, 최근분봉.length - 1)
        최근3분가격상승률 = ((현재가 - 최근분봉[idx].종가) / 최근분봉[idx].종가) * 100
      }

      // 2. 이동평균 계산 (설정값 사용)
      const 종가리스트 = 최근분봉.map(c => c.종가)
      const 단기이동평균 = 종가리스트.slice(0, marketCloseBuy.shortTermPeriod).reduce((sum, p) => sum + p, 0) / marketCloseBuy.shortTermPeriod

      if (현재가 < 단기이동평균 && 최근가격상승률 < marketCloseBuy.minPriceRise) {
        return false
      }

      // 3. 거래량 급증 체크 (설정값 사용)
      const 현재거래량 = stock.volume
      const 이전거래량평균 = candles.slice(1, 1 + marketCloseBuy.avgVolumePeriod).reduce((sum, c) => sum + c.거래량, 0) / marketCloseBuy.avgVolumePeriod

      if (이전거래량평균 < 1) {
        return false
      }

      const 거래량증가율 = ((현재거래량 / 이전거래량평균) - 1) * 100

      // 거래량증가율기준 (설정값 사용)
      const 거래량증가율기준 = marketCloseBuy.volumeIncreaseRate
      if (거래량증가율 < 거래량증가율기준) {
        return false
      }

      // 4. 거래대금 체크 (설정값 사용)
      const 거래대금 = 현재가 * 현재거래량
      const 최소거래대금 = marketCloseBuy.minTradingAmount * 100000000 // 억 단위
      if (거래대금 < 최소거래대금) {
        return false
      }

      // 5. 변동성 체크 (설정값 사용)
      const 최고가 = Math.max(...최근분봉.map(c => c.고가))
      const 최저가 = Math.min(...최근분봉.map(c => c.저가))
      const 변동폭비율 = ((최고가 - 최저가) / 최저가) * 100

      const 변동성상한 = marketCloseBuy.maxVolatility
      if (변동폭비율 > 변동성상한) {
        return false
      }

      addLog(`[장마감종가배팅매수 성공] ${stock.name} - 거래량증가율:${거래량증가율.toFixed(2)}%, 변동폭:${변동폭비율.toFixed(2)}%`, 'success')
      return true
    } catch (error: any) {
      console.error(`[장마감종가배팅매수] ${stock.name} 오류:`, error)
      return false
    }
  }

  // 4. 스캘핑매수 함수 (C# 버전과 동일)
  const 스캘핑매수 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      if (!candles || candles.length < scalpingBuy.minCandleCount) {
        return false
      }

      const 최근분봉 = candles.slice(0, scalpingBuy.recentCandleCount)
      const 현재가 = stock.price

      // 1. 가격 상승률 계산 (설정값 사용)
      let 최근가격상승률 = 0
      let 최근3분가격상승률 = 0

      if (최근분봉.length > 1) {
        최근가격상승률 = ((현재가 - 최근분봉[1].종가) / 최근분봉[1].종가) * 100
      }

      if (최근분봉.length > 3) {
        const idx = Math.min(2, 최근분봉.length - 1)
        최근3분가격상승률 = ((현재가 - 최근분봉[idx].종가) / 최근분봉[idx].종가) * 100
      }

      // 2. 단기 이동평균선 확인 (설정값 사용)
      const 종가리스트 = 최근분봉.map(c => c.종가)
      const 단기이동평균 = 종가리스트.slice(0, scalpingBuy.shortTermPeriod).reduce((sum, p) => sum + p, 0) / scalpingBuy.shortTermPeriod

      if (현재가 < 단기이동평균 && 최근가격상승률 < scalpingBuy.priceRiseCheckThreshold) {
        return false
      }

      // 3. 거래량 폭증 감지 (설정값 사용)
      const 현재봉거래량 = 최근분봉[0].거래량
      const 이전봉거래량 = 최근분봉.slice(1, 1 + scalpingBuy.prevVolumePeriod).reduce((sum, c) => sum + c.거래량, 0) / scalpingBuy.prevVolumePeriod
      const 순간거래량증가율 = 이전봉거래량 > 0 
        ? ((현재봉거래량 / 이전봉거래량) - 1) * 100 
        : 0

      // 거래량 급증 판단 (설정값 사용)
      const 거래량급증 = 순간거래량증가율 >= scalpingBuy.volumeIncreaseRate
      if (!거래량급증) {
        // 거래량 급증이 없으면 풀백 패턴 확인 필요
      }

      // 볼린저 밴드 위치 확인 (기본값 사용, 볼린저밴드 설정값과 동일하게)
      const bollingerPeriod = Math.round(bollingerBuy.bollingerPeriod || 20)
      const bollingerMultiplier = bollingerBuy.bollingerMultiplier || 2
      const bollingerBands = calculateBollingerBands(candles, bollingerPeriod, bollingerMultiplier)
      if (bollingerBands.length === 0) {
        return false
      }

      const 중심선 = bollingerBands[0].middle
      const 상단밴드 = bollingerBands[0].upper
      const 하단밴드 = bollingerBands[0].lower

      const 중심선대비 = ((현재가 - 중심선) / 중심선) * 100
      const 밴드폭 = ((상단밴드 - 하단밴드) / 중심선) * 100

      // 최소 밴드폭 체크 (설정값 사용)
      const 하단밴드이탈률 = scalpingBuy.lowerBandDeviation
      if (밴드폭 < 하단밴드이탈률) {
        return false
      }

      // 4. 풀백 재진입 패턴 분석 (설정값 사용)
      const 전체분봉 = candles.slice(0, scalpingBuy.fullCandleCount)
      if (전체분봉.length < scalpingBuy.fullCandleCount) {
        return false
      }

      const 종가배열 = 전체분봉.map(c => c.종가)

      // 고점, 저점 탐색 (설정값 사용)
      const 고점들: number[] = []
      const 저점들: number[] = []

      for (let i = scalpingBuy.peakValleySearchStart; i < 종가배열.length - scalpingBuy.peakValleySearchStart; i++) {
        // 고점 조건
        if (종가배열[i] > 종가배열[i - 1] && 종가배열[i] > 종가배열[i - 2] &&
            종가배열[i] > 종가배열[i + 1] && 종가배열[i] > 종가배열[i + 2]) {
          고점들.push(i)
        }

        // 저점 조건
        if (종가배열[i] < 종가배열[i - 1] && 종가배열[i] < 종가배열[i - 2] &&
            종가배열[i] < 종가배열[i + 1] && 종가배열[i] < 종가배열[i + 2]) {
          저점들.push(i)
        }
      }

      if (고점들.length < 1 || 저점들.length < 1) {
        if (!거래량급증) {
          return false
        }
      }

      // 최근 패턴 분석
      const 최근고점 = 고점들.length > 0 ? Math.min(...고점들) : -1
      const 최근저점 = 저점들.length > 0 ? Math.min(...저점들) : -1

      let 유효한풀백패턴 = false
      if (최근고점 !== -1 && 최근저점 !== -1 && 최근고점 < 최근저점) {
        const 저점_가격 = 종가배열[최근저점]
        const 현재가격 = 종가배열[0]
        const 상승률 = ((현재가격 - 저점_가격) / 저점_가격) * 100

        // 저점 이후 상승률 체크 (설정값 사용)
        const 저점이후상승중 = 상승률 >= scalpingBuy.minRiseAfterLow

        const 고점가격 = 종가배열[최근고점]
        const 풀백깊이 = ((고점가격 - 저점_가격) / 고점가격) * 100
        // 풀백 깊이 체크 (설정값 사용)
        const 적절한풀백깊이 = 풀백깊이 >= scalpingBuy.pullbackDepthMin && 풀백깊이 <= scalpingBuy.pullbackDepthMax

        // 저점 이후 상승 봉 개수 카운트 (설정값 사용)
        let 상승봉카운트 = 0
        for (let i = 최근저점 - 1; i >= 0; i--) {
          if (i + 1 < 종가배열.length && 종가배열[i] > 종가배열[i + 1]) {
            상승봉카운트++
          } else {
            break
          }
        }

        유효한풀백패턴 = 저점이후상승중 && 적절한풀백깊이 && 상승봉카운트 >= scalpingBuy.minRiseCandles
      }

      if (!유효한풀백패턴 && !거래량급증) {
        return false
      }

      // 5. 거래량 분석
      let 거래량증가 = 거래량급증
      if (!거래량증가 && 최근저점 >= 0 && 최근저점 < 전체분봉.length) {
        const 저점전거래량 = 전체분봉.slice(최근저점 + 1, 최근저점 + 4)
          .reduce((sum, c) => sum + c.거래량, 0) / 3
        const 저점후거래량 = 전체분봉.slice(0, 최근저점)
          .reduce((sum, c) => sum + c.거래량, 0) / 최근저점

        // 저점후거래량증가기준 (설정값 사용)
        거래량증가 = 저점후거래량 > 저점전거래량 * scalpingBuy.volumeIncreaseAfterLow
      }

      // 6. 거래대금 체크 (설정값 사용)
      const 거래대금 = 현재가 * stock.volume
      const 최소거래대금 = scalpingBuy.minTradingAmount * 100000000 // 억 단위
      if (거래대금 < 최소거래대금) {
        return false
      }

      // 7. RSI 분석 (설정값 사용)
      const rsi = calculateRSI(candles, scalpingBuy.rsiPeriod)
      const RSI하한 = scalpingBuy.rsiLower
      const RSI상한 = scalpingBuy.rsiUpper
      const rsi상승추세 = rsi > RSI하한 && rsi < RSI상한

      if (!rsi상승추세) {
        return false
      }

      // 8. 최종 매수 신호 결정 (설정값 사용)
      const 매수신호 = 거래량급증 
        ? (유효한풀백패턴 || 최근가격상승률 > scalpingBuy.minPriceRise) && rsi상승추세
        : 유효한풀백패턴 && (거래량증가 || true) && rsi상승추세

      if (!매수신호) {
        return false
      }

      addLog(`[스캘핑매수 성공] ${stock.name} - 전략:${거래량급증 ? '거래량급증' : '풀백재진입'}, RSI:${rsi.toFixed(2)}`, 'success')
      return true
    } catch (error: any) {
      console.error(`[스캘핑매수] ${stock.name} 오류:`, error)
      return false
    }
  }

  // 5. 돌파매수 함수 (C# 버전과 동일)
  const 돌파매수 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      if (!candles || candles.length < breakoutBuy.shortTermPeriod) {
        return false
      }

      const 최근분봉 = candles.slice(0, breakoutBuy.recentCandleCount)
      const 현재가 = stock.price
      const 현재거래량 = stock.volume

      // 1. 실시간 거래량 증가 감지 (설정값 사용)
      const 이전1분봉거래량 = 최근분봉.length > 1 ? 최근분봉[1].거래량 : 1
      const 이전3분봉평균거래량 = 최근분봉.slice(1, 1 + breakoutBuy.volume3MinPeriod)
        .reduce((sum, c) => sum + c.거래량, 0) / Math.min(breakoutBuy.volume3MinPeriod, 최근분봉.length - 1)
      const 이전5분봉평균거래량 = 최근분봉.slice(1, 1 + breakoutBuy.volume5MinPeriod)
        .reduce((sum, c) => sum + c.거래량, 0) / Math.min(breakoutBuy.volume5MinPeriod, 최근분봉.length - 1)

      const 직전대비거래량증가율 = (현재거래량 / Math.max(이전1분봉거래량, 1)) * 100
      const 최근3분대비거래량증가율 = (현재거래량 / Math.max(이전3분봉평균거래량, 1)) * 100
      const 최근5분대비거래량증가율 = (현재거래량 / Math.max(이전5분봉평균거래량, 1)) * 100

      // 거래량 급증 판단 (설정값 사용)
      const 거래량증가율기준 = breakoutBuy.volumeIncreaseRate
      const 거래량1분증가율계수 = breakoutBuy.volume1MinCoeff
      const 거래량3분증가율계수 = breakoutBuy.volume3MinCoeff
      const 거래량5분증가율계수 = breakoutBuy.volume5MinCoeff

      let 거래량급증 = false
      let 거래량증가정보 = ''

      if (직전대비거래량증가율 >= 거래량증가율기준 * 거래량1분증가율계수) {
        거래량급증 = true
        거래량증가정보 = `직전봉 대비: ${직전대비거래량증가율.toFixed(2)}%`
      } else if (최근3분대비거래량증가율 >= 거래량증가율기준 * 거래량3분증가율계수) {
        거래량급증 = true
        거래량증가정보 = `3분평균 대비: ${최근3분대비거래량증가율.toFixed(2)}%`
      } else if (최근5분대비거래량증가율 >= 거래량증가율기준 * 거래량5분증가율계수) {
        거래량급증 = true
        거래량증가정보 = `5분평균 대비: ${최근5분대비거래량증가율.toFixed(2)}%`
      }

      if (!거래량급증) {
        return false
      }

      // 2. 거래대금 체크 (설정값 사용)
      const 거래대금 = 현재가 * 현재거래량
      const 최소거래대금 = breakoutBuy.minTradingAmount * 100000000 // 억 단위
      if (거래대금 < 최소거래대금) {
        return false
      }

      // 3. 단기 가격 급등 확인 (설정값 사용)
      const 최근가격상승률 = ((현재가 - 최근분봉[1].종가) / 최근분봉[1].종가) * 100
      const idx = Math.min(breakoutBuy.priceRiseCheckPeriod, 최근분봉.length - 1)
      const 최근3분가격상승률 = ((현재가 - 최근분봉[idx].종가) / 최근분봉[idx].종가) * 100

      // 4. 이전 고점 돌파 확인 (설정값 사용)
      const 이전고점 = Math.max(...최근분봉.slice(1, 1 + breakoutBuy.prevHighPeriod).map(c => c.고가))
      const 이전고점대비상승률 = ((현재가 - 이전고점) / 이전고점) * 100

      const 이전고점대비상승률기준 = breakoutBuy.prevHighRiseRate
      const 이전고점대비상승률완화계수 = breakoutBuy.prevHighRiseRelaxCoeff
      const 최소단기상승률 = breakoutBuy.minShortRise
      const 최소3분상승률 = breakoutBuy.min3MinRise

      if (이전고점대비상승률 < 이전고점대비상승률기준 * 이전고점대비상승률완화계수) {
        if (최근가격상승률 < 최소단기상승률 && 최근3분가격상승률 < 최소3분상승률) {
          return false
        }
      }

      // 5. 등락률 체크 (설정값 사용)
      const 등락률 = stock.changePercent
      const 최소등락률 = breakoutBuy.minFluctuation
      const 최대등락률 = breakoutBuy.maxFluctuation
      const 최소등락률완화계수 = breakoutBuy.minFluctuationRelaxCoeff
      const 최대등락률확장계수 = breakoutBuy.maxFluctuationExpandCoeff

      if (등락률 < 최소등락률 * 최소등락률완화계수 || 등락률 > 최대등락률 * 최대등락률확장계수) {
        return false
      }

      // 6. 단기 이동평균선 확인 (설정값 사용)
      const 종가리스트 = 최근분봉.map(c => c.종가)
      const 단기이동평균 = 종가리스트.slice(0, breakoutBuy.shortTermPeriod).reduce((sum, p) => sum + p, 0) / breakoutBuy.shortTermPeriod

      if (현재가 < 단기이동평균 && 최근가격상승률 < breakoutBuy.priceRiseCheckThreshold) {
        return false
      }

      // 7. RSI 체크 (설정값 사용)
      const rsi = calculateRSI(candles, breakoutBuy.rsiPeriod)
      const RSI하한 = breakoutBuy.rsiLower
      const RSI하한완화계수 = breakoutBuy.rsiLowerRelaxCoeff

      if (rsi < RSI하한 * RSI하한완화계수) {
        return false
      }

      addLog(`[돌파매수 성공] ${stock.name} - ${거래량증가정보}, 등락률:${등락률.toFixed(2)}%, RSI:${rsi.toFixed(2)}`, 'success')
      return true
    } catch (error: any) {
      console.error(`[돌파매수] ${stock.name} 오류:`, error)
      return false
    }
  }

  // 매수 조건 확인 함수 (async로 변경)
  const checkBuyConditions = async (stock: DetectedStock): Promise<boolean> => {
    // 기본 매수 조건 체크
    // 1. 이미 보유 중인 종목은 제외
    if (holdingStocks.some(h => h.code === stock.code)) {
      return false
    }

    // 2. 최대 동시 보유 종목 수 체크
    if (holdingStocks.length >= maxSimultaneousBuy) {
      return false
    }

    // 3. 매매 시간 체크
    const now = new Date()
    const currentHour = now.getHours()
    const currentMinute = now.getMinutes()
    const currentSecond = now.getSeconds()
    
    const startTime = startHour * 60 + startMinute
    const endTime = endHour * 60 + endMinute + (endSecond >= 59 ? 1 : 0)
    const currentTime = currentHour * 60 + currentMinute
    
    if (currentTime < startTime || currentTime >= endTime) {
      return false
    }

    // 4. 레버리지/인버스 ETF 제외
    if (stock.name.includes('레버리지') || 
        stock.name.includes('인버스') || 
        stock.name.includes('2X') || 
        stock.name.includes('선물') || 
        stock.name.includes('KODEX') || 
        stock.name.includes('3X')) {
      return false
    }

    // 5. 자동매매는 실시간 시세를 사용해야 함 (차트 데이터는 과거 데이터)
    // 실시간 시세는 WebSocket을 통해 이미 업데이트되어 stock 객체에 포함됨
    // 차트 데이터는 선택한 종목에 대해서만 조회 (UI 표시용)
    
    // 실시간 시세 데이터 확인 (stock 객체에 이미 실시간 가격 정보가 있음)
    const 실시간가격 = stock.price || 0
    const 실시간거래량 = stock.volume || 0
    
    // 실시간 시세가 없으면 매수하지 않음
    if (실시간가격 <= 0) {
      return false
    }

    // 자동매매 시작 시점의 가격 (상대 변화율 계산용)
    // 시작 시점 가격이 없으면 현재 가격을 시작 가격으로 설정
    const 시작가격 = stock.startPrice || 실시간가격
    if (!stock.startPrice) {
      // 시작 가격이 없으면 현재 가격을 시작 가격으로 저장
      setDetectedStocks(prev => prev.map(s => 
        s.code === stock.code ? { ...s, startPrice: 실시간가격 } : s
      ))
    }

    // 자동매매 시작 시점 대비 상대 변화율 계산
    // 이 값이 매매 알고리즘의 기준이 됨 (매매설정의 % 값은 이 상대 변화율을 의미)
    const 상대변화율 = 시작가격 > 0 
      ? ((실시간가격 - 시작가격) / 시작가격) * 100 
      : 0
    
    // 실시간 등락률(전일 대비) - 현재 시점의 등락률
    const 실시간등락률 = stock.changePercent || 0
    
    // 조건 감지 시점의 등락률 (조건 감지 시점의 등락률이 없으면 현재 등락률 사용)
    const 감지시점등락률 = stock.detectedChangePercent ?? 실시간등락률
    
    // 등락률 차이 계산: 현재 등락률 - 감지 시점 등락률
    // 이 차이가 매매 설정의 % 범위와 비교됨
    const 등락률차이 = 실시간등락률 - 감지시점등락률

    // 차트 데이터 조회: 체크된 알고리즘 중 차트 분석이 필요한 알고리즘이 있으면 차트 데이터 조회
    // 차트 분석이 필요한 알고리즘: 장시작급등주, 볼린저밴드, 스캘핑, 돌파매매, 장마감종가배팅
    // 기본매수설정은 차트 분석이 필요 없음 (등락률 차이만 확인)
    const 차트분석필요알고리즘 = [
      strategyMarketOpen,   // 장시작급등주
      strategyBollinger,    // 볼린저밴드
      strategyScalping,      // 스캘핑
      strategyBreakout,      // 돌파매매
      strategyMarketClose    // 장마감종가배팅
    ]
    
    const 차트분석필요 = 차트분석필요알고리즘.some(checked => checked)
    
    let candles: CandleData[] = []
    const maxRetries = 2 // 최대 2번 재시도
    let retryCount = 0
    
    // 차트 분석이 필요한 알고리즘이 체크되어 있으면 차트 데이터 조회
    // 단, 조건검색 직후 10초 이내에는 차트 데이터 조회를 지연시켜 API 제한 방지
    if (차트분석필요) {
      const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
      if (timeSinceLastSearch < 10000) {
        // 조건검색 직후 10초 이내에는 차트 데이터 조회하지 않음
        if (process.env.NODE_ENV === 'development') {
          console.log(`[차트 데이터] ${stock.name}: 조건검색 직후 대기 중 (${Math.ceil((10000 - timeSinceLastSearch) / 1000)}초 남음)`)
        }
        // 차트 데이터 없이 진행 (실시간 시세 기반으로만 판단)
      } else {
        while (retryCount <= maxRetries && candles.length === 0) {
          try {
            // 차트 분석이 필요한 종목에 대해 차트 데이터 조회 시도
            candles = await getCandleData(stock.code)
            
            // API 제한 방지를 위한 추가 딜레이
            await new Promise(resolve => setTimeout(resolve, 500))
            
            if (candles && candles.length > 0) {
              // 체크된 알고리즘 중 가장 많은 차트 데이터가 필요한 알고리즘의 최소 요구사항 확인
              const requiredPeriods: number[] = []
              if (strategyMarketOpen) requiredPeriods.push(marketOpenBuy.shortTermPeriod || 5)
              if (strategyBollinger) requiredPeriods.push(bollingerBuy.shortTermPeriod || 5)
              if (strategyScalping) requiredPeriods.push(scalpingBuy.minCandleCount || scalpingBuy.shortTermPeriod || 5)
              if (strategyBreakout) requiredPeriods.push(breakoutBuy.shortTermPeriod || 5)
              if (strategyMarketClose) requiredPeriods.push(marketCloseBuy.minCandleCount || 5)
              
              const minRequired = requiredPeriods.length > 0 ? Math.max(...requiredPeriods) : 5
              
              if (candles.length >= minRequired) {
                // 충분한 차트 데이터가 있으면 성공
                if (retryCount > 0) {
                  addLog(`[차트 데이터] ${stock.name}: 재시도 후 성공 (${candles.length}개, 필요: ${minRequired}개)`, 'info')
                }
                break
              } else {
                // 차트 데이터가 부족하면 재시도
                candles = []
              }
            } else {
              candles = []
            }
          } catch (error: any) {
            // 차트 데이터 조회 실패 시 재시도
            candles = []
            const errorMessage = error.response?.data?.error || error.message || ''
            
            // API 제한 에러(429)는 재시도하지 않음
            if (error.response?.status === 429) {
              if (process.env.NODE_ENV === 'development') {
                console.log(`[차트 데이터] ${stock.name}: API 제한으로 재시도 중단`)
              }
              break
            }
          }
          
          // 재시도 전 대기 (API 호출 제한 방지)
          if (retryCount < maxRetries && candles.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))) // 2초, 4초 대기 (1초, 2초에서 증가)
          }
          
          retryCount++
        }
        
        // 차트 데이터가 없으면 실시간 시세 기반 로직으로 fallback
        if (candles.length === 0 && process.env.NODE_ENV === 'development') {
          console.log(`[차트 데이터] ${stock.name}: 차트 데이터 없음, 실시간 시세 기반으로 진행`)
        }
      }
    }

    // 5. My_매수신호_2 로직 적용: 체크된 매매 전략별 조건 확인
    let 매수신호 = false

    // 기본매수설정이 체크되어 있고, 등락률 차이가 0% 이하이면 다른 알고리즘의 매수 신호를 무시
    // 기본매수설정: 등락률 차이가 2% 이상 15% 이하로 상승한 종목만 매수
    const 기본매수설정차단 = strategyBasicBuy && 등락률차이 <= 0

    // 시간 구간 체크 (My_매수신호_2의 시간 구간 로직)
    const 시간외시작시각 = (startHour - 1) * 60 + 30 // 시작 1시간 전
    const 장시작시각 = marketOpenBuy.startHour * 60 + marketOpenBuy.startMinute
    const 급등주매수종료시각 = marketOpenBuy.endHour * 60 + marketOpenBuy.endMinute
    const 장마감시작시각 = 15 * 60 + 10 // 장마감 시작 시간 (15:10)
    const 장마감시각 = 15 * 60 + 20 // 장마감 종료 시간 (15:20)
    
    const 시간외거래중 = currentTime >= 시간외시작시각 && currentTime < 장시작시각
    const 장시작직후 = currentTime >= 장시작시각 && currentTime < 급등주매수종료시각
    const 장마감종가배팅 = currentTime >= 장마감시작시각 && currentTime < 장마감시각

    // 1. 장시작 급등주 매수 로직 (차트 데이터 우선 사용, 없으면 상대 변화율 기반)
    if (!기본매수설정차단 && 장시작직후 && strategyMarketOpen) {
      if (candles.length >= marketOpenBuy.shortTermPeriod) {
        // 차트 데이터가 있으면 차트 기반 전략 실행
        const 장시작급등주결과 = await 장시작급등주매수(stock, candles)
        if (장시작급등주결과) {
          매수신호 = true
          addLog(`[장시작급등주] ${stock.name}: 차트 기반 매수 신호`, 'info')
        }
      } else {
        // 차트 데이터가 없으면 시작 시점 대비 상대 변화율로 급등 여부 확인
        if (상대변화율 >= (marketOpenBuy.minFluctuation || 0)) {
          매수신호 = true
          addLog(`[장시작급등주] ${stock.name}: 시작가격 대비 ${상대변화율.toFixed(2)}% 상승 (시작: ${시작가격.toLocaleString()}원 → 현재: ${실시간가격.toLocaleString()}원)`, 'info')
        }
      }
    }

    // 장중 매매 로직 (실시간 시세 기반으로 모든 전략 실행)
    if (!기본매수설정차단 && !장시작직후 && !장마감종가배팅) {
      // 2. 볼린저밴드 기반 매수 (차트 데이터가 있으면 사용, 없으면 실시간 시세로 판단)
      if (strategyBollinger) {
        if (candles.length >= bollingerBuy.shortTermPeriod) {
          // 차트 데이터가 있으면 차트 기반 전략 실행
          const 볼린저밴드결과 = await 볼린저밴드매수(stock, candles)
          if (볼린저밴드결과) {
            매수신호 = true
            addLog(`[볼린저밴드] ${stock.name}: 차트 기반 매수 신호`, 'info')
          }
        } else {
          // 차트 데이터가 없으면 시작 시점 대비 상대 변화율로 볼린저밴드 로직 실행
          // 하락 후 반등 패턴: 시작 시점 대비 하락했다가 다시 상승하는 경우
          // 간단 버전: 상대 변화율이 -1% 이상 2% 이하이며 거래량이 있으면 매수
          if (상대변화율 >= -1 && 상대변화율 <= 2 && 실시간거래량 > 0) {
            매수신호 = true
            addLog(`[볼린저밴드] ${stock.name}: 시작가격 대비 ${상대변화율.toFixed(2)}% (하락 후 반등 패턴), 거래량 ${실시간거래량.toLocaleString()}`, 'info')
          }
        }
      }

      // 4. 스캘핑 매매 로직 (차트 데이터 우선 사용)
      if (strategyScalping) {
        if (candles.length >= scalpingBuy.minCandleCount) {
          // 차트 데이터가 충분하면 차트 기반 전략 실행 (스캘핑은 최소 설정값 개수 필요)
          const 스캘핑결과 = await 스캘핑매수(stock, candles)
          if (스캘핑결과) {
            매수신호 = true
            addLog(`[스캘핑] ${stock.name}: 차트 기반 매수 신호 (차트 데이터: ${candles.length}개)`, 'info')
          }
        } else if (candles.length >= scalpingBuy.shortTermPeriod) {
          // 차트 데이터가 부족하지만 최소 요구사항은 충족하는 경우 간단 버전 실행
          // 시작 시점부터 상승했고, 상대 변화율이 0~3% 사이이며 거래량이 있으면 매수
          if (상대변화율 > 0 && 상대변화율 <= 3 && 실시간거래량 > 0) {
            매수신호 = true
            addLog(`[스캘핑] ${stock.name}: 차트 데이터 부족, 시작가격 대비 ${상대변화율.toFixed(2)}% 상승 (차트: ${candles.length}개, 최소 ${scalpingBuy.minCandleCount}개 필요)`, 'info')
          }
        } else {
          // 차트 데이터가 없으면 시작 시점 대비 상대 변화율로 스캘핑 로직 실행
          if (상대변화율 > 0 && 상대변화율 <= 3 && 실시간거래량 > 0) {
            매수신호 = true
            addLog(`[스캘핑] ${stock.name}: 차트 데이터 없음, 시작가격 대비 ${상대변화율.toFixed(2)}% 상승, 거래량 ${실시간거래량.toLocaleString()}`, 'info')
          }
        }
      }

      // 5. 돌파매매 로직 (차트 데이터 우선 사용)
      if (strategyBreakout) {
        if (candles.length >= breakoutBuy.shortTermPeriod) {
          // 차트 데이터가 있으면 차트 기반 전략 실행 (돌파매수는 최소 설정값 개수 필요)
          const 돌파결과 = await 돌파매수(stock, candles)
          if (돌파결과) {
            매수신호 = true
            addLog(`[돌파매수] ${stock.name}: 차트 기반 매수 신호 (차트 데이터: ${candles.length}개)`, 'info')
          }
        } else {
          // 차트 데이터가 없으면 시작 시점 대비 상대 변화율로 돌파 로직 실행
          // 시작 시점부터 2% 이상 상승했으면 돌파로 판단
          if (상대변화율 >= 2 && 실시간거래량 > 0) {
            매수신호 = true
            addLog(`[돌파매수] ${stock.name}: 차트 데이터 없음, 시작가격 대비 ${상대변화율.toFixed(2)}% 돌파, 거래량 ${실시간거래량.toLocaleString()}`, 'info')
          }
        }
      }
    }

    // 3. 장마감 종가 배팅 매매 (실시간 시세 기반)
    if (!기본매수설정차단 && 장마감종가배팅 && strategyMarketClose) {
      if (candles.length >= marketCloseBuy.minCandleCount) {
        // 차트 데이터가 있으면 차트 기반 전략 실행
        if (await 장마감종가배팅매수(stock, candles)) {
          매수신호 = true
        }
      } else {
        // 차트 데이터가 없으면 실시간 시세로 장마감 매수
        // 장마감 시간대에 실시간 가격으로 매수 (간단 버전)
        if (실시간가격 > 0) {
          매수신호 = true
          addLog(`[장마감종가배팅] ${stock.name}: 실시간 가격 ${실시간가격.toLocaleString()}원`, 'info')
        }
      }
    }

    // 기본매수설정 체크 (strategyBasicBuy가 체크되어 있을 때만 적용)
    // 기본매수설정은 다른 전략과 독립적으로 실행 (OR 조건)
    // 매매설정의 % 값은 조건 감지 시점 등락률과 현재 등락률의 차이를 의미함
    // 기본매수설정: 등락률 차이가 2% 이상 15% 이하로 상승한 종목만 매수
    if (strategyBasicBuy) {
      // 등락률 차이가 설정된 범위 내에 있는지 확인
      // 등락률 차이는 반드시 양수여야 함 (상승한 경우만 매수)
      // minFluctuation(2%) 이상 maxFluctuation(15%) 이하일 때만 매수
      const basicMatch = 
        등락률차이 > 0 && // 등락률 차이가 양수여야 함 (상승한 경우만)
        (basicBuy.minFluctuation <= 0 || 등락률차이 >= basicBuy.minFluctuation) && // 최소 2% 이상
        (basicBuy.maxFluctuation <= 0 || 등락률차이 <= basicBuy.maxFluctuation) && // 최대 15% 이하
        (basicBuy.minVolume <= 0 || 실시간거래량 >= basicBuy.minVolume) // 거래량 조건
      
      if (basicMatch) {
        매수신호 = true
        addLog(`[기본매수설정] ${stock.name}: 조건 충족 (감지시점: ${감지시점등락률.toFixed(2)}% → 현재: ${실시간등락률.toFixed(2)}%, 차이: ${등락률차이.toFixed(2)}%, 거래량: ${실시간거래량.toLocaleString()})`, 'info')
      } else {
        // 등락률 차이가 0% 이하인 경우 다른 알고리즘의 매수 신호를 무시
        if (등락률차이 <= 0) {
          // 기본매수설정이 체크되어 있고 등락률 차이가 0% 이하면 다른 알고리즘의 매수 신호를 무시
          매수신호 = false
        }
      }
    }

    return 매수신호
  }

  // 매도 조건 확인 함수 (My_매도신호_1 로직 적용)
  const checkSellConditions = (holding: HoldingStock): boolean => {
    // 매도수익률설정이 체크되어 있지 않으면 매도하지 않음 (기본적으로 항상 체크되어 있다고 가정)
    // My_매도신호_1의 checkBox_매도수익률설정.Checked 로직
    
    // 최고 수익률 갱신
    if (holding.profitPercent > holding.maxProfitPercent) {
      holding.maxProfitPercent = holding.profitPercent
    }
    const 최고수익률 = holding.maxProfitPercent

    // 1. 트레일링 스탑 조건 체크 (My_매도신호_1의 트레일링 스탑 로직)
    // checkBox_Trailing매도.Checked && 최고수익률 >= numericUpDown_Trailing매도기준.Value
    if (trailingStop && 최고수익률 >= trailingProfitThreshold) {
      const 하락률기준 = Math.abs(trailingDropThreshold) // numericUpDown_Trailing최고점대비.Value
      const 현재하락률 = 최고수익률 - holding.profitPercent
      
      if (현재하락률 >= 하락률기준) {
        addLog(`[매도신호1] ${holding.name}: 트레일링 매도 - 최고수익률: ${최고수익률.toFixed(2)}% → 현재수익률: ${holding.profitPercent.toFixed(2)}% (하락률: ${현재하락률.toFixed(2)}%)`, 'warning')
        return true
      }
    }

    // 2. 익절 조건 체크 (My_매도신호_1의 익절 로직: 최고수익률이 익절기준 이상)
    // 최고수익률 >= 익절기준
    if (profitTarget > 0 && 최고수익률 >= profitTarget) {
      addLog(`[매도신호1] ${holding.name}: 익절 - 최고수익률: ${최고수익률.toFixed(2)}% (기준: ${profitTarget}%)`, 'success')
      return true
    }

    // 3. 손절 조건 체크 (My_매도신호_1의 손절 로직: 현재수익률이 손절기준 이하)
    // 현재수익률 <= 손절기준
    if (lossLimit < 0 && holding.profitPercent <= lossLimit) {
      addLog(`[매도신호1] ${holding.name}: 손절 - 현재수익률: ${holding.profitPercent.toFixed(2)}% (기준: ${lossLimit}%)`, 'warning')
      return true
    }

    // 4. 시간 매도 조건 체크 (15:19:59 이후 강제 매도)
    if (dropSellTime) {
      const now = new Date()
      const currentHour = now.getHours()
      const currentMinute = now.getMinutes()
      const currentSecond = now.getSeconds()
      
      const dropSellTimeMinutes = dropSellStartHour * 60 + dropSellStartMinute
      const currentTimeMinutes = currentHour * 60 + currentMinute
      
      if (currentTimeMinutes >= dropSellTimeMinutes && currentSecond >= dropSellEndSecond) {
        addLog(`${holding.name} 시간 매도 조건 달성`, 'warning')
        return true
      }
    }

    return false
  }

  // 자동매매 실행 함수
  const executeAutoTrading = async () => {
    if (!isRunning || !selectedAccount) {
      return
    }

    try {
      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'

      // 1. 조건식 검색 실행 (주기적으로)
      const enabledConditions = conditions.filter(c => c.enabled)
      if (enabledConditions.length > 0) {
        const result = await kiwoomApi.searchCondition(enabledConditions)
        
        if (result.success && result.stocks && result.stocks.length > 0) {
          // 검색된 종목 업데이트
          // 기존 종목의 시작 가격과 감지 시점 등락률은 유지하고, 새로 검색된 종목만 설정
          let newStocks: DetectedStock[] = []
          setDetectedStocks(prevStocks => {
            const existingStartPrices = new Map(prevStocks.map(s => [s.code, s.startPrice]))
            const existingDetectedChangePercent = new Map(prevStocks.map(s => [s.code, s.detectedChangePercent]))
            
            newStocks = result.stocks.map((stock: any) => {
              const existingStock = prevStocks.find(s => s.code === stock.code)
              return {
                code: stock.code,
                name: stock.name,
                price: stock.price,
                change: stock.price * (stock.changeRate / 100),
                changePercent: stock.changeRate,
                volume: stock.volume,
                detectedCondition: result.appliedConditions.join(', '),
                detectedTime: existingStock?.detectedTime || new Date().toLocaleTimeString(),
                // 기존 종목이면 시작 가격 유지, 새 종목이면 현재 가격을 시작 가격으로 설정
                startPrice: existingStartPrices.get(stock.code) || stock.price,
                // 기존 종목이면 감지 시점 등락률 유지, 새 종목이면 현재 등락률을 감지 시점 등락률로 설정
                detectedChangePercent: existingDetectedChangePercent.get(stock.code) ?? stock.changeRate
              }
            })
            
            return newStocks
          })

          // 조건검색 시간 기록 (차트 데이터 조회 지연용)
          lastSearchTimeRef.current = Date.now()

          // 2. 매수 조건 확인 및 실행 (차트 데이터 기반으로 수행)
          // API 제한을 고려하여 종목별로 딜레이 추가
          for (let i = 0; i < newStocks.length; i++) {
            const stock = newStocks[i]
            if (!isRunning) break // 중지되면 중단
            
            // 당일 최대매매종목수 체크
            if (maxDailyStocks > 0 && dailyTradeCount >= maxDailyStocks) {
              addLog(`[제한] 당일 최대매매종목수 도달 (${maxDailyStocks}개)`, 'warning')
              break
            }
            
            // 종목당 매매허용횟수 체크
            const tradeCount = stockTradeCounts.get(stock.code) || 0
            if (tradeLimitPerStock > 0 && tradeCount >= tradeLimitPerStock) {
              continue // 이 종목은 더 이상 매매 불가
            }
            
            // API 제한 방지를 위한 딜레이 (조건검색 직후에는 더 긴 딜레이)
            const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
            if (timeSinceLastSearch < 10000) {
              // 조건검색 직후 10초 이내에는 각 종목 처리 전 1초 대기
              await new Promise(resolve => setTimeout(resolve, 1000))
            } else {
              // 그 이후에는 500ms 대기
              await new Promise(resolve => setTimeout(resolve, 500))
            }
            
            // 차트 데이터 기반으로 매수 조건 확인 (차트 데이터를 우선적으로 사용)
            if (await checkBuyConditions(stock)) {
              try {
                // 종목코드 검증: 6자리 숫자만 허용 (ELW, ETF 등 비표준 종목코드 제외)
                const stockCode = String(stock.code).trim()
                if (!/^\d{6}$/.test(stockCode)) {
                  addLog(`[자동매수 건너뜀] ${stock.name} (${stockCode}): 지원하지 않는 종목코드 형식 (6자리 숫자만 지원)`, 'warning')
                  continue
                }
                
                // 매수 수량 계산 (종목당 투자금액 기준)
                const buyPrice = stock.price || 0
                if (buyPrice <= 0) continue
                
                // 수수료 고려한 매수 수량 계산
                const investmentAmount = amountPerStock
                const feeRate = feePercent / 100
                const availableAmount = investmentAmount * (1 - feeRate)
                const quantity = Math.floor(availableAmount / buyPrice)
                
                if (quantity <= 0) continue

                // 매수 주문 실행
                const orderPrice = buyPrice + Math.floor(buyPrice * (basicBuy.buyPriceAdjustment / 100))
                await kiwoomApi.placeOrder({
                  code: stockCode,
                  quantity: quantity,
                  price: orderPrice, // 지정가 (현재가 + 조정%)
                  order_type: 'buy',
                  order_option: buyType === 'cash' ? '00' : '03', // 현금매수 또는 신용매수
                  accountNo,
                  accountProductCode,
                })

                // 매매 횟수 업데이트
                setStockTradeCounts(prev => {
                  const newMap = new Map(prev)
                  newMap.set(stock.code, (newMap.get(stock.code) || 0) + 1)
                  return newMap
                })
                
                // 당일 매매 종목 추가
                if (!dailyTradedStocks.has(stock.code)) {
                  setDailyTradedStocks(prev => new Set(prev).add(stock.code))
                  setDailyTradeCount(prev => prev + 1)
                }

                addLog(`[자동매수] ${stock.name} ${quantity}주 매수 주문 (${orderPrice.toLocaleString()}원, 매매횟수: ${tradeCount + 1}/${tradeLimitPerStock})`, 'success')
                
                // API 호출 제한을 위한 딜레이
                await new Promise(resolve => setTimeout(resolve, 500))
              } catch (error: any) {
                // 모의투자 환경 제한 에러인 경우 경고로 처리
                if (error.response?.data?.isMockApiLimit || error.message?.includes('모의투자 환경 제한')) {
                  addLog(`[자동매수 건너뜀] ${stock.name}: 모의투자 환경에서 주문 제한됨`, 'warning')
                } else {
                  addLog(`[자동매수 실패] ${stock.name}: ${error.message}`, 'error')
                }
              }
            }
          }
        }
      }

      // 3. 보유 종목 매도 조건 확인 및 실행
      for (const holding of holdingStocks) {
        if (!isRunning) break // 중지되면 중단
        
        if (checkSellConditions(holding)) {
          try {
            // 매도 가격 결정
            let sellPrice = 0 // 시장가
            let orderOption = '03' // 시장가
            
            // 익절인 경우
            if (holding.profitPercent >= profitTarget) {
              if (profitType === 'market') {
                sellPrice = 0
                orderOption = '03' // 시장가
              } else {
                // 지정가 (현재가 사용)
                sellPrice = holding.currentPrice
                orderOption = '00' // 지정가
              }
            }
            // 손절인 경우
            else if (holding.profitPercent <= lossLimit) {
              if (lossType === 'market') {
                sellPrice = 0
                orderOption = '03' // 시장가
              } else {
                // 지정가 매도호가 (현재가 + lossPriceOffset)
                sellPrice = Math.max(0, holding.currentPrice + lossPriceOffset)
                orderOption = '00' // 지정가
              }
            }
            // 시간 매도 또는 트레일링 스톱인 경우
            else {
              // 시장가로 매도
              sellPrice = 0
              orderOption = '03' // 시장가
            }

            // 종목코드 검증: 6자리 숫자만 허용 (ELW, ETF 등 비표준 종목코드 제외)
            const stockCode = String(holding.code).trim()
            if (!/^\d{6}$/.test(stockCode)) {
              addLog(`[자동매도 건너뜀] ${holding.name} (${stockCode}): 지원하지 않는 종목코드 형식 (6자리 숫자만 지원)`, 'warning')
              continue
            }

            // 매도 주문 실행
            await kiwoomApi.placeOrder({
              code: stockCode,
              quantity: holding.quantity,
              price: sellPrice,
              order_type: 'sell',
              order_option: orderOption,
              accountNo,
              accountProductCode,
            })

            const priceType = sellPrice === 0 ? '시장가' : `지정가(${sellPrice.toLocaleString()}원)`
            addLog(`[자동매도] ${holding.name} ${holding.quantity}주 매도 주문 (${priceType}, 수익률: ${holding.profitPercent.toFixed(2)}%)`, 'success')
            
            // API 호출 제한을 위한 딜레이
            await new Promise(resolve => setTimeout(resolve, 500))
          } catch (error: any) {
            // 모의투자 환경 제한 에러인 경우 경고로 처리
            if (error.response?.data?.isMockApiLimit || error.message?.includes('모의투자 환경 제한')) {
              addLog(`[자동매도 건너뜀] ${holding.name}: 모의투자 환경에서 주문 제한됨`, 'warning')
            } else {
              addLog(`[자동매도 실패] ${holding.name}: ${error.message}`, 'error')
            }
          }
        }
      }

      // 계좌 정보 갱신
      queryClient.invalidateQueries('balance')
    } catch (error: any) {
      console.error('자동매매 실행 오류:', error)
      // 에러는 조용히 처리 (너무 많은 로그 방지)
    }
  }

  // 자동매매 주기적 실행 (isRunning이 true일 때)
  useEffect(() => {
    if (!isRunning) {
      return
    }

    let intervalId: number | null = null

    // 첫 실행은 약간의 딜레이 후
    const timeoutId = window.setTimeout(() => {
      executeAutoTrading()
      
      // 이후 10초마다 실행 (조건식 검색 + 매수/매도 체크)
      intervalId = window.setInterval(() => {
        executeAutoTrading()
      }, 10000) // 10초마다
    }, 2000) // 첫 실행은 2초 후

    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]) // isRunning만 의존성으로 사용 (함수 내부에서 최신 상태 참조)

  // 날짜 변경 시 당일 매매 통계 초기화
  useEffect(() => {
    const checkDateChange = () => {
      const today = new Date().toDateString()
      const lastDate = localStorage.getItem('lastTradeDate')
      
      if (lastDate !== today) {
        setStockTradeCounts(new Map())
        setDailyTradedStocks(new Set())
        setDailyTradeCount(0)
        localStorage.setItem('lastTradeDate', today)
        addLog('새로운 거래일 시작 - 매매 통계 초기화', 'info')
      }
    }

    // 매일 자정에 체크
    checkDateChange()
    const intervalId = setInterval(checkDateChange, 60000) // 1분마다 체크

    return () => clearInterval(intervalId)
  }, [])

  // 전량매도 버튼 클릭
  const handleSellAll = async () => {
    if (holdingStocks.length === 0) {
      return
    }

    if (!selectedAccount) {
      return
    }

    if (!window.confirm(`보유 중인 ${holdingStocks.length}개 종목을 모두 매도하시겠습니까?`)) {
      return
    }

    try {
      let successCount = 0
      for (const stock of holdingStocks) {
        try {
          // 종목코드 검증: 6자리 숫자만 허용 (ELW, ETF 등 비표준 종목코드 제외)
          const stockCode = String(stock.code).trim()
          if (!/^\d{6}$/.test(stockCode)) {
            addLog(`[전량매도 건너뜀] ${stock.name} (${stockCode}): 지원하지 않는 종목코드 형식 (6자리 숫자만 지원)`, 'warning')
            continue
          }
          
          const accountParts = selectedAccount.split('-')
          const accountNo = accountParts[0] || selectedAccount
          const accountProductCode = accountParts[1] || '01'

          await kiwoomApi.placeOrder({
            code: stockCode,
            quantity: stock.quantity,
            price: 0, // 시장가
            order_type: 'sell',
            order_option: '03', // 시장가
            accountNo,
            accountProductCode,
          })

          successCount++
          addLog(`${stock.name} 전량매도 주문 전송`, 'success')
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error: any) {
          // 모의투자 환경 제한 에러인 경우 경고로 처리
          if (error.response?.data?.isMockApiLimit || error.message?.includes('모의투자 환경 제한')) {
            addLog(`${stock.name} 전량매도 건너뜀: 모의투자 환경에서 주문 제한됨`, 'warning')
          } else {
            addLog(`${stock.name} 매도 실패: ${error.message}`, 'error')
          }
        }
      }

      if (successCount > 0) {
        queryClient.invalidateQueries('balance')
      }
    } catch (error: any) {
      addLog(`전량매도 처리 중 오류: ${error.message}`, 'error')
    }
  }

  // 미체결 주문 취소
  const handleCancelUnfilledOrders = async () => {
    try {
      const unfilledOrders = orderLogs.filter(o => o.status === '접수' || o.status === '확인')
      if (unfilledOrders.length === 0) {
        return
      }

      // TODO: 미체결 주문 취소 API 구현 필요
      addLog(`미체결 주문 ${unfilledOrders.length}건 취소 요청`, 'info')
      queryClient.invalidateQueries('orders')
    } catch (error: any) {
      addLog(`미체결 주문 취소 실패: ${error.message}`, 'error')
    }
  }

  // 계좌 갱신
  const handleRefreshAccount = async () => {
    queryClient.invalidateQueries('balance')
    queryClient.invalidateQueries('orders')
    addLog('계좌 정보 갱신', 'info')
  }

  // 프로그램 재시작
  const handleRestart = () => {
    if (window.confirm('프로그램을 재시작하시겠습니까?')) {
      window.location.reload()
    }
  }

  useEffect(() => {
    // connected 상태와 isConnected 상태 동기화
    setIsConnected(connected)
    
    if (connected) {
      addLog('키움증권 API 연결 성공', 'success')
    } else {
      addLog('키움증권 API 연결 안됨', 'warning')
    }
  }, [connected])

  // 조건식 변경시 텍스트 업데이트
  useEffect(() => {
    const selected = conditions.filter(c => c.enabled)
    if (selected.length === 0) {
      setSelectedConditionText('선택된 조건식이 없습니다. 조건식을 체크해주세요.')
    } else {
      setSelectedConditionText(selected.map(c => c.name).join(' § '))
    }
  }, [conditions])

  // localStorage에서 API 키 로드
  useEffect(() => {
    try {
      const savedLicenseKey = localStorage.getItem('kiwoom_license_key')
      const savedAppkey = localStorage.getItem('kiwoom_appkey')
      const savedSecretkey = localStorage.getItem('kiwoom_secretkey')
      const savedApiMode = localStorage.getItem('kiwoom_apimode')
      
      // 라이선스 키가 있으면 우선 사용
      if (savedLicenseKey) {
        setLicenseKey(savedLicenseKey)
        setUseLicenseKey(true)
      } else {
        // 직접 입력 모드
        if (savedAppkey) setAppkey(savedAppkey)
        if (savedSecretkey) setSecretkey(savedSecretkey)
        setUseLicenseKey(false)
      }
      
      if (savedApiMode) setApiMode(savedApiMode as 'real' | 'virtual')
    } catch (error) {
      console.error('API 키 로드 오류:', error)
    }
  }, [])

  // localStorage에서 선택된 종목 로드
  useEffect(() => {
    try {
      const saved = localStorage.getItem('watchlistStocks')
      if (saved) {
        const parsed = JSON.parse(saved)
        setWatchlistStocks(parsed)
        addLog(`선택된 종목 ${parsed.length}개 불러옴`, 'info')
      }
    } catch (error) {
      console.error('선택된 종목 로드 오류:', error)
    }
  }, [])

  // 선택된 종목 변경시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem('watchlistStocks', JSON.stringify(watchlistStocks))
    } catch (error) {
      console.error('선택된 종목 저장 오류:', error)
    }
  }, [watchlistStocks])

  // localStorage에서 매매설정 로드
  useEffect(() => {
    try {
      const savedAmountPerStock = localStorage.getItem('amountPerStock')
      if (savedAmountPerStock) {
        const parsed = Number(savedAmountPerStock)
        if (!isNaN(parsed) && parsed > 0) {
          setAmountPerStock(parsed)
        }
      }
      const savedMaxSimultaneousBuy = localStorage.getItem('maxSimultaneousBuy')
      if (savedMaxSimultaneousBuy) {
        const parsed = Number(savedMaxSimultaneousBuy)
        if (!isNaN(parsed) && parsed > 0) {
          setMaxSimultaneousBuy(parsed)
        }
      }
      const savedTradeLimitPerStock = localStorage.getItem('tradeLimitPerStock')
      if (savedTradeLimitPerStock) {
        const parsed = Number(savedTradeLimitPerStock)
        if (!isNaN(parsed) && parsed > 0) {
          setTradeLimitPerStock(parsed)
        }
      }
      const savedMaxDailyStocks = localStorage.getItem('maxDailyStocks')
      if (savedMaxDailyStocks) {
        const parsed = Number(savedMaxDailyStocks)
        if (!isNaN(parsed) && parsed > 0) {
          setMaxDailyStocks(parsed)
        }
      }
      const savedFeePercent = localStorage.getItem('feePercent')
      if (savedFeePercent) {
        const parsed = Number(savedFeePercent)
        if (!isNaN(parsed) && parsed >= 0) {
          setFeePercent(parsed)
        }
      }
    } catch (error) {
      console.error('매매설정 로드 오류:', error)
    }
  }, [])

  // 매매설정 변경시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem('amountPerStock', amountPerStock.toString())
      localStorage.setItem('maxSimultaneousBuy', maxSimultaneousBuy.toString())
      localStorage.setItem('tradeLimitPerStock', tradeLimitPerStock.toString())
      localStorage.setItem('maxDailyStocks', maxDailyStocks.toString())
      localStorage.setItem('feePercent', feePercent.toString())
    } catch (error) {
      console.error('매매설정 저장 오류:', error)
    }
  }, [amountPerStock, maxSimultaneousBuy, tradeLimitPerStock, maxDailyStocks, feePercent])

  // 알고리즘 설정값 localStorage에서 로드
  useEffect(() => {
    try {
      const savedMarketOpenBuy = localStorage.getItem('marketOpenBuy')
      if (savedMarketOpenBuy) {
        const parsed = JSON.parse(savedMarketOpenBuy)
        setMarketOpenBuy(parsed)
      }

      const savedBollingerBuy = localStorage.getItem('bollingerBuy')
      if (savedBollingerBuy) {
        const parsed = JSON.parse(savedBollingerBuy)
        setBollingerBuy(parsed)
      }

      const savedScalpingBuy = localStorage.getItem('scalpingBuy')
      if (savedScalpingBuy) {
        const parsed = JSON.parse(savedScalpingBuy)
        setScalpingBuy(parsed)
      }

      const savedBreakoutBuy = localStorage.getItem('breakoutBuy')
      if (savedBreakoutBuy) {
        const parsed = JSON.parse(savedBreakoutBuy)
        setBreakoutBuy(parsed)
      }

      const savedMarketCloseBuy = localStorage.getItem('marketCloseBuy')
      if (savedMarketCloseBuy) {
        const parsed = JSON.parse(savedMarketCloseBuy)
        setMarketCloseBuy(parsed)
      }
    } catch (error) {
      console.error('알고리즘 설정값 로드 오류:', error)
    }
  }, [])

  // 알고리즘 설정값 변경시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem('marketOpenBuy', JSON.stringify(marketOpenBuy))
    } catch (error) {
      console.error('장시작급등주 설정 저장 오류:', error)
    }
  }, [marketOpenBuy])

  useEffect(() => {
    try {
      localStorage.setItem('bollingerBuy', JSON.stringify(bollingerBuy))
    } catch (error) {
      console.error('볼린저밴드 설정 저장 오류:', error)
    }
  }, [bollingerBuy])

  useEffect(() => {
    try {
      localStorage.setItem('scalpingBuy', JSON.stringify(scalpingBuy))
    } catch (error) {
      console.error('스캘핑 설정 저장 오류:', error)
    }
  }, [scalpingBuy])

  useEffect(() => {
    try {
      localStorage.setItem('breakoutBuy', JSON.stringify(breakoutBuy))
    } catch (error) {
      console.error('돌파매수 설정 저장 오류:', error)
    }
  }, [breakoutBuy])

  useEffect(() => {
    try {
      localStorage.setItem('marketCloseBuy', JSON.stringify(marketCloseBuy))
    } catch (error) {
      console.error('장마감종가배팅 설정 저장 오류:', error)
    }
  }, [marketCloseBuy])

  // 디버깅: 컴포넌트가 렌더링되는지 확인 (개발 환경에서만)
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log('AutoTrading 컴포넌트 렌더링됨')
      console.log('connected:', connected)
      console.log('selectedAccount:', selectedAccount)
      console.log('conditions:', conditions.length)
    }
  }, [connected, selectedAccount, conditions.length]) // 의존성 배열 추가로 불필요한 로그 방지

  // F12 키로 관리자 아이콘 표시/숨김 토글
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // F12 키 감지
      if (e.key === 'F12') {
        e.preventDefault() // 기본 동작(개발자 도구 열기) 방지
        setShowAdminIcon(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <>
      <style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
            max-height: 0;
          }
          to {
            opacity: 1;
            transform: translateY(0);
            max-height: 500px;
          }
        }
        @media (max-width: 768px) {
          .auto-trading-container {
            padding-left: 24px;
            padding-right: 24px;
          }
          .trading-conditions-section {
            border-radius: 8px;
            margin-left: 8px;
            margin-right: 8px;
            margin-top: 8px;
            margin-bottom: 8px;
          }
          .bg-gradient-dark .trading-conditions-section {
            border: 1px solid #4b5563;
          }
          .bg-gray-50 .trading-conditions-section {
            border: 1px solid #d1d5db;
          }
          .account-summary-section {
            border-radius: 8px;
            margin-left: 8px;
            margin-right: 8px;
            margin-top: 8px;
            margin-bottom: 8px;
          }
          .bg-gradient-dark .account-summary-section {
            border: 1px solid #4b5563;
          }
          .bg-gray-50 .account-summary-section {
            border: 1px solid #d1d5db;
          }
        }
      `}</style>
      <div 
        className={`w-screen h-screen overflow-hidden flex flex-col auto-trading-container ${
          theme === 'dark' 
            ? 'bg-gradient-dark text-dark-text' 
            : 'bg-gray-50 text-gray-900'
        }`}
        style={{ 
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          padding: 0
        }}
      >
      {/* 상단 헤더 - 계좌 선택 */}
      <div 
        className={`px-2 py-1.5 flex items-center gap-2 flex-shrink-0 flex-wrap border-b backdrop-blur-sm ${
          theme === 'dark' 
            ? 'bg-dark-surface/80 border-dark-border' 
            : 'bg-white/90 border-gray-300'
        }`}
      >
        <label style={{ fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap', color: theme === 'dark' ? '#d1d5db' : '#111827' }}>계좌번호:</label>
        <input
          type="text"
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          disabled={isRunning}
          placeholder="계좌번호 입력"
          style={{
            padding: '4px 8px',
            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
            borderRadius: '4px',
            backgroundColor: isRunning 
              ? (theme === 'dark' ? '#374151' : '#f3f4f6')
              : (theme === 'dark' ? '#374151' : 'white'),
            color: theme === 'dark' ? '#f3f4f6' : '#111827',
            fontSize: '12px',
            flex: 1,
            minWidth: '120px'
          }}
        />
        <span style={{ fontSize: '10px', color: '#6b7280', display: 'none' }}>
          (키움증권 API 사용신청 시 등록한 계좌번호)
        </span>
        <div 
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            marginLeft: 'auto',
            flexShrink: 0
          }}
        >
          {/* 연결 상태 표시 */}
          <div 
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '4px',
              color: isConnected ? '#16a34a' : '#dc2626'
            }}
          >
            <div 
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: isConnected ? '#22c55e' : '#ef4444'
              }}
            />
            <span style={{ fontSize: '11px', color: theme === 'dark' ? (isConnected ? '#22c55e' : '#ef4444') : (isConnected ? '#16a34a' : '#dc2626') }}>{isConnected ? '연결됨' : '연결 안됨'}</span>
          </div>

          {/* 로그인 버튼 */}
          {!isConnected ? (
            <button
              onClick={() => setShowLoginModal(true)}
              className="btn-gradient-primary text-xs px-4 py-2 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
              <span className="font-bold text-white">로그인</span>
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              className="px-4 py-2 rounded-full text-xs font-semibold text-white flex items-center gap-2 bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 shadow-lg hover:shadow-red-500/50 transition-all duration-300"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              연결 해제
            </button>
          )}
        </div>
      </div>

      {/* 탭 네비게이션 */}
      <div 
        className={`border-b flex flex-shrink-0 backdrop-blur-sm ${
          theme === 'dark' 
            ? 'bg-dark-surface/80 border-dark-border' 
            : 'bg-white/90 border-gray-300'
        }`}
      >
        {[
          { 
            key: 'orders', 
            label: '주문시작',
            icon: (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )
          },
          { 
            key: 'conditions', 
            label: '매매조건',
            icon: (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            )
          },
          { 
            key: 'strategies', 
            label: '매매설정',
            icon: (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            )
          },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            className={`px-3 py-2 text-xs font-semibold border-t-0 border-l-0 border-r-0 border-b-2 cursor-pointer outline-none flex-1 transition-all duration-300 flex items-center justify-center gap-2 ${
              activeTab === tab.key
                ? theme === 'dark'
                  ? 'border-primary-green text-primary-green bg-dark-surface/50'
                  : 'border-blue-600 text-blue-600 bg-blue-50'
                : theme === 'dark'
                  ? 'border-transparent text-dark-text-secondary hover:text-primary-green hover:bg-dark-surface/30'
                  : 'border-transparent text-gray-600 hover:text-blue-600 hover:bg-gray-50'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* 메인 콘텐츠 영역 */}
      <div 
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        }}
      >
        {activeTab === 'orders' && (
          <div 
            style={{
              flex: 1,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: theme === 'dark' ? '#111827' : 'white',
              minHeight: 0
            }}
          >
            {/* 상단: 매매 조건 섹션 */}
            <div 
              className="trading-conditions-section"
              style={{
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
                padding: '5px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
                flexShrink: 0
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                <h2 style={{ 
                  fontSize: '18px', 
                  fontWeight: 'bold', 
                  width: '300px',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
                  매매 조건
                </h2>
                {/* 테마 전환 스위치 */}
                <button
                  onClick={toggleTheme}
                  className="relative w-12 h-6 rounded-full transition-all duration-300 bg-gradient-to-r from-blue-600 to-green-500 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  aria-label="테마 전환"
                  style={{ flexShrink: 0 }}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transform transition-transform duration-300 flex items-center justify-center ${
                      theme === 'dark' ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  >
                    {theme === 'dark' ? (
                      <svg className="w-3 h-3 text-gray-800" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                </button>
              </div>
              
              {/* 조건식 선택 */}
              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#374151' }}>선택된 조건식: </span>
                <span style={{ fontSize: '14px', color: '#16a34a', fontWeight: 500 }}>
                  {conditions.filter(c => c.enabled).length > 0 
                    ? conditions.filter(c => c.enabled).map(c => c.name).join(', ')
                    : '없음'}
                </span>
              </div>

              {/* 선택된 종목 */}
              <div style={{ marginBottom: '16px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#374151' }}>선택된 종목: </span>
                <span style={{ fontSize: '14px', color: '#f59e0b', fontWeight: 500 }}>
                  {watchlistStocks.length > 0 
                    ? watchlistStocks.map(s => s.name).join(', ')
                    : '없음'}
                </span>
              </div>

              {/* 매수유형 */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ fontSize: '14px', fontWeight: 500, display: 'block', marginBottom: '8px', color: theme === 'dark' ? '#d1d5db' : '#111827' }}>매수유형</label>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="buyType"
                      value="cash"
                      checked={buyType === 'cash'}
                      onChange={(e) => setBuyType(e.target.value as 'cash')}
                      style={{ width: '16px', height: '16px' }}
                    />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>현금매수</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="buyType"
                      value="credit"
                      checked={buyType === 'credit'}
                      onChange={(e) => setBuyType(e.target.value as 'credit')}
                      style={{ width: '16px', height: '16px' }}
                    />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>신용매수</span>
                  </label>
                </div>
              </div>

              {/* 제어 버튼 그리드 */}
              <div 
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  columnGap: '2px',
                  rowGap: '2px',
                  height: '145px'
                }}
              >
                <button
                  onClick={handleStart}
                  disabled={!connected || !selectedAccount || isRunning}
                  className={`px-6 py-2 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                    (!connected || !selectedAccount || isRunning)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'btn-gradient-primary'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-bold text-white text-base">자동매매</span>
                </button>
                <button
                  onClick={handleCancelUnfilledOrders}
                  disabled={!connected || !selectedAccount}
                  className={`px-4 py-2 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                    (!connected || !selectedAccount)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 shadow-lg hover:shadow-yellow-500/50'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="font-bold text-white text-base">미체결주문취소</span>
                </button>
                <button
                  onClick={handleSellAll}
                  disabled={!connected || !selectedAccount || holdingStocks.length === 0}
                  className={`px-4 py-2 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                    (!connected || !selectedAccount || holdingStocks.length === 0)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 shadow-lg hover:shadow-orange-500/50'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                  </svg>
                  <span className="font-bold text-white text-base">선택매도</span>
                </button>
                <button
                  onClick={handleStop}
                  disabled={!isRunning}
                  className={`px-4 py-2 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                    !isRunning
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 shadow-lg hover:shadow-red-500/50'
                  }`}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6h12v12H6z" />
                  </svg>
                  <span className="font-bold text-white text-base">정지</span>
                </button>
                <button
                  onClick={handleRestart}
                  className="px-4 py-2 rounded-full font-semibold text-sm flex items-center gap-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 shadow-lg hover:shadow-purple-500/50 transition-all duration-300"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="font-bold text-white text-base">재시작</span>
                </button>
                <button
                  onClick={handleRefreshAccount}
                  disabled={!connected || !selectedAccount}
                  className={`px-4 py-2 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                    (!connected || !selectedAccount)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'btn-gradient-primary'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="font-bold text-white text-base">갱신</span>
                </button>
              </div>
            </div>

            {/* 계좌 요약 */}
            <div
              className="account-summary-section"
              style={{
                padding: '12px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
                flexShrink: 0
              }}
            >
              <h3 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '12px', color: theme === 'dark' ? '#f3f4f6' : '#111827', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                계좌 요약
              </h3>
              {(accountInfoData?.error || accountInfoError) && (
                <div style={{
                  padding: '8px',
                  backgroundColor: '#fef3c7',
                  border: '1px solid #f59e0b',
                  borderRadius: '4px',
                  marginBottom: '8px',
                  fontSize: '11px',
                  color: '#92400e'
                }}>
                  ⚠️ {accountInfoData?.error || accountInfoError?.message || '계좌 정보 조회 중 오류가 발생했습니다.'}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px', fontSize: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>예수금:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountInfoData?.deposit ? Number(accountInfoData.deposit).toLocaleString() : '-'}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '11px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총매입금액:</label>
                  <input
                    type="text"
                    readOnly
                    value={holdingStocks.reduce((sum, s) => sum + (s.purchasePrice * s.quantity), 0).toLocaleString()}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '11px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총평가금액:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountInfoData?.totalAsset ? Number(accountInfoData.totalAsset).toLocaleString() : holdingStocks.reduce((sum, s) => sum + (s.currentPrice * s.quantity), 0).toLocaleString()}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '11px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총평가손익:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountInfoData?.totalProfit ? Number(accountInfoData.totalProfit).toLocaleString() : holdingStocks.reduce((sum, s) => sum + s.profit, 0).toLocaleString()}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      textAlign: 'right',
                      fontSize: '11px',
                      color: (accountInfoData?.totalProfit ? Number(accountInfoData.totalProfit) : holdingStocks.reduce((sum, s) => sum + s.profit, 0)) > 0 ? '#dc2626' :
                             (accountInfoData?.totalProfit ? Number(accountInfoData.totalProfit) : holdingStocks.reduce((sum, s) => sum + s.profit, 0)) < 0 ? '#2563eb' : 
                             (theme === 'dark' ? '#f3f4f6' : '#000')
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총수익률:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountInfoData?.totalProfitRate ? Number(accountInfoData.totalProfitRate).toFixed(2) + '%' : (() => {
                      const 총매입 = holdingStocks.reduce((sum, s) => sum + (s.purchasePrice * s.quantity), 0)
                      const 총손익 = holdingStocks.reduce((sum, s) => sum + s.profit, 0)
                      return 총매입 > 0 ? ((총손익 / 총매입) * 100).toFixed(2) + '%' : '0.00%'
                    })()}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      textAlign: 'right',
                      fontSize: '11px',
                      color: (accountInfoData?.totalProfitRate ? Number(accountInfoData.totalProfitRate) : (() => {
                        const 총매입 = holdingStocks.reduce((sum, s) => sum + (s.purchasePrice * s.quantity), 0)
                        const 총손익 = holdingStocks.reduce((sum, s) => sum + s.profit, 0)
                        return 총매입 > 0 ? ((총손익 / 총매입) * 100) : 0
                      })()) > 0 ? '#dc2626' :
                             (accountInfoData?.totalProfitRate ? Number(accountInfoData.totalProfitRate) : (() => {
                               const 총매입 = holdingStocks.reduce((sum, s) => sum + (s.purchasePrice * s.quantity), 0)
                               const 총손익 = holdingStocks.reduce((sum, s) => sum + s.profit, 0)
                               return 총매입 > 0 ? ((총손익 / 총매입) * 100) : 0
                             })()) < 0 ? '#2563eb' : 
                             (theme === 'dark' ? '#f3f4f6' : '#000')
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>보유종목:</label>
                  <span style={{ fontWeight: 'bold', fontSize: '12px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{holdingStocks.length}개</span>
                </div>
              </div>
            </div>

            {/* 주문 내역 */}
            <div 
              style={{
                minHeight: '200px',
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
                padding: '8px',
                flexShrink: 0,
                backgroundColor: theme === 'dark' ? '#111827' : 'transparent'
              }}
            >
              <div style={{ 
                marginBottom: '8px', 
                padding: '4px', 
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb', 
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db' 
              }}>
                <h3 style={{ fontSize: '12px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  주문 내역
                </h3>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>시간</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>종목명</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>구분</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>수량</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>가격</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderLogs.length > 0 ? (
                      orderLogs.map((order) => (
                        <tr
                          key={order.id} 
                          style={{ cursor: 'pointer', backgroundColor: theme === 'dark' ? '#1f2937' : 'white' }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f9fafb'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : 'white'
                          }}
                        >
                          <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.time}</td>
                          <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.stockName}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'center',
                            color: order.type === 'buy' ? '#dc2626' : '#2563eb'
                          }}>
                            {order.type === 'buy' ? '매수' : order.type === 'sell' ? '매도' : '취소'}
                          </td>
                          <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.quantity.toLocaleString()}</td>
                          <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.price.toLocaleString()}</td>
                          <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.status}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '16px', 
                          textAlign: 'center', 
                          color: theme === 'dark' ? '#9ca3af' : '#6b7280', 
                          backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb' 
                        }}>
                          주문 내역이 없습니다
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 선택된 종목 */}
            {watchlistStocks.length > 0 && (
              <div 
                style={{
                  minHeight: '200px',
                  borderTop: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  padding: '8px',
                  flexShrink: 0,
                  backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb'
                }}
              >
                <div style={{ 
                  marginBottom: '8px', 
                  padding: '4px', 
                  backgroundColor: theme === 'dark' ? '#374151' : '#e5e7eb', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  borderRadius: '4px'
                }}>
                  <h3 style={{ 
                    fontSize: '12px', 
                    fontWeight: 600,
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>
                    ★ 선택된 종목 (지속 추적) 
                    <span style={{ 
                      marginLeft: '8px', 
                      color: theme === 'dark' ? '#f59e0b' : '#d97706', 
                      fontWeight: 'bold' 
                    }}>
                      {watchlistStocks.length}개
                    </span>
                  </h3>
                  <button
                    onClick={() => {
                      if (window.confirm('선택된 종목을 모두 삭제하시겠습니까?')) {
                        setWatchlistStocks([])
                        addLog('선택된 종목 전체 삭제', 'info')
                      }
                    }}
                    style={{
                      padding: '4px 8px',
                      backgroundColor: '#ef4444',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 500,
                      transition: 'background-color 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#dc2626'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#ef4444'
                    }}
                  >
                    전체 삭제
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ backgroundColor: theme === 'dark' ? '#374151' : '#e5e7eb' }}>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'left', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>종목명</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'left', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>추가시간</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'right', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>현재가</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'right', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>대비</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'right', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>등락%</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'right', 
                          fontWeight: 'normal', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>거래량</th>
                        <th style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '4px 8px', 
                          textAlign: 'center', 
                          fontWeight: 'normal', 
                          width: '80px', 
                          whiteSpace: 'nowrap',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>삭제</th>
                      </tr>
                    </thead>
                    <tbody>
                      {watchlistStocks.map((stock) => (
                        <tr 
                          key={stock.code}
                          style={{ 
                            backgroundColor: theme === 'dark' ? '#1f2937' : 'white',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : 'white'
                          }}
                        >
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px',
                            color: stock.changePercent > 0 
                              ? (theme === 'dark' ? '#f87171' : '#dc2626') 
                              : stock.changePercent < 0 
                              ? (theme === 'dark' ? '#60a5fa' : '#2563eb') 
                              : (theme === 'dark' ? '#f3f4f6' : '#000'),
                            fontWeight: 'bold',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '80px'
                          }}>
                            ★ {stock.name.length > 5 ? stock.name.substring(0, 5) + '...' : stock.name}
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'right', 
                            whiteSpace: 'nowrap',
                            color: theme === 'dark' ? '#d1d5db' : '#374151'
                          }}>{stock.price.toLocaleString()}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'right',
                            color: stock.change > 0 
                              ? (theme === 'dark' ? '#f87171' : '#dc2626') 
                              : stock.change < 0 
                              ? (theme === 'dark' ? '#60a5fa' : '#2563eb') 
                              : (theme === 'dark' ? '#d1d5db' : '#000'),
                            whiteSpace: 'nowrap'
                          }}>
                            {stock.change > 0 ? '+' : ''}{stock.change.toLocaleString()}
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'right',
                            color: stock.changePercent > 0 
                              ? (theme === 'dark' ? '#f87171' : '#dc2626') 
                              : stock.changePercent < 0 
                              ? (theme === 'dark' ? '#60a5fa' : '#2563eb') 
                              : (theme === 'dark' ? '#d1d5db' : '#000'),
                            whiteSpace: 'nowrap'
                          }}>
                            {stock.changePercent > 0 ? '+' : ''}{stock.changePercent.toFixed(2)}%
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'right', 
                            whiteSpace: 'nowrap',
                            color: theme === 'dark' ? '#d1d5db' : '#374151'
                          }}>{stock.volume.toLocaleString()}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px', 
                            textAlign: 'center', 
                            whiteSpace: 'nowrap'
                          }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setWatchlistStocks(prev => prev.filter(s => s.code !== stock.code))
                                addLog(`${stock.name} 선택된 종목에서 삭제됨`, 'info')
                              }}
                              style={{
                                padding: '2px 8px',
                                backgroundColor: '#ef4444',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 500,
                                transition: 'background-color 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = '#dc2626'
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = '#ef4444'
                              }}
                            >
                              삭제
                            </button>
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '4px 8px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                          }}>{stock.detectedTime}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 차트 영역 */}
            {selectedStockForChart && (
              <div 
                style={{
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white',
                  padding: '8px',
                  marginBottom: '8px',
                  borderRadius: '4px'
                }}
              >
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  marginBottom: '8px',
                  paddingBottom: '4px',
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #e5e7eb'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 style={{ 
                      fontSize: '13px', 
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#374151'
                    }}>
                      {selectedStockForChart.name} ({selectedStockForChart.code}) 차트
                    </h3>
                    <span style={{ 
                      fontSize: '11px', 
                      fontWeight: 'bold',
                      backgroundImage: selectedStockForChart.changePercent > 0 
                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                        : selectedStockForChart.changePercent < 0 
                        ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
                        : theme === 'dark'
                        ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                        : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      {selectedStockForChart.price.toLocaleString()}원 
                      ({selectedStockForChart.changePercent > 0 ? '+' : ''}{selectedStockForChart.changePercent.toFixed(2)}%)
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(['min', '5', '15', '30', '60', 'day'] as const).map((period) => (
                      <button
                        key={period}
                        onClick={() => setChartPeriod(period)}
                        style={{
                          padding: '2px 8px',
                          backgroundColor: chartPeriod === period 
                            ? '#3b82f6' 
                            : (theme === 'dark' ? '#374151' : '#e5e7eb'),
                          color: chartPeriod === period 
                            ? 'white' 
                            : (theme === 'dark' ? '#d1d5db' : '#374151'),
                          border: theme === 'dark' && chartPeriod !== period ? '1px solid #4b5563' : 'none',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          fontSize: '10px',
                          fontWeight: chartPeriod === period ? 'bold' : 'normal'
                        }}
                      >
                        {period === 'min' ? '1분' : period === 'day' ? '일봉' : `${period}분`}
                      </button>
                    ))}
                    <button
                      onClick={() => setSelectedStockForChart(null)}
                      style={{
                        padding: '2px 8px',
                        backgroundImage: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        marginLeft: '4px'
                      }}
                    >
                      닫기
                    </button>
                  </div>
                </div>
                <StockChart 
                  code={selectedStockForChart.code} 
                  period={chartPeriod}
                  isConnected={connected}
                  stockInfo={selectedStockForChart}
                  isSelected={true} // 선택된 종목이므로 true
                />
              </div>
            )}

            {/* 검색된 종목 리스트 */}
            <div 
              style={{
                height: '400px',
                borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                padding: '8px',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: theme === 'dark' ? '#111827' : 'transparent'
              }}
            >
              <div style={{ 
                marginBottom: '8px', 
                padding: '4px', 
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb', 
                borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                borderRadius: '8px',
                flexShrink: 0
              }}>
                <h3 style={{ 
                  fontSize: '12px', 
                  fontWeight: 600,
                  backgroundImage: theme === 'dark' 
                    ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                    : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ WebkitTextFillColor: theme === 'dark' ? '#f3f4f6' : '#111827', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  검색된 종목 ({detectedStocks.length}개) - 모두 표시 ([추가] 버튼으로 선택된 종목에 추가)
                </h3>
              </div>
              <div 
                ref={stocksScrollRef}
                style={{ 
                  overflowX: 'auto', 
                  overflowY: 'auto',
                  flex: '1 1 auto',
                  height: 0, // flexbox에서 높이 계산을 위해 필요
                  minHeight: 0 // flexbox 스크롤을 위한 필수 설정
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', lineHeight: '1.2', tableLayout: 'fixed' }}>
                  <thead>
                    <tr style={{ backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'left', 
                        fontWeight: 600,
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.name}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        종목명
                        <div
                          onMouseDown={(e) => handleResizeStart('name', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'name' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'name') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'name') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.price}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        현재가
                        <div
                          onMouseDown={(e) => handleResizeStart('price', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'price' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'price') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'price') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.change}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        대비
                        <div
                          onMouseDown={(e) => handleResizeStart('change', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'change' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'change') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'change') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.changePercent}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        등락%
                        <div
                          onMouseDown={(e) => handleResizeStart('changePercent', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'changePercent' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'changePercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'changePercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.openPercent}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        시가%
                        <div
                          onMouseDown={(e) => handleResizeStart('openPercent', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'openPercent' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'openPercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'openPercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.highPercent}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        고가%
                        <div
                          onMouseDown={(e) => handleResizeStart('highPercent', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'highPercent' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'highPercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'highPercent') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'right', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.volume}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        거래량
                        <div
                          onMouseDown={(e) => handleResizeStart('volume', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'volume' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'volume') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'volume') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'center', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.action}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        추가
                        <div
                          onMouseDown={(e) => handleResizeStart('action', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'action' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'action') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'action') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                      <th style={{ 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                        padding: '2px 6px', 
                        textAlign: 'left', 
                        fontWeight: 'normal',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        width: `${columnWidths.detectedTime}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        최초포착
                        <div
                          onMouseDown={(e) => handleResizeStart('detectedTime', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'detectedTime' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'detectedTime') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'detectedTime') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detectedStocks.length > 0 ? (
                      detectedStocks.map((stock) => {
                        const isInWatchlist = watchlistStocks.some(w => w.code === stock.code)
                        return (
                        <tr 
                          key={stock.code} 
                          onClick={(e) => {
                            // 버튼 클릭이 아닌 경우에만 차트 표시
                            if ((e.target as HTMLElement).tagName !== 'BUTTON') {
                              setSelectedStockForChart(stock)
                              // chartPeriod는 기본값(5분) 유지
                            }
                          }}
                          style={{ 
                            backgroundColor: theme === 'dark' 
                              ? (isInWatchlist ? '#78350f' : '#1f2937')
                              : (isInWatchlist ? '#fef3c7' : (stock.changePercent > 0 ? '#fef2f2' : stock.changePercent < 0 ? '#eff6ff' : 'white')),
                            border: isInWatchlist ? (theme === 'dark' ? '2px solid #f59e0b' : '2px solid #f59e0b') : 'none',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (!isInWatchlist) {
                              e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isInWatchlist) {
                              e.currentTarget.style.backgroundColor = theme === 'dark'
                                ? '#1f2937'
                                : (stock.changePercent > 0 ? '#fef2f2' : stock.changePercent < 0 ? '#eff6ff' : 'white')
                            }
                          }}
                        >
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px',
                            color: theme === 'dark' 
                              ? (stock.changePercent > 0 ? '#ff4444' : stock.changePercent < 0 ? '#60a5fa' : '#f3f4f6')
                              : (stock.changePercent > 0 ? '#dc2626' : stock.changePercent < 0 ? '#2563eb' : '#111827'),
                            fontSize: '13px',
                            fontWeight: isInWatchlist ? 'bold' : 'normal',
                            position: 'relative',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            width: `${columnWidths.name}px`,
                            lineHeight: '1.2'
                          }}>
                            {isInWatchlist && (
                              <span style={{ 
                                marginRight: '2px', 
                                color: '#f59e0b',
                                fontSize: '10px'
                              }}>★</span>
                            )}
                            {stock.name.length > 5 ? stock.name.substring(0, 5) + '...' : stock.name}
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' 
                              ? (stock.changePercent > 0 ? '#ff4444' : stock.changePercent < 0 ? '#60a5fa' : '#f3f4f6')
                              : (stock.changePercent > 0 ? '#dc2626' : stock.changePercent < 0 ? '#2563eb' : '#111827'),
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.price}px`
                          }}>{stock.price.toLocaleString()}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' 
                              ? (stock.change > 0 ? '#ff4444' : stock.change < 0 ? '#60a5fa' : '#f3f4f6')
                              : (stock.change > 0 ? '#dc2626' : stock.change < 0 ? '#2563eb' : '#111827'),
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.change}px`
                          }}>
                            {stock.change > 0 ? '+' : ''}{stock.change.toLocaleString()}
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' 
                              ? (stock.changePercent > 0 ? '#ff4444' : stock.changePercent < 0 ? '#60a5fa' : '#f3f4f6')
                              : (stock.changePercent > 0 ? '#dc2626' : stock.changePercent < 0 ? '#2563eb' : '#111827'),
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.changePercent}px`
                          }}>
                            {stock.changePercent > 0 ? '+' : ''}{stock.changePercent.toFixed(2)}%
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' ? '#ff4444' : '#111827',
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.openPercent}px`
                          }}>-</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' ? '#ff4444' : '#111827',
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.highPercent}px`
                          }}>-</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' ? '#ffffff' : '#111827',
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.volume}px`
                          }}>{stock.volume.toLocaleString()}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'center', 
                            lineHeight: '1.2',
                            width: `${columnWidths.action}px`
                          }}>
                            {isInWatchlist ? (
                              <span style={{ color: '#f59e0b', fontSize: '10px', fontWeight: 'bold' }}>★</span>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setWatchlistStocks(prev => [...prev, stock])
                                  addLog(`${stock.name} 선택된 종목에 추가됨`, 'success')
                                }}
                                style={{
                                  padding: '1px 4px',
                                  backgroundImage: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '8px',
                                  cursor: 'pointer',
                                  fontSize: '9px',
                                  fontWeight: 500,
                                  lineHeight: '1.2'
                                }}
                              >
                                추가
                              </button>
                            )}
                          </td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            lineHeight: '1.2',
                            fontSize: '13px',
                            color: theme === 'dark' ? '#ffffff' : '#111827',
                            width: `${columnWidths.detectedTime}px`
                          }}>{stock.detectedTime}</td>
                        </tr>
                      )
                      })
                    ) : (
                      <tr>
                        <td colSpan={9} style={{ 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                          padding: '32px', 
                          textAlign: 'center',
                          backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                            : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                        }}>
                          검색된 종목이 없습니다
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'conditions' && (
          <div 
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px',
              backgroundColor: theme === 'dark' ? '#111827' : '#f0f0f0'
            }}
          >
            <div style={{ maxWidth: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* 조건검색식 - 매수후보 탐색 (웹 기반 자체 조건식) */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '8px',
                borderRadius: '8px'
              }}>
                <h4 style={{ 
                  fontSize: '12px', 
                  fontWeight: 'bold', 
                  marginBottom: '6px', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                  paddingBottom: '4px',
                  backgroundImage: theme === 'dark' ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>
                  조건검색식 - 매수후보 탐색 <span style={{ fontSize: '10px', color: theme === 'dark' ? '#9ca3af' : '#6b7280', fontWeight: 'normal' }}>(웹 기반)</span>
                </h4>
                {conditions.length > 0 ? (
                  <div style={{ marginBottom: '8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                    {conditions.map((condition) => (
                      <label 
                        key={condition.id} 
                        style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '6px',
                          padding: '6px 8px',
                          border: '1px solid',
                          borderColor: condition.enabled 
                            ? (theme === 'dark' ? '#22c55e' : '#22c55e')
                            : (theme === 'dark' ? '#4b5563' : '#e5e7eb'),
                          borderRadius: '8px',
                          backgroundColor: condition.enabled 
                            ? (theme === 'dark' ? '#064e3b' : '#f0fdf4')
                            : (theme === 'dark' ? '#374151' : 'white'),
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          fontSize: '13px',
                          fontWeight: condition.enabled ? '600' : '400'
                        }}
                        onClick={(e) => {
                          if (e.target === e.currentTarget || (e.target as HTMLElement).tagName !== 'INPUT') {
                            toggleCondition(condition.id)
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={condition.enabled}
                          onChange={() => toggleCondition(condition.id)}
                          disabled={isRunning}
                          style={{ 
                            width: '18px', 
                            height: '18px',
                            cursor: 'pointer',
                            flexShrink: 0,
                            borderRadius: '4px'
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ 
                            fontSize: '13px', 
                            marginBottom: '2px', 
                            lineHeight: '1.3',
                            background: theme === 'dark' 
                              ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                              : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827'
                          }}>{condition.name}</div>
                          <div style={{ 
                            fontSize: '11px', 
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280', 
                            fontWeight: 'normal', 
                            lineHeight: '1.2' 
                          }}>{condition.description}</div>
                        </div>
                        {condition.enabled && (
                          <div style={{ 
                            padding: '2px 6px', 
                            backgroundColor: '#22c55e', 
                            color: 'white', 
                            borderRadius: '3px',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            flexShrink: 0,
                            whiteSpace: 'nowrap'
                          }}>
                            선택됨
                          </div>
                        )}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div style={{ 
                    padding: '12px', 
                    textAlign: 'center', 
                    color: theme === 'dark' ? '#9ca3af' : '#6b7280', 
                    fontSize: '11px' 
                  }}>
                    조건식을 불러오는 중...
                  </div>
                )}
                
                {/* 조건식 검색 버튼 */}
                <div style={{ marginTop: '8px', display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={async () => {
                      const enabledConditions = conditions.filter(c => c.enabled)
                      if (enabledConditions.length === 0) {
                        return
                      }
                      
                      try {
                        addLog('조건식 검색 시작...', 'info')
                        const result = await kiwoomApi.searchCondition(conditions)
                        
                        if (result.success && result.stocks && result.stocks.length > 0) {
                          const newStocks: DetectedStock[] = result.stocks.map((stock: any) => ({
                            code: stock.code,
                            name: stock.name,
                            price: stock.price,
                            change: stock.price * (stock.changeRate / 100),
                            changePercent: stock.changeRate,
                            volume: stock.volume,
                            detectedCondition: result.appliedConditions.join(', '),
                            detectedTime: new Date().toLocaleTimeString(),
                          }))
                          
                          setDetectedStocks(newStocks)
                          
                          // 선택된 종목도 업데이트
                          if (watchlistStocks.length > 0) {
                            const updatedWatchlist = watchlistStocks.map(watchStock => {
                              const foundStock = newStocks.find(s => s.code === watchStock.code)
                              if (foundStock) {
                                return {
                                  ...foundStock,
                                  detectedTime: watchStock.detectedTime
                                }
                              }
                              return watchStock
                            })
                            setWatchlistStocks(updatedWatchlist)
                          }
                          
                          addLog(`${result.stocks.length}개 종목 검색 완료`, 'success')
                        } else {
                          addLog('검색된 종목이 없습니다', 'warning')
                        }
                      } catch (error: any) {
                        addLog(`조건식 검색 실패: ${error.message}`, 'error')
                      }
                    }}
                    disabled={conditions.filter(c => c.enabled).length === 0}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: conditions.filter(c => c.enabled).length === 0 
                        ? (theme === 'dark' ? '#4b5563' : '#9ca3af')
                        : '#2563eb',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: conditions.filter(c => c.enabled).length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
                      fontWeight: 500
                    }}
                  >
                    조건식 검색
                  </button>
                  <button
                    onClick={() => {
                      setConditions(conditions.map(c => ({ ...c, enabled: false })))
                      setDetectedStocks([])
                      addLog('조건식 초기화', 'info')
                    }}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: theme === 'dark' ? '#4b5563' : '#6b7280',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 500
                    }}
                  >
                    초기화
                  </button>
                </div>
                
                <div style={{ 
                  fontSize: '10px', 
                  color: theme === 'dark' ? '#9ca3af' : '#666', 
                  lineHeight: '1.4', 
                  marginTop: '8px' 
                }}>
                  <div>✓ 체크한 조건식에 맞는 종목만 검색됩니다</div>
                  <div>✓ 여러 조건식을 동시에 선택할 수 있습니다</div>
                  <div>✓ 검색 결과는 "주문시작" 탭의 "검색된 종목"에 표시됩니다</div>
                </div>
              </div>

              {/* 사용자수식 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '8px',
                borderRadius: '8px'
              }}>
                <h4 style={{ 
                  fontSize: '12px', 
                  fontWeight: 'bold', 
                  marginBottom: '8px', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                  paddingBottom: '4px',
                  backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>
                  사용자수식
                </h4>
                
                {/* 매수조건 체크박스 */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ 
                    fontSize: '11px', 
                    fontWeight: 500, 
                    marginBottom: '6px', 
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#374151'
                  }}>
                    매수조건:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={buyFormula1}
                        onChange={(e) => {
                          setBuyFormula1(e.target.checked)
                          if (e.target.checked && buyFormula2) {
                            setBuyFormula2(false) // 하나만 선택 가능
                          }
                        }}
                        style={{ width: '14px', height: '14px', cursor: 'pointer', borderRadius: '3px' }}
                      />
                      <span style={{
                        backgroundImage: buyFormula1 
                          ? 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)'
                          : (theme === 'dark' 
                            ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                            : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)'),
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                      }}>My 매수수식 1 (기본 매수 조건: MA5/MA20 상승, 연속상승봉)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={buyFormula2}
                        onChange={(e) => {
                          setBuyFormula2(e.target.checked)
                          if (e.target.checked && buyFormula1) {
                            setBuyFormula1(false) // 하나만 선택 가능
                          }
                        }}
                        style={{ width: '14px', height: '14px', cursor: 'pointer', borderRadius: '3px' }}
                      />
                      <span style={{
                        backgroundImage: buyFormula2 
                          ? 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)'
                          : (theme === 'dark' 
                            ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                            : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)'),
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                      }}>My 매수수식 2 (고급 매수 조건: 장시작급등주, 볼린저밴드, 스캘핑, 돌파매수, 장마감종가배팅)</span>
                    </label>
                  </div>
                </div>

                {/* 매도조건 체크박스 */}
                <div style={{ marginBottom: '8px' }}>
                  <div style={{ 
                    fontSize: '11px', 
                    fontWeight: 500, 
                    marginBottom: '6px',
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#374151'
                  }}>
                    매도조건:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={sellFormula1}
                        onChange={(e) => {
                          setSellFormula1(e.target.checked)
                          if (e.target.checked && sellFormula2) {
                            setSellFormula2(false) // 하나만 선택 가능
                          }
                        }}
                        style={{ width: '14px', height: '14px', cursor: 'pointer', borderRadius: '3px' }}
                      />
                      <span style={{
                        backgroundImage: sellFormula1 
                          ? 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)'
                          : (theme === 'dark' 
                            ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                            : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)'),
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                      }}>My 매도수식 1 (익절/손절/트레일링 스탑 조건)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={sellFormula2}
                        onChange={(e) => {
                          setSellFormula2(e.target.checked)
                          if (e.target.checked && sellFormula1) {
                            setSellFormula1(false) // 하나만 선택 가능
                          }
                        }}
                        style={{ width: '14px', height: '14px', cursor: 'pointer', borderRadius: '3px' }}
                      />
                      <span style={{
                        backgroundImage: sellFormula2 
                          ? 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)'
                          : (theme === 'dark' 
                            ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                            : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)'),
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                      }}>My 매도수식 2 (트레일링 매도 조건)</span>
                    </label>
                  </div>
                </div>
              </div>
              

              {/* 매매조건 입력 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '8px',
                borderRadius: '8px'
              }}>
                <div style={{ 
                  backgroundImage: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: 'white', 
                  padding: '3px 6px', 
                  marginBottom: '6px', 
                  fontSize: '12px', 
                  fontWeight: 'bold',
                  borderRadius: '6px'
                }}>
                  종목당 매수금액 설정
                </div>
                <table style={{ width: '100%', fontSize: '11px' }}>
                  <tbody>
                    <tr>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right', 
                        width: '40%', 
                        verticalAlign: 'middle',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>종목당 매수금액</td>
                      <td style={{ padding: '2px 4px', position: 'relative' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                          <input
                            type="number"
                            value={amountPerStock}
                            onChange={(e) => {
                              const value = Number(e.target.value)
                              if (value >= 10000 && value <= 100000000) {
                                setAmountPerStock(value)
                              } else if (value < 10000) {
                                setAmountPerStock(10000)
                              } else if (value > 100000000) {
                                setAmountPerStock(100000000)
                              }
                            }}
                            onBlur={(e) => {
                              const value = Number(e.target.value)
                              if (value < 10000) {
                                setAmountPerStock(10000)
                              } else if (value > 100000000) {
                                setAmountPerStock(100000000)
                              }
                            }}
                            min={10000}
                            max={100000000}
                            step={10000}
                            style={{ 
                              flex: 1, 
                              padding: '2px 4px', 
                              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                              backgroundColor: theme === 'dark' ? '#374151' : 'white',
                              color: theme === 'dark' ? '#f3f4f6' : '#111827',
                              textAlign: 'right', 
                              fontSize: '11px',
                              borderRadius: '8px'
                            }}
                            placeholder="10000원 이상"
                          />
                          <span style={{ 
                            fontSize: '10px', 
                            color: theme === 'dark' ? '#9ca3af' : '#666', 
                            whiteSpace: 'nowrap' 
                          }}>원</span>
                        </div>
                        <div style={{ 
                          fontSize: '9px', 
                          color: theme === 'dark' ? '#9ca3af' : '#999', 
                          marginBottom: '4px', 
                          textAlign: 'right' 
                        }}>
                          현재: {amountPerStock.toLocaleString()}원 (최소: 10,000원, 최대: 100,000,000원)
                        </div>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                          {[100000, 500000, 1000000, 2000000, 5000000].map((amount) => (
                            <button
                              key={amount}
                              onClick={() => {
                                setAmountPerStock(amount)
                              }}
                              style={{
                                padding: '2px 6px',
                                backgroundColor: amountPerStock === amount 
                                  ? '#3b82f6'
                                  : (theme === 'dark' ? '#374151' : '#e5e7eb'),
                                color: amountPerStock === amount ? 'white' : (theme === 'dark' ? '#f3f4f6' : '#374151'),
                                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: '9px',
                                fontWeight: amountPerStock === amount ? 'bold' : 'normal',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                if (amountPerStock !== amount) {
                                  e.currentTarget.style.backgroundColor = theme === 'dark' ? '#4b5563' : '#d1d5db'
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (amountPerStock !== amount) {
                                  e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#e5e7eb'
                                }
                              }}
                            >
                              {amount >= 1000000 ? `${amount / 1000000}백만원` : `${amount / 10000}만원`}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right', 
                        width: '20%', 
                        fontSize: '10px', 
                        verticalAlign: 'middle',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>설정</td>
                    </tr>
                    <tr>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>최대 동시매수종목수</td>
                      <td style={{ padding: '2px 4px' }}>
                        <input
                          type="number"
                          value={maxSimultaneousBuy}
                          onChange={(e) => setMaxSimultaneousBuy(Number(e.target.value))}
                          style={{ 
                            width: '100%', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right', 
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '2px 4px' }}></td>
                    </tr>
                    <tr>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>종목당 매매허용횟수</td>
                      <td style={{ padding: '2px 4px' }}>
                        <input
                          type="number"
                          value={tradeLimitPerStock}
                          onChange={(e) => setTradeLimitPerStock(Number(e.target.value))}
                          style={{ 
                            width: '100%', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right', 
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '2px 4px' }}></td>
                    </tr>
                    <tr>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>당일 최대매매종목수</td>
                      <td style={{ padding: '2px 4px' }}>
                        <input
                          type="number"
                          value={maxDailyStocks}
                          onChange={(e) => setMaxDailyStocks(Number(e.target.value))}
                          style={{ 
                            width: '100%', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right', 
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '2px 4px' }}></td>
                    </tr>
                    <tr>
                      <td style={{ 
                        padding: '2px 4px', 
                        textAlign: 'right',
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>수수료 및 세금%</td>
                      <td style={{ padding: '2px 4px' }}>
                        <input
                          type="number"
                          step="0.01"
                          value={feePercent}
                          onChange={(e) => setFeePercent(Number(e.target.value))}
                          style={{ 
                            width: '100%', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right', 
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '2px 4px' }}></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* 매매시간 설정 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '8px',
                borderRadius: '8px'
              }}>
                <h4 style={{ 
                  fontSize: '12px', 
                  fontWeight: 'bold', 
                  marginBottom: '6px', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                  paddingBottom: '4px',
                  backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>매매시간 설정</h4>
                <div style={{ marginBottom: '6px', fontSize: '11px', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>시작:</span>
                  <input
                    type="number"
                    value={startHour}
                    onChange={(e) => setStartHour(Number(e.target.value))}
                    style={{ 
                      width: '35px', 
                      padding: '2px 3px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center', 
                      fontSize: '11px',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>시</span>
                  <input
                    type="number"
                    value={startMinute}
                    onChange={(e) => setStartMinute(Number(e.target.value))}
                    style={{ 
                      width: '35px', 
                      padding: '2px 3px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center', 
                      fontSize: '11px',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>분</span>
                  <span style={{ 
                    marginLeft: '4px',
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>~ 종료:</span>
                  <input
                    type="number"
                    value={endHour}
                    onChange={(e) => setEndHour(Number(e.target.value))}
                    style={{ 
                      width: '35px', 
                      padding: '2px 3px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center', 
                      fontSize: '11px',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>시</span>
                  <input
                    type="number"
                    value={endMinute}
                    onChange={(e) => setEndMinute(Number(e.target.value))}
                    style={{ 
                      width: '35px', 
                      padding: '2px 3px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center', 
                      fontSize: '11px',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>분</span>
                  <input
                    type="number"
                    value={endSecond}
                    onChange={(e) => setEndSecond(Number(e.target.value))}
                    style={{ 
                      width: '35px', 
                      padding: '2px 3px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center', 
                      fontSize: '11px',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>초 전</span>
                </div>
                <div style={{ marginBottom: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                    <input
                      type="checkbox"
                      checked={dropSellTime}
                      onChange={(e) => setDropSellTime(e.target.checked)}
                      style={{ width: '16px', height: '16px', borderRadius: '3px' }}
                    />
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>옵토시간 드랍시 보유종목 지정판도</span>
                  </label>
                </div>
                <div style={{ fontSize: '12px', marginLeft: '24px' }}>
                  <input
                    type="number"
                    value={dropSellStartHour}
                    onChange={(e) => setDropSellStartHour(Number(e.target.value))}
                    style={{ 
                      width: '40px', 
                      padding: '2px 4px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}> 시 </span>
                  <input
                    type="number"
                    value={dropSellStartMinute}
                    onChange={(e) => setDropSellStartMinute(Number(e.target.value))}
                    style={{ 
                      width: '40px', 
                      padding: '2px 4px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}> 분 ~ </span>
                  <input
                    type="number"
                    value={dropSellEndSecond}
                    onChange={(e) => setDropSellEndSecond(Number(e.target.value))}
                    style={{ 
                      width: '40px', 
                      padding: '2px 4px', 
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'center',
                      borderRadius: '8px'
                    }}
                  />
                  <span style={{
                    background: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}> 초 전</span>
                </div>
              </div>

              {/* 매수/매도 가격지정 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '12px',
                borderRadius: '8px'
              }}>
                <h4 style={{ 
                  fontSize: '13px', 
                  fontWeight: 'bold', 
                  marginBottom: '12px', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                  paddingBottom: '8px',
                  backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>매수/매도 가격지정</h4>
                <div style={{ marginBottom: '12px' }}>
                  <h5 style={{ 
                    fontSize: '12px', 
                    fontWeight: 'bold', 
                    marginBottom: '8px',
                    backgroundImage: theme === 'dark' 
                      ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                      : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827'
                  }}>종목별 매도손익률 설정</h5>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '8px' }}>
                    <input type="checkbox" defaultChecked style={{ borderRadius: '3px' }} />
                    <span style={{
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>실질</span>
                  </label>
                </div>
                <div style={{ marginBottom: '12px', fontSize: '12px' }}>
                  <div style={{ marginBottom: '8px' }}>
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>익절 목표수익률: </span>
                    <input
                      type="number"
                      step="0.1"
                      value={profitTarget}
                      onChange={(e) => setProfitTarget(Number(e.target.value))}
                      style={{ 
                        width: '60px', 
                        padding: '2px 4px', 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        textAlign: 'right',
                        borderRadius: '8px'
                      }}
                    />
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}> % 이상일때 익절</span>
                  </div>
                  <div style={{ marginLeft: '24px' }}>
                    <label style={{ marginRight: '16px' }}>
                      <input
                        type="radio"
                        name="profitType"
                        checked={profitType === 'market'}
                        onChange={() => setProfitType('market')}
                        style={{ borderRadius: '50%' }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> 시장가</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="profitType"
                        checked={profitType === 'limit'}
                        onChange={() => setProfitType('limit')}
                        style={{ borderRadius: '50%' }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> 지정가</span>
                    </label>
                  </div>
                </div>
                <div style={{ fontSize: '12px' }}>
                  <div style={{ marginBottom: '8px' }}>
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>손절 기준손실률: </span>
                    <input
                      type="number"
                      step="0.1"
                      value={lossLimit}
                      onChange={(e) => setLossLimit(Number(e.target.value))}
                      style={{ 
                        width: '60px', 
                        padding: '2px 4px', 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        textAlign: 'right',
                        borderRadius: '8px'
                      }}
                    />
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}> % 이상일때 손절</span>
                  </div>
                  <div style={{ marginLeft: '24px', marginBottom: '8px' }}>
                    <label style={{ marginRight: '16px' }}>
                      <input
                        type="radio"
                        name="lossType"
                        checked={lossType === 'market'}
                        onChange={() => setLossType('market')}
                        style={{ borderRadius: '50%' }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> 시장가</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="lossType"
                        checked={lossType === 'limit'}
                        onChange={() => setLossType('limit')}
                        style={{ borderRadius: '50%' }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> 지정가</span>
                    </label>
                    <span style={{
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}> 매도호가 (-10 {'<'} 0 {'<'} +10) </span>
                    <input
                      type="number"
                      value={lossPriceOffset}
                      onChange={(e) => setLossPriceOffset(Number(e.target.value))}
                      style={{ 
                        width: '50px', 
                        padding: '2px 4px', 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        textAlign: 'center',
                        borderRadius: '8px'
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 기타조건 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '12px',
                borderRadius: '8px'
              }}>
                <h4 style={{ 
                  fontSize: '13px', 
                  fontWeight: 'bold', 
                  marginBottom: '12px', 
                  borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                  paddingBottom: '8px',
                  backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>기타조건</h4>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                    <input
                      type="checkbox"
                      checked={autoStart}
                      onChange={(e) => setAutoStart(e.target.checked)}
                      style={{ borderRadius: '3px' }}
                    />
                    <span style={{
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>프로그램실행시 자동시작</span>
                  </label>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={trailingStop}
                      onChange={(e) => setTrailingStop(e.target.checked)}
                      style={{ borderRadius: '3px' }}
                    />
                    <span style={{
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>Trailing 매도조건 설정</span>
                  </label>
                  <div style={{ marginLeft: '24px', fontSize: '12px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <input type="checkbox" defaultChecked style={{ borderRadius: '3px' }} />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>실행</span>
                    </label>
                    <div>
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>매도감시 기준 수익률이 </span>
                      <input
                        type="number"
                        step="0.1"
                        value={trailingProfitThreshold}
                        onChange={(e) => setTrailingProfitThreshold(Number(e.target.value))}
                        style={{ 
                          width: '50px', 
                          padding: '2px 4px', 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                          backgroundColor: theme === 'dark' ? '#374151' : 'white',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          textAlign: 'right',
                          borderRadius: '8px'
                        }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> % 이상인 종목이 최고 수익률 대비 </span>
                      <input
                        type="number"
                        step="0.1"
                        value={trailingDropThreshold}
                        onChange={(e) => setTrailingDropThreshold(Number(e.target.value))}
                        style={{ 
                          width: '50px', 
                          padding: '2px 4px', 
                          border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                          backgroundColor: theme === 'dark' ? '#374151' : 'white',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          textAlign: 'right',
                          borderRadius: '8px'
                        }}
                      />
                      <span style={{
                        backgroundImage: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}> % 하락시 매도</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {activeTab === 'strategies' && (
          <div 
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '5px',
              backgroundColor: theme === 'dark' ? '#111827' : '#f0f0f0'
            }}
          >
            <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* 장마감급등주매수 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyMarketClose ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyMarketClose}
                      onChange={(e) => setStrategyMarketClose(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      장마감급등주매수
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '거래량증가율기준', value: 100000.00, unit: '%' },
                      { label: '최소거래대금', value: 10, unit: '억' },
                      { label: '변동성상한', value: 0.50, unit: '%' },
                      { label: '전체등록종기준', value: 2.00, unit: '%' },
                      { label: '매수가격조정비율', value: 1.00, unit: '%' },
                      { label: '시작시간_시', value: 15.00, unit: '시' },
                      { label: '시작시간_분', value: 10.00, unit: '분' },
                      { label: '종료시간_시', value: 15.00, unit: '시' },
                      { label: '종료시간_분', value: 20.00, unit: '분' },
                    ].map((item, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 140px', 
                          whiteSpace: 'nowrap',
                          background: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={item.value}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          background: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 기본매수설정 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyBasicBuy ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyBasicBuy}
                      onChange={(e) => setStrategyBasicBuy(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      기본매수설정
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '거래량증가율기준', value: basicBuy.volumeIncreaseRate, key: 'volumeIncreaseRate', unit: '%' },
                      { label: '최소거래대금', value: basicBuy.minTradingAmount, key: 'minTradingAmount', unit: '억' },
                      { label: '최소등락률', value: basicBuy.minFluctuation, key: 'minFluctuation', unit: '%' },
                      { label: '최대등락률', value: basicBuy.maxFluctuation, key: 'maxFluctuation', unit: '%' },
                      { label: '연속상승횟수', value: basicBuy.consecutiveRises, key: 'consecutiveRises', unit: '개' },
                      { label: 'RSI하한', value: basicBuy.rsiLower, key: 'rsiLower', unit: '' },
                      { label: 'RSI상한', value: basicBuy.rsiUpper, key: 'rsiUpper', unit: '' },
                      { label: '매수가격조정비율', value: basicBuy.buyPriceAdjustment, key: 'buyPriceAdjustment', unit: '%' },
                      { label: '최소거래량', value: basicBuy.minVolume, key: 'minVolume', unit: '주' },
                      { label: '기관순매수량기준', value: basicBuy.institutionBuy, key: 'institutionBuy', unit: '주' },
                      { label: '외국인순매수량기준', value: basicBuy.foreignBuy, key: 'foreignBuy', unit: '주' },
                    ].map((item) => (
                      <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 140px', 
                          whiteSpace: 'nowrap',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.value}
                          onChange={(e) => setBasicBuy({...basicBuy, [item.key]: Number(e.target.value)})}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>


              {/* 스캘핑매수 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyScalping ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyScalping}
                      onChange={(e) => setStrategyScalping(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      스캘핑매수
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '최소거래대금', value: scalpingBuy.minTradingAmount, key: 'minTradingAmount', unit: '억' },
                      { label: '거래량급증기준', value: scalpingBuy.volumeIncreaseRate, key: 'volumeIncreaseRate', unit: '%' },
                      { label: '하단밴드이탈률', value: scalpingBuy.lowerBandDeviation, key: 'lowerBandDeviation', unit: '%' },
                      { label: '저점후거래량증가기준', value: scalpingBuy.volumeIncreaseAfterLow, key: 'volumeIncreaseAfterLow', unit: '배' },
                      { label: 'RSI하한', value: scalpingBuy.rsiLower, key: 'rsiLower', unit: '' },
                      { label: 'RSI상한', value: scalpingBuy.rsiUpper, key: 'rsiUpper', unit: '' },
                      { label: '최소가격상승률', value: scalpingBuy.minPriceRise, key: 'minPriceRise', unit: '%' },
                      { label: '풀백깊이최소', value: scalpingBuy.pullbackDepthMin, key: 'pullbackDepthMin', unit: '%' },
                      { label: '풀백깊이최대', value: scalpingBuy.pullbackDepthMax, key: 'pullbackDepthMax', unit: '%' },
                      { label: '저점이후최소상승률', value: scalpingBuy.minRiseAfterLow, key: 'minRiseAfterLow', unit: '%' },
                      { label: '저점이후최소상승봉개수', value: scalpingBuy.minRiseCandles, key: 'minRiseCandles', unit: '개' },
                    ].map((item) => (
                      <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 140px', 
                          whiteSpace: 'nowrap',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.value}
                          onChange={(e) => setScalpingBuy({...scalpingBuy, [item.key]: Number(e.target.value)})}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 돌파매수 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyBreakout ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyBreakout}
                      onChange={(e) => setStrategyBreakout(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      돌파매수
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '거래량증가율기준', value: breakoutBuy.volumeIncreaseRate, key: 'volumeIncreaseRate', unit: '%' },
                      { label: '거래량1분증가율계수', value: breakoutBuy.volume1MinCoeff, key: 'volume1MinCoeff', unit: '배' },
                      { label: '거래량3분증가율계수', value: breakoutBuy.volume3MinCoeff, key: 'volume3MinCoeff', unit: '배' },
                      { label: '거래량5분증가율계수', value: breakoutBuy.volume5MinCoeff, key: 'volume5MinCoeff', unit: '배' },
                      { label: '최소거래대금', value: breakoutBuy.minTradingAmount, key: 'minTradingAmount', unit: '억' },
                      { label: '이전고점대비상승률', value: breakoutBuy.prevHighRiseRate, key: 'prevHighRiseRate', unit: '%' },
                      { label: '이전고점대비상승률완화계수', value: breakoutBuy.prevHighRiseRelaxCoeff, key: 'prevHighRiseRelaxCoeff', unit: '배' },
                      { label: '최소단기상승률', value: breakoutBuy.minShortRise, key: 'minShortRise', unit: '%' },
                      { label: '최소3분상승률', value: breakoutBuy.min3MinRise, key: 'min3MinRise', unit: '%' },
                      { label: '최소등락률', value: breakoutBuy.minFluctuation, key: 'minFluctuation', unit: '%' },
                      { label: '최대등락률', value: breakoutBuy.maxFluctuation, key: 'maxFluctuation', unit: '%' },
                      { label: '최소등락률완화계수', value: breakoutBuy.minFluctuationRelaxCoeff, key: 'minFluctuationRelaxCoeff', unit: '배' },
                      { label: '최대등락률확장계수', value: breakoutBuy.maxFluctuationExpandCoeff, key: 'maxFluctuationExpandCoeff', unit: '배' },
                      { label: 'RSI하한', value: breakoutBuy.rsiLower, key: 'rsiLower', unit: '' },
                      { label: 'RSI하한완화계수', value: breakoutBuy.rsiLowerRelaxCoeff, key: 'rsiLowerRelaxCoeff', unit: '배' },
                    ].map((item) => (
                      <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 180px', 
                          whiteSpace: 'nowrap',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.value}
                          onChange={(e) => setBreakoutBuy({...breakoutBuy, [item.key]: Number(e.target.value)})}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 장시작급등주매수 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyMarketOpen ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyMarketOpen}
                      onChange={(e) => setStrategyMarketOpen(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      장시작급등주매수
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '거래량증가율기준', value: marketOpenBuy.volumeIncreaseRate, key: 'volumeIncreaseRate', unit: '%' },
                      { label: '최소거래대금', value: marketOpenBuy.minTradingAmount, key: 'minTradingAmount', unit: '억' },
                      { label: '최소등락률', value: marketOpenBuy.minFluctuation, key: 'minFluctuation', unit: '%' },
                      { label: '매수가격조정비율', value: marketOpenBuy.buyPriceAdjustment, key: 'buyPriceAdjustment', unit: '%' },
                      { label: '고가대비하락율제한', value: marketOpenBuy.highDropLimit, key: 'highDropLimit', unit: '%' },
                      { label: '시작시간_시', value: marketOpenBuy.startHour, key: 'startHour', unit: '시' },
                      { label: '시작시간_분', value: marketOpenBuy.startMinute, key: 'startMinute', unit: '분' },
                      { label: '종료시간_시', value: marketOpenBuy.endHour, key: 'endHour', unit: '시' },
                      { label: '종료시간_분', value: marketOpenBuy.endMinute, key: 'endMinute', unit: '분' },
                      { label: '최소연속상승횟수', value: marketOpenBuy.minConsecutiveRises, key: 'minConsecutiveRises', unit: '개' },
                      { label: '거래량증가배터치수비율', value: marketOpenBuy.volumeRatioLimit, key: 'volumeRatioLimit', unit: '%' },
                      { label: '현재종최소상승률', value: marketOpenBuy.currentMinRise, key: 'currentMinRise', unit: '%' },
                      { label: '전종최소상승률', value: marketOpenBuy.prevMinRise, key: 'prevMinRise', unit: '%' },
                      { label: '최소양봉비율', value: marketOpenBuy.minBullishRatio, key: 'minBullishRatio', unit: '%' },
                      { label: 'RSI하한', value: marketOpenBuy.rsiLower, key: 'rsiLower', unit: '' },
                      { label: 'RSI상한', value: marketOpenBuy.rsiUpper, key: 'rsiUpper', unit: '' },
                      { label: '이동평균정배열필수', value: marketOpenBuy.movingAvgRequired, key: 'movingAvgRequired', unit: '' },
                    ].map((item) => (
                      <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 140px', 
                          whiteSpace: 'nowrap',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.value}
                          onChange={(e) => setMarketOpenBuy({...marketOpenBuy, [item.key]: Number(e.target.value)})}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 볼린저밴드매수 */}
                <div style={{ 
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                  backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                  padding: '12px', 
                  opacity: strategyBollinger ? 1 : 0.5,
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={strategyBollinger}
                      onChange={(e) => setStrategyBollinger(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <h4 style={{ 
                      fontSize: '13px', 
                      fontWeight: 'bold', 
                      margin: 0, 
                      backgroundColor: theme === 'dark' ? '#374151' : '#f0f0f0', 
                      padding: '8px', 
                      flex: 1,
                      borderRadius: '6px',
                      backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      볼린저밴드매수
                    </h4>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {[
                      { label: '단기이동평균기간', value: bollingerBuy.shortTermPeriod, key: 'shortTermPeriod', unit: '일' },
                      { label: '중기이동평균기간', value: bollingerBuy.midTermPeriod, key: 'midTermPeriod', unit: '일' },
                      { label: '볼린저밴드기간', value: bollingerBuy.bollingerPeriod, key: 'bollingerPeriod', unit: '일' },
                      { label: '볼린저밴드배수', value: bollingerBuy.bollingerMultiplier, key: 'bollingerMultiplier', unit: '배' },
                      { label: '이동평균기간', value: bollingerBuy.movingAvgPeriod, key: 'movingAvgPeriod', unit: '일' },
                      { label: '시가고가반등제한', value: bollingerBuy.openHighBounceLimit, key: 'openHighBounceLimit', unit: '%' },
                      { label: '시가고가반등제한사용', value: bollingerBuy.openHighBounceLimitUse, key: 'openHighBounceLimitUse', unit: '' },
                      { label: '이동평균정배열필수', value: bollingerBuy.movingAvgRequired, key: 'movingAvgRequired', unit: '' },
                      { label: '손간거래량증가율', value: bollingerBuy.instantVolumeIncrease, key: 'instantVolumeIncrease', unit: '%' },
                      { label: '손간거래량증가지수사용', value: bollingerBuy.instantVolumeUse, key: 'instantVolumeUse', unit: '' },
                      { label: '거래량비교횟수', value: bollingerBuy.volumeCompareCount, key: 'volumeCompareCount', unit: '개' },
                    ].map((item) => (
                      <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ 
                          flex: '0 0 160px', 
                          whiteSpace: 'nowrap',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.label}:</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.value}
                          onChange={(e) => setBollingerBuy({...bollingerBuy, [item.key]: Number(e.target.value)})}
                          style={{ 
                            width: '100px', 
                            padding: '2px 4px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ccc',
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'right',
                            fontSize: '11px',
                            borderRadius: '8px'
                          }}
                        />
                        <span style={{ 
                          width: '30px',
                          backgroundImage: theme === 'dark' 
                            ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                            : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827'
                        }}>{item.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>
            </div>
          </div>
        )}
      </div>

      {/* 하단 로그 영역 */}
      {showLogSection && (
        <div 
          style={{
            height: '128px',
            backgroundColor: '#111827',
            color: '#4ade80',
            borderTop: '2px solid #374151',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0
          }}
        >
          <div 
            onClick={() => setShowLogSection(false)}
            style={{
              padding: '5px',
              backgroundColor: '#1f2937',
              borderBottom: '1px solid #374151',
              width: '100%',
              display: 'flex',
              flexFlow: 'row',
              borderRadius: '9999px',
              cursor: 'pointer',
              userSelect: 'none'
            }}
          >
            <span style={{ 
              fontSize: '14px', 
              fontWeight: 500,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              fontFamily: '"Segoe UI Emoji"',
              textAlign: 'center',
              paddingLeft: '20px',
              paddingRight: '20px',
              marginLeft: '20px',
              marginRight: '20px'
            }}>로그</span>
          </div>
          <div
            ref={logContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '5px',
              fontFamily: 'Consolas, monospace',
              fontSize: '12px',
              width: '100%'
            }}
          >
          {logs.length > 0 ? (
            logs.map((log) => (
              <div
                key={log.id}
                className={`${
                  log.level === 'error' ? 'text-red-400' :
                  log.level === 'warning' ? 'text-yellow-400' :
                  log.level === 'success' ? 'text-green-400' :
                  'text-gray-300'
                }`}
                style={{ width: '100%', padding: '2px 0' }}
              >
                <span className="text-gray-500">[{log.time}]</span> {log.message}
              </div>
            ))
          ) : (
            <div className="text-gray-500">로그가 없습니다</div>
          )}
        </div>
      </div>
      )}

      {/* 로그인 모달 */}
      {showLoginModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setShowLoginModal(false)}
        >
          <div
            style={{
              backgroundColor: theme === 'dark' ? '#1f2937' : 'white',
              borderRadius: '8px',
              padding: '24px',
              width: '90%',
              maxWidth: '500px',
              boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ 
              fontSize: '20px', 
              fontWeight: 'bold', 
              marginBottom: '20px',
              backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              color: theme === 'dark' ? '#f3f4f6' : '#111827'
            }}>
              키움증권 API 로그인
            </h2>

            {/* 라이선스 키 입력 (필수) */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '14px', 
                fontWeight: 500, 
                marginBottom: '8px',
                backgroundImage: theme === 'dark' 
                  ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                  : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                color: theme === 'dark' ? '#f3f4f6' : '#374151'
              }}>
                라이선스 키 *
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="text"
                  value={licenseKey}
                  onChange={async (e) => {
                    const value = e.target.value
                    setLicenseKey(value)
                    
                    // 라이선스 키가 입력되면 자동으로 검증
                    if (value.trim().length > 0) {
                      try {
                        await validateLicenseKey(value.trim())
                      } catch (error) {
                        // 검증 실패 시 키 정보 초기화
                        setKeyInfo(null)
                      }
                    } else {
                      setKeyInfo(null)
                    }
                  }}
                  placeholder="관리자가 발급한 라이선스 키를 입력하세요 (필수)"
                  style={{
                    flex: 1,
                    padding: '10px',
                    border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                    backgroundColor: theme === 'dark' ? '#374151' : 'white',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827',
                    borderRadius: '8px',
                    fontSize: '14px'
                  }}
                />
                {/* 관리자 코드 아이콘 버튼 (F12로 표시/숨김) */}
                {showAdminIcon && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!showAdminPanel) {
                        setShowAdminPanel(true)
                      } else {
                        setShowAdminPanel(false)
                        setAdminCode('')
                      }
                    }}
                    style={{
                      padding: '4px 6px',
                      border: 'none',
                      borderRadius: '4px',
                      backgroundColor: 'transparent',
                      cursor: 'pointer',
                      fontSize: '14px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'opacity 0.2s',
                      minWidth: '28px',
                      height: '28px'
                    }}
                    title="관리자 코드 입력"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.opacity = '0.7'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.opacity = '1'
                    }}
                  >
                    🔑
                  </button>
                )}
              </div>
              {keyInfo && keyInfo.remainingDays !== undefined && (
                <div style={{ 
                  marginTop: '8px', 
                  fontSize: '12px',
                  backgroundImage: keyInfo.remainingDays > 7 
                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                    : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  color: keyInfo.remainingDays > 7 ? '#059669' : '#dc2626'
                }}>
                  {keyInfo.remainingDays > 0 
                    ? `✓ 라이선스 키 검증 완료 (남은 사용 기간: ${keyInfo.remainingDays}일)`
                    : '⚠️ 키가 만료되었습니다'
                  }
                </div>
              )}

              {/* 관리자 코드 입력 필드 (아이콘 클릭 시 표시) */}
              {showAdminPanel && (
                <div style={{ marginTop: '12px' }}>
                  <input
                    type="text"
                    value={adminCode}
                    onChange={(e) => {
                      const value = e.target.value
                      setAdminCode(value)
                    }}
                    placeholder="관리자 코드 입력"
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: theme === 'dark' ? '1px solid #3b82f6' : '1px solid #3b82f6',
                      borderRadius: '8px',
                      fontSize: '12px',
                      backgroundColor: theme === 'dark' ? '#1e3a8a' : '#eff6ff',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}
                  />
                  
                  {/* 관리자 패널 (아코디언) - cap@3156 입력 시 표시 */}
                  {adminCode === 'cap@3156' && (
                <div 
                  style={{
                    marginTop: '12px',
                    padding: '5px',
                    border: theme === 'dark' ? '1px solid #3b82f6' : '1px solid #3b82f6',
                    borderRadius: '8px',
                    backgroundColor: theme === 'dark' ? '#1e3a8a' : '#eff6ff',
                    animation: 'slideDown 0.3s ease-out'
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 style={{ 
                    fontSize: '16px', 
                    fontWeight: 'bold', 
                    marginBottom: '16px',
                    backgroundImage: theme === 'dark' 
                      ? 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)'
                      : 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: theme === 'dark' ? '#60a5fa' : '#1e40af'
                  }}>
                    🔐 라이선스 키 발급
                  </h3>

                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ 
                      display: 'block', 
                      fontSize: '12px', 
                      fontWeight: 500, 
                      marginBottom: '6px',
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#374151'
                    }}>
                      유효기간 (일) *
                    </label>
                    <input
                      type="number"
                      value={adminValidDays}
                      onChange={(e) => setAdminValidDays(parseInt(e.target.value) || 60)}
                      min={1}
                      max={365}
                      style={{
                        width: '100%',
                        padding: '8px',
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        borderRadius: '8px',
                        fontSize: '12px'
                      }}
                    />
                    <div style={{ 
                      fontSize: '10px', 
                      marginTop: '4px',
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                        : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#9ca3af' : '#6b7280'
                    }}>
                      {adminValidDays}일 후 만료 ({new Date(Date.now() + adminValidDays * 24 * 60 * 60 * 1000).toLocaleDateString()})
                    </div>
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ 
                      display: 'block', 
                      fontSize: '12px', 
                      fontWeight: 500, 
                      marginBottom: '6px',
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#374151'
                    }}>
                      발급자
                    </label>
                    <input
                      type="text"
                      value={adminIssuedBy}
                      onChange={(e) => setAdminIssuedBy(e.target.value)}
                      placeholder="admin"
                      style={{
                        width: '100%',
                        padding: '8px',
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        borderRadius: '8px',
                        fontSize: '12px'
                      }}
                    />
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ 
                      display: 'block', 
                      fontSize: '12px', 
                      fontWeight: 500, 
                      marginBottom: '6px',
                      backgroundImage: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#374151'
                    }}>
                      설명 (선택사항)
                    </label>
                    <input
                      type="text"
                      value={adminDescription}
                      onChange={(e) => setAdminDescription(e.target.value)}
                      placeholder="키 설명"
                      style={{
                        width: '100%',
                        padding: '8px',
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        borderRadius: '8px',
                        fontSize: '12px'
                      }}
                    />
                  </div>

                  <button
                    onClick={async () => {
                      if (adminValidDays < 1 || adminValidDays > 365) {
                        addLog('유효기간은 1일 이상 365일 이하여야 합니다', 'error')
                        return
                      }

                      setIsIssuingKey(true)
                      try {
                        const response = await fetch('/api/admin/keys/issue', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({
                            validDays: adminValidDays,
                            issuedBy: adminIssuedBy || 'admin',
                            description: adminDescription || undefined
                          })
                        })

                        const data = await response.json()

                        if (data.success) {
                          setLicenseKey(data.key) // 발급된 키를 라이선스 키 필드에 자동 입력
                          setAdminDescription('')
                          addLog(`라이선스 키 발급 성공: ${data.key} (만료일: ${new Date(data.expiresAt).toLocaleDateString()})`, 'success')
                          // 키 자동 검증
                          try {
                            await validateLicenseKey(data.key)
                          } catch (error) {
                            // 무시
                          }
                        } else {
                          addLog(`키 발급 실패: ${data.message}`, 'error')
                        }
                      } catch (error: any) {
                        addLog(`키 발급 오류: ${error.message}`, 'error')
                      } finally {
                        setIsIssuingKey(false)
                      }
                    }}
                    disabled={isIssuingKey}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: isIssuingKey ? '#9ca3af' : '#2563eb',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isIssuingKey ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
                      fontWeight: 500
                    }}
                  >
                    {isIssuingKey ? '발급 중...' : '라이선스 키 발급'}
                  </button>
                  </div>
                  )}
                </div>
              )}
            </div>

            {/* API 모드 선택 */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '14px', 
                fontWeight: 500, 
                marginBottom: '8px',
                backgroundImage: theme === 'dark' 
                  ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                  : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                color: theme === 'dark' ? '#f3f4f6' : '#374151'
              }}>
                API 모드
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="apiMode"
                    value="virtual"
                    checked={apiMode === 'virtual'}
                    onChange={(e) => setApiMode('virtual')}
                    style={{ width: '16px', height: '16px', borderRadius: '50%' }}
                  />
                  <span style={{ 
                    fontSize: '14px', 
                    fontWeight: 500,
                    backgroundImage: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: '#059669'
                  }}>모의투자</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="apiMode"
                    value="real"
                    checked={apiMode === 'real'}
                    onChange={(e) => setApiMode('real')}
                    style={{ width: '16px', height: '16px', borderRadius: '50%' }}
                  />
                  <span style={{ 
                    fontSize: '14px', 
                    fontWeight: 500,
                    backgroundImage: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                    color: '#dc2626'
                  }}>실전투자</span>
                </label>
              </div>
            </div>

            {/* App Key 입력 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '14px', 
                fontWeight: 500, 
                marginBottom: '8px',
                backgroundImage: theme === 'dark' 
                  ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                  : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                color: theme === 'dark' ? '#f3f4f6' : '#374151'
              }}>
                App Key *
              </label>
              <input
                type="text"
                value={appkey}
                onChange={(e) => setAppkey(e.target.value)}
                placeholder="키움증권 App Key를 입력하세요"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  backgroundColor: theme === 'dark' ? '#374151' : 'white',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  borderRadius: '8px',
                  fontSize: '14px'
                }}
              />
            </div>

            {/* Secret Key 입력 */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '14px', 
                fontWeight: 500, 
                marginBottom: '8px',
                backgroundImage: theme === 'dark' 
                  ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                  : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                color: theme === 'dark' ? '#f3f4f6' : '#374151'
              }}>
                Secret Key *
              </label>
              <input
                type="password"
                value={secretkey}
                onChange={(e) => setSecretkey(e.target.value)}
                placeholder="키움증권 Secret Key를 입력하세요"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  backgroundColor: theme === 'dark' ? '#374151' : 'white',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  borderRadius: '8px',
                  fontSize: '14px'
                }}
              />
            </div>


            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowLoginModal(false)}
                className="btn-outline-glow px-6 py-3 rounded-full font-semibold text-sm flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                취소
              </button>
              <button
                onClick={handleConnect}
                disabled={isConnecting || !licenseKey.trim() || !appkey || !secretkey}
                className={`px-6 py-3 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
                  (isConnecting || !licenseKey.trim() || !appkey || !secretkey)
                    ? 'bg-gray-500 cursor-not-allowed opacity-50'
                    : 'btn-gradient-primary'
                }`}
              >
                {isConnecting ? (
                  <>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="font-bold text-white">연결 중...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="font-bold text-white">연결</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  )
}

export default AutoTrading

