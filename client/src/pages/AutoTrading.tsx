import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { kiwoomApi } from '../api/kiwoom'
import apiClient, { authHeaders } from '../api/client'
import { useKiwoomStore } from '../store/useKiwoomStore'
import { useThemeStore } from '../store/useThemeStore'
import { hmsToSec, secInRange, pad2, stepSellTier } from '../utils/tradingTime'
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
  openPrice?: number // 시가 (원)
  highPrice?: number // 고가 (원)
  prevClose?: number // 전일 종가 (시가%/고가% 계산 기준)
  startPrice?: number // 자동매매 시작 시점의 가격 (상대 변화율 계산용)
  detectedChangePercent?: number // 조건 감지 시점의 등락률 (매수 조건 비교용)
  isHolding?: boolean // 계좌 보유 중 여부 (C# 코드의 b계좌보유중과 동일)
  purchasePrice?: number // 매수 가격 (C# 코드의 매수가격과 동일)
  purchaseQuantity?: number // 매수 수량 (C# 코드의 매수수량과 동일)
  purchaseTime?: string // 매수 시간 (C# 코드의 dt마지막매수시간과 동일)
  maxProfitPercent?: number // 최고 수익률 (C# 코드의 최고수익률과 동일)
  isScalpingBuy?: boolean // 스캘핑 매수 여부
  isBollingerBuy?: boolean // 볼린저 밴드 매수 여부
  isBreakoutBuy?: boolean // 돌파 매수 여부
  isPatternBuy?: boolean // 패턴 매수 여부
}

interface HoldingStock {
  code: string
  name: string
  quantity: number
  sellableQuantity?: number // 매도가능수량 (미체결 매도 주문분 제외)
  purchasePrice: number
  purchaseAmount?: number // 정확한 매입금액 (평균단가 반올림 오차 방지)
  evaluation?: number // 서버가 준 평가금액 (합계 일치용)
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
  sellableQuantity?: number // 매도가능수량 (미체결 매도 주문분 제외한 실제 주문 가능 수량)
  price: number
  status: string
  orderNumber?: string
  isExecuted?: boolean // 체결 여부 플래그
  orderPrice?: number // 주문가 (0이면 시장가, 0보다 크면 지정가)
  orderTimestamp?: number // 주문 접수 시점의 타임스탬프 (밀리초)
  cancelTimestamp?: number // 주문 취소 시점의 타임스탬프 (밀리초)
  isMarketOrder?: boolean // 시장가 주문 여부
  unfilledQuantity?: number // 미체결 수량 (WebSocket 체결 확인용)
  currentPrice?: number // 실시간 현재가 (체결된 주문만)
  profit?: number // 실시간 수익 (체결된 매수 주문만)
  profitPercent?: number // 실시간 수익률 (체결된 매수 주문만)
  realizedProfit?: number // 실현손익 (매도 체결 완료 시 계산)
  realizedProfitPercent?: number // 실현손익률 (매도 체결 완료 시 계산)
  buyPrice?: number // 매수가 (매도 주문 시 참조용)
}

interface LogMessage {
  id: number
  time: string
  message: string
  level: 'info' | 'warning' | 'error' | 'success'
}

// 시가%/고가% 계산 (전일 종가 대비). 전일 종가를 모르면 현재가/등락률로 역산한다.
const pricePercentFromPrevClose = (target?: number, prevClose?: number): number | null => {
  if (!target || target <= 0 || !prevClose || prevClose <= 0) return null
  return ((target - prevClose) / prevClose) * 100
}

// 전일 종가 역산 (등락률은 전일종가 대비이므로 price/(1+rate/100))
const prevCloseFromRate = (price: number, changeRate: number): number | undefined => {
  if (!price || price <= 0) return undefined
  const denom = 1 + changeRate / 100
  return denom > 0 ? price / denom : undefined
}

/**
 * 실현손익 계산용 매수가를 결정한다.
 *
 * 잔고(kt00018)의 pur_pric(평균단가)이 0으로 오는 경우가 있어
 * 그대로 쓰면 실현손익이 항상 0원이 된다.
 * 매입금액/수량 → 현재 보유종목 평균단가 → 매수 주문 로그 순으로 보강한다.
 */
const resolveBuyPrice = (
  explicit: number | undefined,
  held: { purchasePrice?: number; purchaseAmount?: number; quantity?: number } | undefined,
  buyOrderPrice?: number
): number => {
  if (explicit && explicit > 0) return explicit
  if (held?.purchasePrice && held.purchasePrice > 0) return held.purchasePrice
  // 매입금액이 있으면 수량으로 나눠 평균단가를 구한다
  if (held?.purchaseAmount && held.purchaseAmount > 0 && held.quantity && held.quantity > 0) {
    return Math.round(held.purchaseAmount / held.quantity)
  }
  if (buyOrderPrice && buyOrderPrice > 0) return buyOrderPrice
  return 0
}

/**
 * HttpOnly 세션 쿠키로 이미 인증된 상태를 나타내는 표시값.
 * 키 값 자체는 JS에서 읽을 수 없으므로 입력창에 이 값을 넣어
 * "로그인됨"을 보여주고, 서버 인증은 쿠키로 처리한다.
 */
const SESSION_PLACEHOLDER = '(로그인됨)'

/**
 * 체결가를 결정한다.
 *
 * 키움 00(주문체결)의 체결가 필드가 0으로 오는 경우가 있다 (시장가·모의투자).
 * 그대로 order.price(시장가=0)로 폴백하면 매도가가 0이 되어
 * 실현손익이 -100%로 계산된다. 실제 값이 있는 소스만 쓴다.
 */
const resolveExecutedPrice = (
  fromSocket: number,
  order: { price?: number; currentPrice?: number },
  livePrice?: number
): number => {
  if (fromSocket > 0) return Math.round(fromSocket)
  if (order.price && order.price > 0) return Math.round(order.price)
  if (order.currentPrice && order.currentPrice > 0) return Math.round(order.currentPrice)
  if (livePrice && livePrice > 0) return Math.round(livePrice)
  return 0
}

/** 실현손익 계산에 쓸 만한 가격인지 (0원 배제) */
const isValidTradePrice = (price: number): boolean =>
  Number.isFinite(price) && price > 0

// 전일대비 = 현재가 - 전일종가 (표시는 정수 원 단위)
const changeFromRate = (price: number, changeRate: number): number => {
  const prev = prevCloseFromRate(price, changeRate)
  return prev === undefined ? 0 : Math.round(price - prev)
}

/**
 * 날짜 비교용 키 (YYYY-MM-DD, 로컬 시간 기준)
 *
 * toLocaleDateString('ko-KR')은 "2026. 11. 26."처럼 공백·마침표가 들어가고
 * 엔진/로캘에 따라 형식이 달라진다. 서버에 저장한 값과 비교하면
 * 같은 날인데도 불일치해 실현손익이 0으로 보이는 원인이 된다.
 */
const dateKey = (d: Date = new Date()): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 숫자 입력 (매매시간/수익률 공용 - C# NumericUpDown 대응)
const Num = ({ value, onChange, theme, width = '40px', step = 1, min, max, disabled = false }: {
  value: number
  onChange: (v: number) => void
  theme: string
  width?: string
  step?: number
  min?: number
  max?: number
  disabled?: boolean
}) => (
  <input
    type="number"
    value={value}
    step={step}
    disabled={disabled}
    onChange={(e) => {
      const n = Number(e.target.value)
      if (!Number.isFinite(n)) return onChange(0)
      onChange(Math.min(max ?? 1e9, Math.max(min ?? -1e9, n)))
    }}
    style={{
      width,
      padding: '2px 3px',
      border: `1px solid ${theme === 'dark' ? '#4b5563' : '#999'}`,
      backgroundColor: disabled ? (theme === 'dark' ? '#1f2937' : '#f3f4f6') : (theme === 'dark' ? '#374151' : 'white'),
      color: disabled ? '#9ca3af' : (theme === 'dark' ? '#f3f4f6' : '#111827'),
      textAlign: 'center',
      fontSize: '11px',
      borderRadius: '8px'
    }}
  />
)

// 시/분/초 묶음 입력 (초 단위가 없으면 시/분만)
const Hms = ({ h, m, s, onH, onM, onS, theme, disabled = false }: {
  h: number
  m: number
  s?: number
  onH: (v: number) => void
  onM: (v: number) => void
  onS?: (v: number) => void
  theme: string
  disabled?: boolean
}) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', fontSize: '11px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
    <Num value={h} onChange={onH} theme={theme} width="36px" min={0} max={23} disabled={disabled} />시
    <Num value={m} onChange={onM} theme={theme} width="36px" min={0} max={59} disabled={disabled} />분
    {onS && s !== undefined && (
      <>
        <Num value={s} onChange={onS} theme={theme} width="36px" min={0} max={59} disabled={disabled} />초
      </>
    )}
  </span>
)

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
      refetchInterval: isSelected ? 3000 : false, // 3초마다 갱신 (실시간에 가깝게)
      // 요청 한도 초과(429)는 서버 큐가 간격을 벌리므로 곧 회복된다. 이전 차트를 유지하고 재시도한다.
      keepPreviousData: true,
      retry: (failureCount: number, err: any) => {
        if ((err?.response?.status || err?.status) === 429) return failureCount < 2
        return false
      },
      retryDelay: 3000,
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
    
    // 종목 정보가 있으면 현재가 1포인트만 표시 (가짜 봉을 만들지 않는다)
    if (stockInfo && stockInfo.price && stockInfo.price > 0) {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      const dateStr = period === 'day'
        ? `${year}${month}${day}`
        : `${year}${month}${day}${hours}${minutes}`

      const price = stockInfo.price
      const fallbackChartData = [{
        time: dateStr,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: stockInfo.volume || 0,
      }]

      const yAxisMin = price * 0.98
      const yAxisMax = price * 1.02

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
              <Tooltip 
                contentStyle={{
                  backgroundColor: theme === 'dark' ? '#374151' : '#ffffff',
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  borderRadius: '6px',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  fontSize: '11px',
                  padding: '4px 8px'
                }}
                formatter={(value: any) => value.toLocaleString()}
                labelFormatter={(label) => `시간: ${label}`}
              />
              <Line 
                yAxisId="price"
                type="monotone" 
                dataKey="close" 
                stroke="#3b82f6" 
                strokeWidth={2}
                dot={true}
                name="현재가"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ padding: '8px', textAlign: 'center', fontSize: '11px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>
            * 차트 데이터가 없어 현재가만 표시합니다
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
  // 키움 1분봉은 900건(3일치)까지 오므로 당일 데이터만 사용한다.
  // (전날 봉까지 그리면 축이 압축되어 봉이 뭉개지고 시세도 왜곡된다)
  const allCandles = candles
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

  // 오늘 날짜(yyyymmdd) — 1분봉·일봉 모두 이 값으로 필터
  const nowDate = new Date()
  const todayKey = `${nowDate.getFullYear()}${String(nowDate.getMonth() + 1).padStart(2, '0')}${String(nowDate.getDate()).padStart(2, '0')}`

  // 분봉: 당일 데이터만 (일봉은 날짜별이므로 그대로 사용)
  const todayCandles = period === 'day'
    ? allCandles
    : allCandles.filter((c: any) => c.time.startsWith(todayKey))

  // 당일 데이터가 없으면(장 시작 전·휴장일) 원본 유지 → 빈 차트 방지
  const chartData = (todayCandles.length > 0 ? todayCandles : allCandles)
    .slice() // 원본 보호
    .sort((a: any, b: any) => String(a.time).localeCompare(String(b.time))) // 과거 → 최신

  // 마지막 봉을 실시간 시세로 갱신한다 (폴링 사이에도 차트가 즉시 움직이도록)
  if (chartData.length > 0 && stockInfo?.price && stockInfo.price > 0) {
    const lastCandle = chartData[chartData.length - 1]
    const livePrice = stockInfo.price
    const lastDate = String(lastCandle.time).substring(0, 8)
    const isTodayCandle = lastDate === todayKey

    if (isTodayCandle) {
      lastCandle.close = livePrice
      if (livePrice > lastCandle.high) lastCandle.high = livePrice
      if (livePrice < lastCandle.low) lastCandle.low = livePrice
    }

    // 1분봉: 현재 분(minute) 봉이 아직 없으면 실시간 가격으로 새 봉을 만든다
    // (API 폴링이 1분 늦게 반영되는 문제 해결)
    if (period !== 'day') {
      const now = new Date()
      const currentMinuteKey =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}00`

      const hasCurrentBar = chartData.some((c: any) => c.time === currentMinuteKey)
      if (!hasCurrentBar && lastDate === todayKey) {
        chartData.push({
          time: currentMinuteKey,
          open: livePrice,
          high: livePrice,
          low: livePrice,
          close: livePrice,
          volume: 0,
        })
      }
    }
  }
  
  // 변환 후에도 데이터가 없으면 메시지 표시
  if (chartData.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: theme === 'dark' ? '#d1d5db' : '#6b7280' }}>
        유효한 차트 데이터가 없습니다
      </div>
    )
  }

  // Y축 범위 계산
  const prices = chartData
    .flatMap((d: { high: number; low: number; open: number; close: number }) => [d.high, d.low, d.open, d.close])
    .filter((p: number) => p > 0)
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

// 보유 종목 응답 정규화 ({ stocks: [...] } 또는 배열 모두 처리)
const normalizeBalanceRows = (balance: any): any[] => {
  if (Array.isArray(balance)) return balance
  if (Array.isArray(balance?.stocks)) return balance.stocks
  return []
}

/**
 * 주문 실패 사유 추출
 * axios 에러는 message가 "Request failed with status code 400"이라
 * 서버가 내려온 실제 사유(detail/returnMsg)를 우선 사용한다.
 */
const getOrderErrorInfo = (error: any): { message: string; status?: number; returnCode?: any } => {
  const data = error?.response?.data
  const message =
    data?.detail ||
    data?.returnMsg ||
    data?.error ||
    error?.message ||
    '알 수 없는 오류'
  return {
    message,
    status: error?.response?.status,
    returnCode: data?.returnCode ?? data?.return_code,
  }
}

/**
 * 매도 가능 수량 계산
 * 키움 잔고의 trde_able_qty(매도가능수량)를 우선 사용한다.
 * 그 값이 없을 때만 (보유 - 미체결 매도)로 추정한다.
 * 미체결 매도 주문 수량만큼 키움이 매도가능수량을 차감하므로,
 * 보유 16주 + 미체결 매도 16주 상태에서 또 매도하면 (800033) 매도가능수량 부족으로 거부된다.
 */
const calcSellableQuantity = (
  heldQty: number,
  pendingSellQty: number,
  sellableFromApi?: number
): number => {
  if (Number.isFinite(sellableFromApi as number)) {
    return Math.max(0, Math.floor(sellableFromApi as number))
  }
  return Math.max(0, Math.floor(heldQty) - Math.max(0, Math.floor(pendingSellQty)))
}

/**
 * 매도 주문 가격/옵션 결정
 * 지정가 매도는 상한가처럼 매도 호가가 얇은 종목에서도 체결된다.
 * 시장가는 유동성이 낮으면 '접수' 상태로 남아 물량을 잠그므로 지정가를 우선 고려한다.
 */
const resolveSellOrderPrice = (
  currentPrice: number,
  sellType: 'market' | 'limit',
  offset = 0
): { price: number; order_option: '00' | '03' } => {
  if (sellType !== 'limit' || !(currentPrice > 0)) {
    return { price: 0, order_option: '03' }
  }
  return { price: Math.max(1, Math.floor(currentPrice + offset)), order_option: '00' }
}

/** 미체결로 간주하는 주문 상태
 *  '종료'는 체결 0 + 잔량 0 으로 더 이상 취소할 수량이 없는 주문이다 (kt00007). */
const isPendingSellStatus = (status?: string) =>
  status === '접수' || status === '확인' || status === '미체결'
// '오전 9:15:15' 형태의 시각을 초 단위로 변환 (정렬/최신 비교용)
const parseClockSeconds = (time: string): number => {
  const text = String(time || '')
  const m = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return NaN
  let hour = parseInt(m[1], 10)
  const minute = parseInt(m[2], 10)
  const second = m[3] ? parseInt(m[3], 10) : 0
  // 오전/오후가 있으면 12시간제로 보정
  if (text.includes('오후') && hour < 12) hour += 12
  if (text.includes('오전') && hour === 12) hour = 0
  return hour * 3600 + minute * 60 + second
}

// 보유 종목 표시용 병합: 매수 체결 건만 종목별 1줄로 합친다
// (매도 내역은 표시하지 않는다 — 매도는 '오늘 실현손익'으로 집계된다)
const buildDisplayOrders = (logs: OrderLog[]): Array<OrderLog & {
  count: number
  quantity: number
  latestTime: string
}> => {
  const filtered = logs.filter(order =>
    order.type === 'buy' &&
    order.status !== '취소' &&
    order.status !== '부분체결' &&
    (order.status === '체결' || order.isExecuted === true)
  )

  const groups = new Map<string, OrderLog & { count: number; quantity: number; latestTime: string }>()
  for (const order of filtered) {
    const key = `${order.stockCode}_${order.type}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...order, count: 1, quantity: order.quantity, latestTime: order.time })
      continue
    }
    // 수량 누적, 시간은 가장 최근으로, 가격/수익률은 최신 주문 기준
    const prevSec = parseClockSeconds(existing.latestTime)
    const nextSec = parseClockSeconds(order.time)
    const isNewer = Number.isFinite(nextSec) && (!Number.isFinite(prevSec) || nextSec >= prevSec)
    groups.set(key, {
      ...(isNewer ? order : existing),
      count: existing.count + 1,
      quantity: existing.quantity + order.quantity,
      latestTime: isNewer ? order.time : existing.latestTime,
    })
  }

  // 최신 주문 순으로 정렬
  return Array.from(groups.values()).sort(
    (a, b) => parseClockSeconds(b.latestTime) - parseClockSeconds(a.latestTime)
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

  // 수동 종목 추가 (조건검색식에 종목 직접 추가)
  const [manualKeyword, setManualKeyword] = useState<string>('')
  const [manualResults, setManualResults] = useState<{ code: string; name: string }[]>([])
  const [manualSelectedCodes, setManualSelectedCodes] = useState<Set<string>>(new Set())
  const [isManualSearching, setIsManualSearching] = useState<boolean>(false)
  
  // 검색된 종목 페이지네이션
  const [displayedStockCount, setDisplayedStockCount] = useState<number>(20) // 표시할 종목 수
  const stocksScrollRef = useRef<HTMLDivElement>(null)
  
  // 컬럼 너비 상태
  const [columnWidths, setColumnWidths] = useState<{ [key: string]: number }>({
    name: 300, // ETN 등 장문 종목명도 잘리지 않도록
    price: 80,
    change: 70,
    changePercent: 70,
    openPercent: 70,
    highPercent: 70,
    volume: 90,
    action: 60,
    algorithm: 120,
    detectedTime: 100
  })
  const [resizingColumn, setResizingColumn] = useState<string | null>(null)
  const [resizeStartX, setResizeStartX] = useState<number>(0)
  const [resizeStartWidth, setResizeStartWidth] = useState<number>(0)
  
  // 차트 관련 상태
  const [selectedStockForChart, setSelectedStockForChart] = useState<DetectedStock | null>(null)
  const [chartPeriod, setChartPeriod] = useState<'min' | '5' | '15' | '30' | '60' | 'day'>('5')
  
  const [holdingStocks, setHoldingStocks] = useState<HoldingStock[]>([])
  // 최신 보유종목을 ref로도 보관한다.
  // (잔고 폴링 콜백·실행 루프가 시작 시점 state 스냅샷을 붙들지 않도록)
  const holdingStocksRef = useRef<HoldingStock[]>([])
  holdingStocksRef.current = holdingStocks
  const [orderLogs, setOrderLogs] = useState<OrderLog[]>([])
  // 최신 주문 목록을 ref로도 보관한다 (자동 취소 타이머가 오래된 스냅샷을 붙들지 않도록)
  const orderLogsRef = useRef<OrderLog[]>([])
  orderLogsRef.current = orderLogs
  // 이미 취소 요청을 보낸 주문번호 (중복 취소 방지)
  const cancelRequestedRef = useRef<Set<string>>(new Set())
  const [logs, setLogs] = useState<LogMessage[]>([])
  const [showLogSection, setShowLogSection] = useState<boolean>(false) // 로그 섹션 표시 여부
  const [activeTab, setActiveTab] = useState<'orders' | 'conditions' | 'strategies'>('orders')
  const [buyType, setBuyType] = useState<'cash' | 'credit'>('cash')
  const [selectedConditionText, setSelectedConditionText] = useState<string>('선택된 조건식이 없습니다. 조건식을 체크해주세요.')
  
  // 매매 제한 추적 (종목당 매매횟수, 당일 매매종목수)
  const [stockTradeCounts, setStockTradeCounts] = useState<Map<string, number>>(new Map()) // 종목별 매매 횟수
  const [dailyTradedStocks, setDailyTradedStocks] = useState<Set<string>>(new Set()) // 당일 매매한 종목 목록
  const [dailyTradeCount, setDailyTradeCount] = useState<number>(0) // 당일 매매 종목 수
  const [restrictedStocks, setRestrictedStocks] = useState<Set<string>>(new Set()) // 매매제한 종목 목록 (재시도 방지)
  const [processingOrders, setProcessingOrders] = useState<Set<string>>(new Set()) // 주문 처리 중인 종목코드 목록 (중복 방지)
  const [processedOrderNumbers, setProcessedOrderNumbers] = useState<Set<string>>(new Set()) // 처리된 주문번호 목록 (중복 방지)
  const [orderedOrHoldingStocks, setOrderedOrHoldingStocks] = useState<Set<string>>(new Set()) // 매수 주문했거나 보유 중인 종목 목록 (C# 코드의 매수주문했거나보유중인종목과 동일)
  // 현재 보유 종목 표에서 체크된 종목코드 (선택매도 대상)
  const [selectedHoldingCodes, setSelectedHoldingCodes] = useState<Set<string>>(new Set())
  
  // 매매설정 상태 (useTradingConditions 제거 - 각 전략별 체크박스로 대체)
  const [amountPerStock, setAmountPerStock] = useState<number>(50000)
  const [maxSimultaneousBuy, setMaxSimultaneousBuy] = useState<number>(10)
  const [tradeLimitPerStock, setTradeLimitPerStock] = useState<number>(30)
  const [maxDailyStocks, setMaxDailyStocks] = useState<number>(50)
  const [feePercent, setFeePercent] = useState<number>(0.92)
  
  // 종목별 매수가격 설정
  const [buyPriceSettings, setBuyPriceSettings] = useState({
    종목별매수가격설정실행: true,
    매수가격옵션: '지정가' as '시장가' | '지정가',
    매수호가: 0,
  })
  
  // 매매시간 설정
  const [startHour, setStartHour] = useState<number>(9)
  const [startMinute, setStartMinute] = useState<number>(0)
  const [endHour, setEndHour] = useState<number>(15)
  const [endMinute, setEndMinute] = useState<number>(19)
  const [endSecond, setEndSecond] = useState<number>(59)
  const [dropSellTime, setDropSellTime] = useState<boolean>(true)
  const [dropSellStartHour, setDropSellStartHour] = useState<number>(12)
  const [dropSellStartMinute, setDropSellStartMinute] = useState<number>(0)
  const [dropSellEndSecond, setDropSellEndSecond] = useState<number>(0)
  // 시간대정지 (매수만 중단, 매도는 계속)
  const [pauseBuyEnabled, setPauseBuyEnabled] = useState<boolean>(true)
  const [pauseStartHour, setPauseStartHour] = useState<number>(12)
  const [pauseStartMinute, setPauseStartMinute] = useState<number>(0)
  const [pauseEndHour, setPauseEndHour] = useState<number>(14)
  const [pauseEndMinute, setPauseEndMinute] = useState<number>(0)
  // 즉시 매수정지 (수동) / 매수 재개
  const [buyStopped, setBuyStopped] = useState<boolean>(false)
  const [nowTick, setNowTick] = useState<number>(Date.now())

  // 단계별 익절 설정 (C# 매매설정.Static기본매수 단계별익절*)
  const [stepProfit, setStepProfit] = useState({
    사용: true,
    익절1: 10.0, // 1차 (10% 수량)
    익절2: 20.0, // 2차 (40% 수량)
    익절3: 30.0, // 3차 (60% 수량)
    익절4: 45.0, // 4차 (잔량)
    손절: -10.0
  })
  const stepSoldRef = useRef<Map<string, number>>(new Map()) // 종목별 완료 단계 (C# 종목정보.단계별익절단계)
  
  // 매수/매도 가격지정
  const [profitTarget, setProfitTarget] = useState<number>(10.0)
  const [profitType, setProfitType] = useState<'market' | 'limit'>('market')
  const [lossLimit, setLossLimit] = useState<number>(-3.0)
  const [lossType, setLossType] = useState<'market' | 'limit'>('market')
  const [lossPriceOffset, setLossPriceOffset] = useState<number>(0)
  
  // 손절 설정 (시장가 자동 매도)
  const [stopLossEnabled, setStopLossEnabled] = useState<boolean>(true) // 손절 기능 활성화
  const [stopLossRate, setStopLossRate] = useState<number>(-2.0) // 손절 기준손실률 (%)
  const [stopLossExecuting, setStopLossExecuting] = useState<Set<string>>(new Set()) // 손절 실행 중인 종목
  
  // 기타조건
  const [autoStart, setAutoStart] = useState<boolean>(false)
  const [trailingStop, setTrailingStop] = useState<boolean>(true)
  const [trailingProfitThreshold, setTrailingProfitThreshold] = useState<number>(5)
  const [trailingDropThreshold, setTrailingDropThreshold] = useState<number>(-3.0)

  // 매매시간 상태 계산 (1초 갱신)
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const nowSec = (() => {
    const d = new Date(nowTick)
    return hmsToSec(d.getHours(), d.getMinutes(), d.getSeconds())
  })()
  const inTradingWindow = secInRange(nowSec, hmsToSec(startHour, startMinute), hmsToSec(endHour, endMinute, endSecond))
  const inPauseWindow = pauseBuyEnabled && secInRange(nowSec, hmsToSec(pauseStartHour, pauseStartMinute), hmsToSec(pauseEndHour, pauseEndMinute))
  const buyBlockReason = !inTradingWindow
    ? '매매시간외'
    : buyStopped
      ? '즉시매수정지'
      : inPauseWindow
        ? `시간대정지 ${pad2(pauseStartHour)}:${pad2(pauseStartMinute)}~${pad2(pauseEndHour)}:${pad2(pauseEndMinute)}`
        : null
  const canBuy = buyBlockReason === null

  // 실행 루프(30초 인터벌)는 시작 시점 클로저를 쓰므로 최신 설정을 ref로 전달
  const timeGateRef = useRef({ startHour, startMinute, endHour, endMinute, endSecond, pauseBuyEnabled, pauseStartHour, pauseStartMinute, pauseEndHour, pauseEndMinute, buyStopped, dropSellTime, dropSellStartHour, dropSellStartMinute, dropSellEndSecond })
  timeGateRef.current = { startHour, startMinute, endHour, endMinute, endSecond, pauseBuyEnabled, pauseStartHour, pauseStartMinute, pauseEndHour, pauseEndMinute, buyStopped, dropSellTime, dropSellStartHour, dropSellStartMinute, dropSellEndSecond }
  const stepProfitRef = useRef(stepProfit)
  stepProfitRef.current = stepProfit
  const sellStyleRef = useRef({ profitType, lossType, lossPriceOffset })
  sellStyleRef.current = { profitType, lossType, lossPriceOffset }
  
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
  
  // 오늘의 실현손익 총합 (매도 체결 완료 시 누적)
  // localStorage는 즉시 표시용 캐시로만 쓰고, 실제 값은 서버(라이선스 키 단위)에 저장한다.
  // (localStorage만 쓰면 브라우저·도메인마다 값이 달라진다)
  const [todayTotalRealizedProfit, setTodayTotalRealizedProfit] = useState<number>(() => {
    const saved = localStorage.getItem('today_realized_profit')
    const savedDate = localStorage.getItem('today_realized_profit_date')
    const today = dateKey()

    // 날짜 비교는 숫자만으로 한다 (이전 "2026. 11. 26." 형식 호환)
    const savedDigits = String(savedDate || '').replace(/[^0-9]/g, '')
    const todayDigits = today.replace(/[^0-9]/g, '')

    // 저장된 날짜가 오늘이면 저장된 값 사용, 아니면 0
    if (savedDigits && savedDigits === todayDigits && saved) {
      return parseFloat(saved) || 0
    }
    return 0
  })
  
  // 사용자수식
  const [buyFormula1, setBuyFormula1] = useState<boolean>(false) // My 매수수식 1
  const [buyFormula2, setBuyFormula2] = useState<boolean>(true) // My 매수수식 2
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
  const { data: accountInfoData, error: accountInfoError, refetch: refetchAccountInfo } = useQuery(
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
      refetchInterval: isRunning ? 15000 : false, // 자동매매 실행 중일 때 15초마다 계좌 정보 조회 (API 제한 방지)
      staleTime: 0, // 항상 stale 상태로 간주하여 refetch 및 invalidate 시 즉시 재조회 가능
      retry: false, // 자동 재시도 비활성화
      retryOnMount: false,
      onSuccess: (data: any) => {
        // 응답에 에러가 포함된 경우
        if (data?.error) {
          // API 요청 제한 에러인 경우 자동매매 일시 중지
          if (data.error.includes('허용된 요청 개수를 초과') || 
              data.error.includes('요청 개수를 초과')) {
            addLog(`[API 제한] 계좌 정보 조회 중 요청 제한 발생. 60초간 대기합니다.`, 'error')
            setIsRunning(false)
            setTimeout(() => {
              setIsRunning(true)
              addLog(`[API 제한 해제] 자동매매를 재개합니다.`, 'info')
            }, 60000) // 60초 대기
          } else {
            addLog(`계좌 정보 조회: ${data.error}`, 'warning')
          }
        } else if (data) {
          // 예수금 정보 로깅 (디버깅용)
          console.log(`[계좌 정보] 예수금: ${data.deposit ? Number(data.deposit).toLocaleString() : '정보 없음'}원, 총평가금액: ${data.totalAsset ? Number(data.totalAsset).toLocaleString() : '정보 없음'}원`)
        }
      },
      onError: (error: any) => {
        const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || ''
        // API 요청 제한 에러인 경우 자동매매 일시 중지
        if (errorMessage.includes('허용된 요청 개수를 초과') || 
            errorMessage.includes('요청 개수를 초과') ||
            error.response?.status === 429) {
          addLog(`[API 제한] 계좌 정보 조회 중 요청 제한 발생. 60초간 대기합니다.`, 'error')
          setIsRunning(false)
          setTimeout(() => {
            setIsRunning(true)
            addLog(`[API 제한 해제] 자동매매를 재개합니다.`, 'info')
          }, 60000) // 60초 대기
        } else {
          addLog(`계좌 정보 조회 오류: ${errorMessage}`, 'error')
        }
      }
    }
  )

  // 계좌 잔고 조회
  const { data: balanceData, error: balanceError, refetch: refetchBalance } = useQuery(
    ['balance', selectedAccount],
    () => {
      if (!selectedAccount) return Promise.resolve([])
      
      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'
      
      return kiwoomApi.getBalanceSummary(accountNo, accountProductCode)
    },
    {
      enabled: isConnected && !!selectedAccount,
      // 자동매매 중이 아니어도 주기적으로 갱신한다 (수익률이 멈추지 않도록)
      refetchInterval: isRunning ? 3000 : 10000,
      retry: false, // 자동 재시도 비활성화
      retryOnMount: false,
      onSuccess: (data) => {
        // 에러가 포함된 경우 처리
        if (data?.error) {
          // API 요청 제한 에러인 경우 자동매매 일시 중지
          if (data.error.includes('허용된 요청 개수를 초과') || 
              data.error.includes('요청 개수를 초과')) {
            addLog(`[API 제한] 보유종목 조회 중 요청 제한 발생. 60초간 대기합니다.`, 'error')
            setIsRunning(false)
            setTimeout(() => {
              setIsRunning(true)
              addLog(`[API 제한 해제] 자동매매를 재개합니다.`, 'info')
            }, 60000) // 60초 대기
            setHoldingStocks([])
            return
          }
          addLog(`계좌 잔고 조회 오류: ${data.error}`, 'warning')
          setHoldingStocks([])
          return
        }
        
        const newHoldingStocks: HoldingStock[] = []
        
        // 기존 보유종목의 최고 수익률을 코드별로 보존 (폴링마다 0으로 리셋되면 트레일링 판정이 깨진다)
        const prevMaxProfit = new Map<string, number>()
        for (const prev of holdingStocksRef.current) {
          prevMaxProfit.set(prev.code, prev.maxProfitPercent || 0)
        }

        if (Array.isArray(data)) {
          newHoldingStocks.push(...data.map((stock: any) => {
            const code = stock.code || stock.종목코드 || ''
            const profitPercent = Number(stock.profitPercent ?? stock.수익률 ?? 0)
            return {
              code,
              name: stock.name || stock.종목명 || '',
              quantity: stock.quantity || stock.보유수량 || 0,
              // 매도가능수량(trde_able_qty). 미체결 매도 주문이 잡아둔 수량은 제외된 값이다.
              // 이 값이 없으면 유령 미체결 판별이 항상 실패한다.
              sellableQuantity: Number(stock.sellableQuantity ?? stock.quantity ?? 0),
              purchasePrice: stock.purchasePrice || stock.매입가 || 0,
              purchaseAmount: Number(stock.purchaseAmount ?? stock.매입금액 ?? 0) || undefined,
              evaluation: Number(stock.evaluation ?? stock.평가금액 ?? 0) || undefined,
              currentPrice: stock.currentPrice || stock.현재가 || 0,
              profit: stock.profit || stock.평가손익 || 0,
              profitPercent,
              // 서버가 최고수익률을 주지 않으므로 기존 값과 현재 수익률 중 큰 값 유지
              maxProfitPercent: Math.max(prevMaxProfit.get(code) || 0, profitPercent),
            }
          }))
        } else if (data?.stocks && Array.isArray(data.stocks)) {
          newHoldingStocks.push(...data.stocks.map((stock: any) => {
            const code = stock.code || stock.종목코드 || ''
            const profitPercent = Number(stock.profitPercent ?? stock.수익률 ?? 0)
            return {
              code,
              name: stock.name || stock.종목명 || '',
              quantity: stock.quantity || stock.보유수량 || 0,
              // 매도가능수량(trde_able_qty). 유령 미체결 판별에 필수.
              sellableQuantity: Number(stock.sellableQuantity ?? stock.quantity ?? 0),
              purchasePrice: stock.purchasePrice || stock.매입가 || 0,
              purchaseAmount: Number(stock.purchaseAmount ?? stock.매입금액 ?? 0) || undefined,
              evaluation: Number(stock.evaluation ?? stock.평가금액 ?? 0) || undefined,
              currentPrice: stock.currentPrice || stock.현재가 || 0,
              profit: stock.profit || stock.평가손익 || 0,
              profitPercent,
              maxProfitPercent: Math.max(prevMaxProfit.get(code) || 0, profitPercent),
            }
          }))
        }
        
        // 부분 체결된 주문도 보유종목에 추가 (WebSocket 체결 정보 기반)
        // orderLogs와 detectedStocks state를 직접 참조할 수 없으므로, setOrderLogs와 setDetectedStocks를 사용하여 최신 값을 가져옴
        setOrderLogs(prevOrderLogs => {
          setDetectedStocks(prevDetectedStocks => {
            const partiallyExecutedOrders = prevOrderLogs.filter(order => 
              order.type === 'buy' && 
              (order.status === '부분체결' || (order.status === '체결' && order.unfilledQuantity !== undefined && order.unfilledQuantity > 0)) &&
              order.orderNumber
            )
            
            partiallyExecutedOrders.forEach(order => {
              // 체결된 수량 계산
              const 체결수량 = order.unfilledQuantity !== undefined 
                ? order.quantity - order.unfilledQuantity 
                : order.quantity
              
              if (체결수량 > 0) {
                // 잔고(kt00018)에 이미 있는 종목은 로그 수량으로 덮어쓰지 않는다.
                // (오늘 매수 로그 합계가 실제 보유수량보다 클 수 있다)
                const existingHolding = newHoldingStocks.find(h => h.code === order.stockCode)
                if (existingHolding) {
                  console.log(`[보유종목 유지] ${order.stockName}: 잔고 수량 ${existingHolding.quantity}주 우선 (로그 체결 ${체결수량}주)`)
                } else {
                  // 잔고에 없는 종목만 체결 로그로 보충한다 (부분체결 직후 잔고 반영 지연 대응)
                  const currentPrice = prevDetectedStocks.find(s => s.code === order.stockCode)?.price || order.price || 0
                  const purchasePrice = order.price || 0
                  
                  console.log(`[보유종목 추가] 잔고에 없는 부분체결 주문 보충 - ${order.stockName} (${order.stockCode}), 체결수량: ${체결수량}주, 매수가: ${purchasePrice}원`)
                  
                  newHoldingStocks.push({
                    code: order.stockCode,
                    name: order.stockName,
                    quantity: 체결수량,
                    purchasePrice: purchasePrice,
                    currentPrice: currentPrice,
                    profit: (currentPrice - purchasePrice) * 체결수량,
                    profitPercent: purchasePrice > 0 ? ((currentPrice - purchasePrice) / purchasePrice) * 100 : 0,
                    maxProfitPercent: 0,
                  })
                }
              }
            })
            
            return prevDetectedStocks // detectedStocks는 변경하지 않음
          })
          
          return prevOrderLogs // orderLogs는 변경하지 않음
        })
        
        // 기존 보유종목과 병합 (체결된 주문을 기반으로 보유종목 생성)
        setHoldingStocks(prevHoldingStocks => {
          // API에서 받은 보유종목을 기준으로 병합
          const mergedHoldingStocks: HoldingStock[] = []
          const processedCodes = new Set<string>()
          
          // 1. API 응답의 보유종목 추가
          newHoldingStocks.forEach(apiHolding => {
            mergedHoldingStocks.push(apiHolding)
            processedCodes.add(apiHolding.code)
          })
          
          // 2. 체결된 주문을 기반으로 보유종목 생성 (API에 없는 경우)
          // orderLogs state를 직접 참조할 수 없으므로, setOrderLogs를 사용하여 최신 값을 가져옴
          setOrderLogs(prevOrderLogs => {
            setDetectedStocks(prevDetectedStocks => {
              // 체결된 매수 주문 필터링
              const executedBuyOrders = prevOrderLogs.filter(order => 
                order.type === 'buy' && 
                (order.status === '체결' || order.status === '부분체결' || order.isExecuted)
              )
              
              // 종목별로 그룹화하여 보유종목 생성
              const ordersByStock = new Map<string, typeof executedBuyOrders>()
              executedBuyOrders.forEach(order => {
                if (!ordersByStock.has(order.stockCode)) {
                  ordersByStock.set(order.stockCode, [])
                }
                ordersByStock.get(order.stockCode)!.push(order)
              })
              
              ordersByStock.forEach((orders, stockCode) => {
                // 이미 API에서 받은 보유종목에 있으면 스킵
                if (processedCodes.has(stockCode)) {
                  console.log(`[보유종목 생성] ${orders[0].stockName} (${stockCode}): API에 이미 존재하여 스킵`)
                  return
                }
                
                // 체결된 수량 합계 계산
                let 총체결수량 = 0
                let 총매입금액 = 0
                
                orders.forEach(order => {
                  const 체결수량 = order.status === '부분체결' && order.unfilledQuantity !== undefined
                    ? order.quantity - order.unfilledQuantity
                    : order.quantity
                  
                  총체결수량 += 체결수량
                  총매입금액 += 체결수량 * (order.price || 0)
                })
                
                if (총체결수량 > 0) {
                  // 평균 매입가 계산
                  const 평균매입가 = 총매입금액 / 총체결수량
                  
                  // 현재가 조회 (실시간 시세 또는 detectedStocks에서)
                  const detectedStock = prevDetectedStocks.find(s => s.code === stockCode)
                  const 현재가 = detectedStock?.price || 평균매입가
                  
                  // 수익 계산
                  const 평가손익 = (현재가 - 평균매입가) * 총체결수량
                  const 수익률 = 평균매입가 > 0 ? ((현재가 - 평균매입가) / 평균매입가) * 100 : 0
                  
                  console.log(`[보유종목 생성] ${orders[0].stockName} (${stockCode}): 체결 주문 기반 생성 - 수량: ${총체결수량}주, 평균매입가: ${평균매입가.toLocaleString()}원, 현재가: ${현재가.toLocaleString()}원, 수익률: ${수익률.toFixed(2)}%`)
                  
                  mergedHoldingStocks.push({
                    code: stockCode,
                    name: orders[0].stockName,
                    quantity: 총체결수량,
                    purchasePrice: 평균매입가,
                    currentPrice: 현재가,
                    profit: 평가손익,
                    profitPercent: 수익률,
                    maxProfitPercent: 수익률 > 0 ? 수익률 : 0,
                  })
                  
                  processedCodes.add(stockCode)
                }
              })
              
              return prevDetectedStocks // detectedStocks는 변경하지 않음
            })
            
            return prevOrderLogs // orderLogs는 변경하지 않음
          })
          
          console.log(`[보유종목 병합] 완료 - API: ${newHoldingStocks.length}개, 체결 주문 기반: ${mergedHoldingStocks.length - newHoldingStocks.length}개, 최종: ${mergedHoldingStocks.length}개`)
          
          // 병합된 보유종목의 현재가를 체결된 주문에 동기화
          setOrderLogs(prevOrderLogs => {
            return prevOrderLogs.map(order => {
              if (order.type === 'buy' && 
                  (order.status === '체결' || order.status === '부분체결' || order.isExecuted)) {
                const holdingStock = mergedHoldingStocks.find(h => h.code === order.stockCode)
                if (holdingStock && holdingStock.currentPrice > 0) {
                  // 보유종목의 현재가로 주문의 현재가 업데이트
                  const 체결가격 = order.price || 0
                  const 체결수량 = order.status === '부분체결' && order.unfilledQuantity !== undefined
                    ? order.quantity - order.unfilledQuantity
                    : order.quantity
                  const 현재가 = holdingStock.currentPrice
                  const 수익 = (현재가 - 체결가격) * 체결수량
                  const 수익률 = 체결가격 > 0 ? ((현재가 - 체결가격) / 체결가격) * 100 : 0
                  
                  return {
                    ...order,
                    currentPrice: 현재가,
                    profit: 수익,
                    profitPercent: 수익률,
                  }
                }
              }
              return order
            })
          })
          
          // 병합된 보유종목으로 detectedStocks 업데이트
          setDetectedStocks(prev => {
            const updated = prev.map(stock => {
              const holdingStock = mergedHoldingStocks.find(h => h.code === stock.code)
              if (holdingStock && holdingStock.quantity > 0) {
                // 보유 종목인 경우 isHolding = true 설정 및 매수 정보 업데이트
                return {
                  ...stock,
                  isHolding: true,
                  purchasePrice: holdingStock.purchasePrice,
                  purchaseQuantity: holdingStock.quantity,
                  purchaseTime: stock.purchaseTime || new Date().toLocaleTimeString(),
                  maxProfitPercent: Math.max(stock.maxProfitPercent || 0, holdingStock.maxProfitPercent || holdingStock.profitPercent),
                }
              }
              return stock
            })
            
            // 계좌에 있지만 detectedStocks에 없는 종목 추가 (C# 코드의 로직과 동일)
            mergedHoldingStocks.forEach(holdingStock => {
              const exists = updated.find(s => s.code === holdingStock.code)
              if (!exists && holdingStock.quantity > 0) {
                updated.push({
                  code: holdingStock.code,
                  name: holdingStock.name,
                  price: holdingStock.currentPrice,
                  change: 0,
                  changePercent: holdingStock.profitPercent,
                  volume: 0,
                  detectedCondition: '계좌보유종목',
                  detectedTime: new Date().toLocaleTimeString(),
                  isHolding: true,
                  purchasePrice: holdingStock.purchasePrice,
                  purchaseQuantity: holdingStock.quantity,
                  purchaseTime: new Date().toLocaleTimeString(),
                  maxProfitPercent: holdingStock.maxProfitPercent || holdingStock.profitPercent,
                })
              }
            })
            
            return updated
          })
          
          // 병합된 보유종목으로 orderedOrHoldingStocks 업데이트
          setOrderedOrHoldingStocks(prev => {
            const updated = new Set(prev)
            // 보유 수량이 0보다 큰 종목만 추가
            mergedHoldingStocks.forEach(holdingStock => {
              if (holdingStock.quantity > 0) {
                updated.add(holdingStock.code)
              } else {
                // 보유 수량이 0이면 제거 (매도 완료)
                updated.delete(holdingStock.code)
              }
            })
            // 보유 종목에 없는 종목도 제거 (매도 완료된 종목)
            const holdingCodes = new Set(mergedHoldingStocks.map(h => h.code))
            prev.forEach(code => {
              if (!holdingCodes.has(code)) {
                updated.delete(code)
              }
            })
            return updated
          })
          
          // 병합된 보유종목으로 체결 확인 수행
          if (mergedHoldingStocks.length > 0) {
            console.log(`[보유종목 조회] 체결 확인 시작 - 보유종목: ${mergedHoldingStocks.length}개 (병합 후), 주문 내역 확인 중...`)
            
            setOrderLogs(prevOrderLogs => {
              return prevOrderLogs.map(order => {
                // 체결된 매수 주문이 보유종목에 있는지 확인
                if (order.type === 'buy' && 
                    (order.status === '체결' || order.isExecuted) &&
                    order.orderNumber) {
                  const holdingStock = mergedHoldingStocks.find(h => h.code === order.stockCode)
                  if (!holdingStock) {
                    // 체결되었지만 보유종목에 없는 경우 - 로그만 출력
                    console.log(`[보유종목 조회] 체결된 주문이지만 보유종목에 없음 - ${order.stockName} (${order.stockCode}), 주문수량: ${order.quantity}주`)
                  } else {
                    // 보유종목에 있으면 detectedStocks 업데이트 (이미 위에서 처리됨)
                    setOrderedOrHoldingStocks(prev => new Set(prev).add(order.stockCode))
                  }
                }
                
                // 미체결 매수 주문이고 보유 종목에 해당 종목이 있으면 체결된 것으로 처리
                if (order.type === 'buy' && 
                    (order.status === '접수' || order.status === '확인' || order.status === '미체결' || order.status === '부분체결') && 
                    !order.isExecuted &&
                    order.orderNumber) {
                  console.log(`[보유종목 조회] 체결 확인 중 - ${order.stockName} (${order.stockCode}), 주문수량: ${order.quantity}주, 상태: ${order.status}`)
                  const holdingStock = mergedHoldingStocks.find(h => h.code === order.stockCode)
                  if (holdingStock && holdingStock.quantity > 0) {
                    console.log(`[보유종목 조회] 보유종목 발견 - ${order.stockName} (${order.stockCode}), 보유수량: ${holdingStock.quantity}주, 주문수량: ${order.quantity}주`)
                    // 보유 종목에 있으면 체결 확인
                    // 시장가 주문의 경우 보유 수량이 0보다 크면 체결된 것으로 처리
                    // 지정가 주문의 경우 주문 수량과 보유 수량을 비교하여 체결 여부 확인
                    const isMarketOrder = order.isMarketOrder === true
                    const isFullyExecuted = holdingStock.quantity >= order.quantity
                    const isPartiallyExecuted = holdingStock.quantity > 0 && holdingStock.quantity < order.quantity
                    
                    if (isMarketOrder && holdingStock.quantity > 0) {
                      // 시장가 주문: 보유 수량이 0보다 크면 체결된 것으로 처리
                      if (isFullyExecuted) {
                        // 전량 체결
                        console.log(`[체결 확인] ${order.stockName} 매수 주문 전량 체결 확인 (보유 종목에 존재: ${holdingStock.quantity}주, 주문: ${order.quantity}주)`)
                        addLog(`[체결 확인] ${order.stockName} ${order.quantity}주 매수 체결 완료 (보유: ${holdingStock.quantity}주)`, 'success')
                      } else if (isPartiallyExecuted) {
                        // 부분 체결
                        console.log(`[부분 체결] ${order.stockName} 매수 주문 부분 체결 (보유: ${holdingStock.quantity}주, 주문: ${order.quantity}주)`)
                        addLog(`[부분 체결] ${order.stockName} ${holdingStock.quantity}주 매수 부분 체결 (주문: ${order.quantity}주)`, 'info')
                      }
                      
                      // 체결된 경우 orderLogs 업데이트
                      setDetectedStocks(prevStocks => {
                        return prevStocks.map(stock => 
                          stock.code === order.stockCode
                            ? {
                                ...stock,
                                isHolding: true,
                                purchasePrice: holdingStock.purchasePrice,
                                purchaseQuantity: holdingStock.quantity,
                                purchaseTime: order.time || new Date().toLocaleTimeString(),
                                maxProfitPercent: 0,
                              }
                            : stock
                        )
                      })
                      setOrderedOrHoldingStocks(prev => new Set(prev).add(order.stockCode))
                      
                      return {
                        ...order,
                        status: isFullyExecuted ? '체결' : '부분체결',
                        isExecuted: isFullyExecuted,
                      }
                    } else if (!isMarketOrder && isFullyExecuted) {
                      // 지정가 주문: 전량 체결만 확인
                      console.log(`[체결 확인] ${order.stockName} 매수 주문 전량 체결 확인 (보유 종목에 존재: ${holdingStock.quantity}주, 주문: ${order.quantity}주)`)
                      addLog(`[체결 확인] ${order.stockName} ${order.quantity}주 매수 체결 완료 (보유: ${holdingStock.quantity}주)`, 'success')
                      
                      setDetectedStocks(prevStocks => {
                        return prevStocks.map(stock => 
                          stock.code === order.stockCode
                            ? {
                                ...stock,
                                isHolding: true,
                                purchasePrice: holdingStock.purchasePrice,
                                purchaseQuantity: holdingStock.quantity,
                                purchaseTime: order.time || new Date().toLocaleTimeString(),
                                maxProfitPercent: 0,
                              }
                            : stock
                        )
                      })
                      setOrderedOrHoldingStocks(prev => new Set(prev).add(order.stockCode))
                      
                      return {
                        ...order,
                        status: '체결',
                        isExecuted: true,
                      }
                    }
                  }
                }
              
                return order
              })
            })
          }
          
          return mergedHoldingStocks
        })
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
  const { data: ordersData, refetch: refetchOrders } = useQuery(
    ['orders', selectedAccount],
    () => {
      if (!selectedAccount) return Promise.resolve([])
      return kiwoomApi.getOrderHistory(selectedAccount)
    },
    {
      enabled: connected && !!selectedAccount,
      refetchInterval: isRunning ? 8000 : 20000, // 미체결 자동취소가 서버 주문을 볼 수 있도록 상시 조회
      onSuccess: (data) => {
        console.log(`[주문 내역] UI 업데이트 - 받은 데이터 개수: ${Array.isArray(data) ? data.length : 0}`)
        if (Array.isArray(data)) {
          // API에서 주문 내역을 받아온 경우
          if (data.length > 0) {
            // API에서 주문 내역이 있으면 병합 (로컬 주문과 API 주문 병합)
            const mappedOrders = data.map((order: any, idx: number) => {
              // 주문 상태 확인 및 체결 여부 판단
              const orderStatus = order.status || order.주문상태 || '접수'
              // 체결 상태 확인: '체결', '전량체결', '부분체결' 등은 체결된 것으로 판단
              const isExecuted = orderStatus.includes('체결') || orderStatus === '완료' || orderStatus === '체결완료' || orderStatus === '부분체결'
              // 취소 상태 확인
              const isCancelled = orderStatus === '취소' || order.type === 'cancel'
              
              // 주문 시간을 기반으로 orderTimestamp 추정
              const orderDate = order.date || new Date().toLocaleDateString('ko-KR')
              const orderTime = order.time || new Date().toLocaleTimeString('ko-KR')
              let orderTimestamp: number | undefined = undefined
              try {
                // 날짜와 시간을 합쳐서 타임스탬프 계산
                const dateTimeStr = `${orderDate} ${orderTime}`
                const parsedDate = new Date(dateTimeStr)
                if (!isNaN(parsedDate.getTime())) {
                  orderTimestamp = parsedDate.getTime()
                }
              } catch (e) {
                // 파싱 실패 시 현재 시간 사용 (최악의 경우)
                orderTimestamp = Date.now()
              }
              
              // 취소된 주문의 경우 취소 시점 기록 (API에서 받은 취소 주문은 현재 시간을 취소 시점으로 설정)
              let cancelTimestamp: number | undefined = undefined
              if (isCancelled) {
                cancelTimestamp = Date.now() // API에서 받은 취소 주문은 현재 시간을 취소 시점으로 설정
              }
              
              return {
                id: order.id || idx,
                date: orderDate,
                time: orderTime,
                type: order.type || (isCancelled ? 'cancel' : 'buy'),
                stockName: order.stockName || order.종목명 || '',
                stockCode: order.stockCode || order.종목코드 || '',
                quantity: order.quantity || order.수량 || 0,
                price: order.price || order.가격 || 0,
                status: orderStatus,
                orderNumber: order.orderNumber || order.주문번호,
                isExecuted, // 체결 여부 플래그 추가
                orderTimestamp, // 주문 접수 시점 (API에서 받은 주문의 경우 추정값)
                cancelTimestamp, // 취소 시점 (취소된 주문인 경우)
                // 지정가 여부: 서버가 orderPrice(주문가)를 주면 지정가 주문이다.
                // 이 값이 없으면 자동취소가 지정가를 구분하지 못해 체결 전에 취소한다.
                isMarketOrder: (Number(order.orderPrice) || 0) <= 0,
                orderPrice: Number(order.orderPrice) || 0,
              }
            })
            console.log(`[주문 내역] API에서 받은 주문 개수: ${mappedOrders.length}`)
            
            // 주문한 종목코드 추출 (매수 주문만, 체결되지 않은 주문 포함)
            const orderedStockCodes = new Set(
              mappedOrders
                .filter((o: any) => o.type === 'buy' && o.stockCode)
                .map((o: any) => o.stockCode)
            )
            
            // 주문한 종목을 검색된 종목에서 제거 (주문 내역에 있는 종목은 검색된 종목에 표시하지 않음)
            if (orderedStockCodes.size > 0) {
              setDetectedStocks(prev => {
                const filtered = prev.filter(s => !orderedStockCodes.has(s.code))
                if (filtered.length !== prev.length) {
                  console.log(`[검색된 종목] 주문 내역의 종목 제거 - ${prev.length - filtered.length}개 종목 제거됨, 남은 종목: ${filtered.length}개`)
                }
                return filtered
              })
            }
            
            // 기존 로컬 주문 내역과 병합 (중복 제거: 주문번호 기준)
            // 체결된 주문은 항상 유지 (API 응답에 없어도 로컬 주문 유지)
            setOrderLogs(prev => {
              const orderNumberSet = new Set(mappedOrders.map((o: any) => o.orderNumber).filter(Boolean))
              
              // 로컬 주문 분류:
              // 1. 체결된 주문: 항상 유지 (API 응답에 없어도)
              // 2. 미체결 주문: API 주문번호에 없으면 유지 (주문번호가 없는 경우도 유지)
              const localOrders = prev.filter(o => {
                // 체결된 주문은 항상 유지
                if (o.isExecuted) {
                  return true
                }
                // 주문번호가 없거나 API 주문번호에 없는 로컬 주문 유지
                return !o.orderNumber || !orderNumberSet.has(o.orderNumber)
              })
              
              // 로컬 주문의 상태도 업데이트 (API에서 받은 주문 상태로 업데이트)
              const updatedLocalOrders = localOrders.map(localOrder => {
                // 체결된 주문은 API 응답과 관계없이 유지
                if (localOrder.isExecuted) {
                  // API에서 같은 주문번호의 주문이 있으면 상태만 업데이트 (체결 상태는 유지)
                  const apiOrder = mappedOrders.find((o: any) => o.orderNumber === localOrder.orderNumber)
                  if (apiOrder) {
                    return {
                      ...localOrder,
                      status: apiOrder.status || localOrder.status, // API 상태가 있으면 업데이트, 없으면 기존 상태 유지
                      isExecuted: true, // 체결 상태는 항상 유지
                    }
                  }
                  // API 응답에 없어도 체결된 주문은 그대로 유지
                  return localOrder
                }
                
                // 미체결 주문은 API 주문 상태로 업데이트
                const apiOrder = mappedOrders.find((o: any) => o.orderNumber === localOrder.orderNumber)
                if (apiOrder) {
                  const isCancelled = apiOrder.status === '취소' || apiOrder.type === 'cancel'
                  const updatedOrder = {
                    ...localOrder,
                    status: apiOrder.status,
                    isExecuted: apiOrder.isExecuted,
                    type: isCancelled ? ('cancel' as const) : localOrder.type,
                  }
                  // 취소된 주문이고 아직 cancelTimestamp가 없으면 현재 시간을 취소 시점으로 설정
                  if (isCancelled && !localOrder.cancelTimestamp) {
                    return {
                      ...updatedOrder,
                      cancelTimestamp: Date.now(),
                    }
                  }
                  return updatedOrder
                }
                return localOrder
              })
              
              // API 주문과 로컬 주문 병합 (중복 제거: 주문번호 기준, 로컬 주문 우선)
              const mergedMap = new Map<string, OrderLog>()
              
              // 주문 고유 키 생성 함수 (중복 제거용)
              const getOrderKey = (order: any) => {
                if (order.orderNumber) {
                  return `order_${order.orderNumber}`
                }
                // 주문번호가 없는 경우 종목코드 + 수량 + 가격 + 타입 + 시간 조합으로 키 생성
                const timeKey = `${order.date}_${order.time}`.replace(/[^0-9]/g, '')
                return `${order.stockCode}_${order.quantity}_${order.price}_${order.type}_${timeKey}`
              }
              
              // 먼저 로컬 주문 추가 (우선순위 높음)
              updatedLocalOrders.forEach(order => {
                const key = getOrderKey(order)
                mergedMap.set(key, order)
              })
              
              // API 주문 추가 (로컬 주문에 없는 경우만)
              mappedOrders.forEach((apiOrder: any) => {
                const key = getOrderKey(apiOrder)
                if (!mergedMap.has(key)) {
                  mergedMap.set(key, apiOrder)
                }
              })
              
              let merged = Array.from(mergedMap.values())
              
              // 추가 중복 제거: 완전히 동일한 주문 제거 (종목코드 + 수량 + 가격 + 타입 + 상태가 같으면 중복)
              const uniqueOrders = new Map<string, OrderLog>()
              merged.forEach(order => {
                const uniqueKey = `${order.stockCode}_${order.stockName}_${order.quantity}_${order.price}_${order.type}_${order.status}`
                if (!uniqueOrders.has(uniqueKey)) {
                  uniqueOrders.set(uniqueKey, order)
                } else {
                  // 중복이면 주문번호가 있는 것을 우선
                  const existing = uniqueOrders.get(uniqueKey)!
                  if (order.orderNumber && !existing.orderNumber) {
                    uniqueOrders.set(uniqueKey, order)
                  }
                }
              })
              
              merged = Array.from(uniqueOrders.values())
              
              // 시간순 정렬 (최신순)
              merged.sort((a, b) => {
                const timeA = new Date(`${a.date} ${a.time}`).getTime()
                const timeB = new Date(`${b.date} ${b.time}`).getTime()
                return timeB - timeA
              })
              
              // 체결된 주문이 있는지 확인하여 로그 출력
              const executedOrders = merged.filter((o: any) => o.isExecuted)
              if (executedOrders.length > 0) {
                console.log(`[주문 내역 병합] 체결된 주문 ${executedOrders.length}개 유지됨`)
                executedOrders.forEach((order: any) => {
                  console.log(`[체결 확인] ${order.stockName} ${order.quantity}주 ${order.type === 'buy' ? '매수' : '매도'} 체결 완료 (주문번호: ${order.orderNumber || '없음'})`)
                })
              }
              
              console.log(`[주문 내역 병합] API: ${mappedOrders.length}개, 로컬: ${updatedLocalOrders.length}개, 병합 후: ${merged.length}개`)
              
              return merged
            })
          } else {
            // API에서 빈 배열이 반환되면 기존 로컬 주문 내역 유지 (덮어쓰지 않음)
            // orderLogs는 클로저로 접근할 수 없으므로, setOrderLogs를 호출하지 않음
            console.log(`[주문 내역] API에서 빈 배열 반환 - 기존 로컬 주문 내역 유지 (setOrderLogs 호출 안 함)`)
            // setOrderLogs는 호출하지 않음 (기존 상태 유지)
          }
        } else {
          console.log(`[주문 내역] 데이터가 배열이 아님:`, typeof data)
          // 데이터가 배열이 아니어도 기존 로컬 주문 내역 유지
        }
      },
      onError: (error: any) => {
        console.error(`[주문 내역] 조회 실패:`, error.response?.data || error.message)
      },
    }
  )

  // 로그 추가
  // C# 코드의 SaveTradingState / LoadTradingState와 동일한 기능
  // 보유 종목 상태 및 주문 내역 저장 (C# 코드의 SaveTradingState와 동일)
  const saveTradingState = useCallback(() => {
    try {
      const holdingStocksData = detectedStocks
        .filter(stock => stock.isHolding)
        .map(stock => ({
          종목코드: stock.code,
          종목명: stock.name,
          매수가격: stock.purchasePrice || 0,
          매수수량: stock.purchaseQuantity || 0,
          매수시간: stock.purchaseTime || new Date().toLocaleTimeString(),
          최고수익률: stock.maxProfitPercent || 0,
          스캘핑매수여부: stock.isScalpingBuy || false,
          볼린저매수여부: stock.isBollingerBuy || false,
          돌파매수여부: stock.isBreakoutBuy || false,
          패턴매수여부: stock.isPatternBuy || false,
        }))
      
      // 체결된 주문만 저장 (서버 재시작 후에도 유지)
      const executedOrders = orderLogs
        .filter(order => order.isExecuted || order.status === '체결' || order.status === '부분체결')
        .map(order => ({
          id: order.id,
          date: order.date,
          time: order.time,
          type: order.type,
          stockName: order.stockName,
          stockCode: order.stockCode,
          quantity: order.quantity,
          price: order.price,
          status: order.status,
          orderNumber: order.orderNumber,
          isExecuted: order.isExecuted,
          orderTimestamp: order.orderTimestamp,
          unfilledQuantity: order.unfilledQuantity,
          currentPrice: order.currentPrice,
          profit: order.profit,
          profitPercent: order.profitPercent,
          buyPrice: order.buyPrice,
        }))
      
      const tradingState = {
        보유종목정보: holdingStocksData,
        체결주문내역: executedOrders,
        저장시간: new Date().toISOString(),
      }
      
      localStorage.setItem('trading_state', JSON.stringify(tradingState))
      console.log(`[보유 종목 상태 저장] ${holdingStocksData.length}개 종목, ${executedOrders.length}개 체결 주문 저장 완료`)
    } catch (error: any) {
      console.error(`[보유 종목 상태 저장 실패]:`, error.message)
      addLog(`매매 상태 저장 실패: ${error.message}`, 'error')
    }
  }, [detectedStocks, orderLogs])
  
  // 보유 종목 상태 복원 (C# 코드의 LoadTradingState와 동일)
  const loadTradingState = useCallback(() => {
    try {
      const savedState = localStorage.getItem('trading_state')
      if (!savedState) {
        return
      }
      
      const tradingState = JSON.parse(savedState)
      if (!tradingState.보유종목정보 || !Array.isArray(tradingState.보유종목정보)) {
        return
      }
      
      console.log(`[보유 종목 상태 복원] ${tradingState.보유종목정보.length}개 종목 복원 시작`)
      
      // 체결된 주문 내역 복원
      if (tradingState.체결주문내역 && Array.isArray(tradingState.체결주문내역) && tradingState.체결주문내역.length > 0) {
        console.log(`[주문 내역 복원] ${tradingState.체결주문내역.length}개 체결 주문 복원 시작`)
        
        setOrderLogs(prev => {
          // 주문 고유 키 생성 함수 (중복 제거용)
          const getOrderKey = (order: any) => {
            if (order.orderNumber) {
              return `order_${order.orderNumber}`
            }
            // 주문번호가 없는 경우 종목코드 + 수량 + 가격 + 타입 + 시간 조합으로 키 생성
            const timeKey = `${order.date}_${order.time}`.replace(/[^0-9]/g, '')
            return `${order.stockCode}_${order.quantity}_${order.price}_${order.type}_${timeKey}`
          }
          
          // 기존 주문과 복원된 주문 병합 (중복 제거)
          const orderMap = new Map<string, OrderLog>()
          
          // 기존 주문 추가 (우선순위 높음)
          prev.forEach(order => {
            const key = getOrderKey(order)
            orderMap.set(key, order)
          })
          
          // 복원된 주문 추가 (기존 주문과 중복되지 않는 경우만)
          tradingState.체결주문내역.forEach((order: any) => {
            const key = getOrderKey(order)
            if (!orderMap.has(key)) {
              orderMap.set(key, {
                id: order.id,
                date: order.date,
                time: order.time,
                type: order.type,
                stockName: order.stockName,
                stockCode: order.stockCode,
                quantity: order.quantity,
                price: order.price,
                status: order.status,
                orderNumber: order.orderNumber,
                isExecuted: order.isExecuted,
                orderTimestamp: order.orderTimestamp,
                unfilledQuantity: order.unfilledQuantity,
                currentPrice: order.currentPrice,
                profit: order.profit,
                profitPercent: order.profitPercent,
                buyPrice: order.buyPrice,
              })
            }
          })
          
          let merged = Array.from(orderMap.values())
          
          // 추가 중복 제거: 완전히 동일한 주문 제거 (종목코드 + 수량 + 가격 + 타입 + 상태가 같으면 중복)
          const uniqueOrders = new Map<string, OrderLog>()
          merged.forEach(order => {
            const uniqueKey = `${order.stockCode}_${order.stockName}_${order.quantity}_${order.price}_${order.type}_${order.status}`
            if (!uniqueOrders.has(uniqueKey)) {
              uniqueOrders.set(uniqueKey, order)
            } else {
              // 중복이면 주문번호가 있는 것을 우선
              const existing = uniqueOrders.get(uniqueKey)!
              if (order.orderNumber && !existing.orderNumber) {
                uniqueOrders.set(uniqueKey, order)
              }
            }
          })
          
          merged = Array.from(uniqueOrders.values())
          
          // 시간순 정렬 (최신순)
          merged.sort((a, b) => {
            const timeA = new Date(`${a.date} ${a.time}`).getTime()
            const timeB = new Date(`${b.date} ${b.time}`).getTime()
            return timeB - timeA
          })
          
          console.log(`[주문 내역 복원] 완료 - 기존: ${prev.length}개, 복원: ${tradingState.체결주문내역.length}개, 병합 후: ${merged.length}개`)
          
          return merged
        })
        
        addLog(`체결 주문 ${tradingState.체결주문내역.length}개 복원 완료`, 'info')
      }
      
      // 복원할 종목 목록
      const restoredStocks: DetectedStock[] = []
      const restoredCodes = new Set<string>()
      
      tradingState.보유종목정보.forEach((savedItem: any) => {
        restoredCodes.add(savedItem.종목코드)
        
        // 새로운 종목 정보 생성 (계좌에 있지만 detectedStocks에 없는 경우)
        const newStock: DetectedStock = {
          code: savedItem.종목코드,
          name: savedItem.종목명,
          price: 0, // 복원 시에는 가격 정보가 없으므로 0으로 설정 (계좌 조회 시 업데이트됨)
          change: 0,
          changePercent: 0,
          volume: 0,
          detectedCondition: '계좌보유종목',
          detectedTime: savedItem.매수시간,
          isHolding: true,
          purchasePrice: savedItem.매수가격,
          purchaseQuantity: savedItem.매수수량,
          purchaseTime: savedItem.매수시간,
          maxProfitPercent: savedItem.최고수익률,
          isScalpingBuy: savedItem.스캘핑매수여부,
          isBollingerBuy: savedItem.볼린저매수여부,
          isBreakoutBuy: savedItem.돌파매수여부,
          isPatternBuy: savedItem.패턴매수여부,
        }
        
        restoredStocks.push(newStock)
        addLog(`보유종목 정보 복원: ${savedItem.종목명}`, 'info')
      })
      
      // 기존 detectedStocks와 병합 (기존 종목이면 업데이트, 없으면 추가)
      setDetectedStocks(prev => {
        const updated = prev.map(stock => {
          const restoredStock = restoredStocks.find(s => s.code === stock.code)
          if (restoredStock) {
            return {
              ...stock,
              isHolding: true,
              purchasePrice: restoredStock.purchasePrice,
              purchaseQuantity: restoredStock.purchaseQuantity,
              purchaseTime: restoredStock.purchaseTime,
              maxProfitPercent: restoredStock.maxProfitPercent,
              isScalpingBuy: restoredStock.isScalpingBuy,
              isBollingerBuy: restoredStock.isBollingerBuy,
              isBreakoutBuy: restoredStock.isBreakoutBuy,
              isPatternBuy: restoredStock.isPatternBuy,
            }
          }
          return stock
        })
        
        // 새로운 종목 추가 (기존에 없던 종목)
        restoredStocks.forEach(restoredStock => {
          if (!updated.find(s => s.code === restoredStock.code)) {
            updated.push(restoredStock)
          }
        })
        
        return updated
      })
      
      // 매수주문했거나보유중인종목에 추가
      setOrderedOrHoldingStocks(prev => {
        const updated = new Set(prev)
        restoredCodes.forEach(code => updated.add(code))
        return updated
      })
      
      console.log(`[보유 종목 상태 복원] 완료`)
    } catch (error: any) {
      console.error(`[보유 종목 상태 복원 실패]:`, error.message)
      addLog(`매매 상태 복원 실패: ${error.message}`, 'error')
    }
  }, []) // 빈 배열로 한 번만 실행
  
  // 보유 종목 상태 또는 체결 주문이 변경될 때마다 저장
  useEffect(() => {
    if (detectedStocks.some(s => s.isHolding) || orderLogs.some(o => o.isExecuted)) {
      saveTradingState()
    }
  }, [detectedStocks, orderLogs, saveTradingState])
  
  // 컴포넌트 마운트 시 보유 종목 상태 복원
  useEffect(() => {
    loadTradingState()
  }, []) // 빈 배열로 한 번만 실행
  
  // 날짜 변경 감지 및 오늘의 실현손익 초기화
  useEffect(() => {
    const checkDateChange = () => {
      const today = dateKey()
      const savedDate = localStorage.getItem('today_realized_profit_date')

      // 날짜 비교는 숫자만으로 한다.
      // 이전 버전은 "2026. 11. 26." 형식으로 저장했으므로 문자열 그대로 비교하면
      // 같은 날인데도 '날짜 변경'으로 오판해 매분 0으로 초기화된다.
      const savedDigits = String(savedDate || '').replace(/[^0-9]/g, '')
      const todayDigits = today.replace(/[^0-9]/g, '')

      // 저장값이 없거나 손상됐으면 초기화하지 않고 오늘 날짜만 기록한다
      if (!savedDigits) {
        localStorage.setItem('today_realized_profit_date', today)
        return
      }

      if (savedDigits !== todayDigits) {
        console.log(`[날짜 변경 감지] ${savedDate} → ${today}, 오늘의 실현손익 초기화`)
        setTodayTotalRealizedProfit(0)
        localStorage.setItem('today_realized_profit', '0')
        localStorage.setItem('today_realized_profit_date', today)
        // 서버에도 0으로 반영해야 다른 기기에서도 초기화된다
        saveRealizedProfitToServer(0, today)
      } else if (savedDate !== today) {
        // 같은 날짜인데 형식만 다르면 새 형식으로 교체한다 (초기화 금지)
        localStorage.setItem('today_realized_profit_date', today)
      }
    }
    
    // 1분마다 날짜 변경 체크
    const intervalId = setInterval(checkDateChange, 60000)
    
    // 컴포넌트 마운트 시에도 한 번 체크
    checkDateChange()
    
    return () => clearInterval(intervalId)
  }, [])
  
  /** 오늘 실현손익을 서버에 저장한다 (라이선스 키 단위) */
  // 저장 요청이 진행 중인 동안에는 서버 재조회 결과를 무시한다.
  // (누적 직후 GET이 먼저 도착해 이전 값으로 되돌리는 경쟁 조건 방지)
  const saveInFlightRef = useRef<number>(0)
  const saveRealizedProfitToServer = async (amount: number, date?: string) => {
    saveInFlightRef.current += 1
    try {
      await apiClient.put('/state/today_realized_profit', {
        value: { amount, date: date || dateKey() },
      })
    } catch (error: any) {
      // 저장 실패는 조용히 넘긴다 (localStorage 캐시는 유지)
      if (process.env.NODE_ENV === 'development') {
        console.warn('[실현손익] 서버 저장 실패:', error.message)
      }
    } finally {
      saveInFlightRef.current = Math.max(0, saveInFlightRef.current - 1)
    }
  }

  // 앱 시작 시 서버에서 오늘 실현손익을 불러온다.
  // localStorage는 캐시일 뿐이라 다른 기기/Railway 도메인에서는 비어 있다.
  //
  // keyInfo(라이선스 검증 결과)가 의존성인 이유:
  // 앱 시작 직후에는 HttpOnly 세션 쿠키가 아직 없어 401이 난다.
  // 라이선스 검증(/api/auth/validate-key)이 끝나 쿠키가 심어진 뒤에 다시 조회해야 한다.
  useEffect(() => {
    if (!keyInfo) return
    let cancelled = false
    ;(async () => {
      try {
        // 저장 요청이 진행 중이면 서버 값을 덮어쓰지 않는다
        // (누적 직후 GET이 먼저 도착해 이전 값으로 되돌리는 경쟁 조건 방지)
        if (saveInFlightRef.current > 0) return

        const response = await apiClient.get('/state/today_realized_profit')
        const value = response.data?.value
        if (cancelled || !value) return

        const today = dateKey()
        // 저장된 날짜가 오늘인지 확인한다.
        // 예전 버전은 "2026. 11. 26." 형식으로 저장했으므로 숫자만 비교한다.
        const savedDigits = String(value.date || '').replace(/[^0-9]/g, '')
        const todayDigits = today.replace(/[^0-9]/g, '')
        if (savedDigits && savedDigits !== todayDigits) return

        const amount = Number(value.amount)
        if (!Number.isFinite(amount)) return

        setTodayTotalRealizedProfit(amount)
        // 다음 오프라인 표시를 위해 캐시도 갱신
        localStorage.setItem('today_realized_profit', String(amount))
        localStorage.setItem('today_realized_profit_date', today)
      } catch {
        // 서버 조회 실패 시 localStorage 캐시를 그대로 쓴다
      }
    })()
    return () => {
      cancelled = true
    }
  }, [keyInfo])

  // 매도 체결 → 오늘 실현손익 누적
  //
  // 단일 집계 지점이다. WebSocket onmessage/setOrderLogs 업데이터 안에서
  // setState를 중첩하면 React 배치 처리로 누락·중복이 생기므로 여기서만 누적한다.
  // realizedCountedRef로 같은 주문이 두 번 집계되지 않게 막는다.
  const realizedCountedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const settled = orderLogs.filter(order =>
      order.type === 'sell' &&
      (order.status === '체결' || order.status === '부분체결' || order.isExecuted === true)
    )
    if (settled.length === 0) return

    let added = 0
    for (const order of settled) {
      const key = order.orderNumber || `${order.stockCode}_${order.time}_${order.quantity}`
      if (realizedCountedRef.current.has(key)) continue

      // WebSocket이 이미 계산해 둔 값이 있으면 그대로 쓴다.
      // 단, 계산 버그로 -100%(매도가 0) 같은 값이 들어올 수 있으므로
      // 수익률이 비정상(±100% 초과)이면 신뢰하지 않고 아래에서 재계산한다.
      if (order.realizedProfit !== undefined) {
        const pct = order.realizedProfitPercent
        const isSane = pct === undefined || (Number.isFinite(pct) && pct > -100 && pct < 1000)
        if (isSane) {
          realizedCountedRef.current.add(key)
          added += order.realizedProfit
          continue
        }
        console.warn(
          `[실현손익 무시] ${order.stockName}: 비정상 수익률 ${pct?.toFixed?.(2)}% ` +
          `(실현손익 ${order.realizedProfit.toLocaleString()}원) — 재계산합니다`
        )
      }

      // 매수가를 찾는다.
      // 1순위: 주문에 저장된 buyPrice (주문 생성 시점의 잔고 평균단가)
      // 2순위: 보유종목의 평균단가 (buyPrice가 0으로 저장되는 경우가 있다)
      // 3순위: 매입금액 ÷ 수량
      // 4순위: 같은 종목의 매수 주문 로그
      const held = holdingStocksRef.current.find(h => h.code === order.stockCode)
      const logBuy = orderLogs.find(o => o.type === 'buy' && o.stockCode === order.stockCode)
      const 매수가 = resolveBuyPrice(order.buyPrice, held, logBuy?.price)
      // 매도가: 주문가가 0(시장가)이면 체결 당시 현재가 → 잔고 현재가 순으로 보강
      const 매도가 = resolveExecutedPrice(0, order, held?.currentPrice)

      // 가격을 알 수 없으면 집계하지 않고 다음 기회에 다시 시도한다
      // (매도가 0을 그대로 쓰면 -100% 같은 엉터리 값이 누적된다)
      if (!isValidTradePrice(매수가) || !isValidTradePrice(매도가)) {
        console.warn(
          `[실현손익] ${order.stockName} 가격 미확정으로 건너뜀 ` +
          `(매수가=${매수가}, 매도가=${매도가}, buyPrice=${order.buyPrice}, 주문가=${order.price}, ` +
          `주문당시=${order.currentPrice}, 잔고현재가=${held?.currentPrice})`
        )
        continue
      }

      realizedCountedRef.current.add(key)
      added += (매도가 - 매수가) * order.quantity
    }
    if (added === 0) return

    setTodayTotalRealizedProfit(prev => {
      const newTotal = prev + added
      const today = dateKey()
      localStorage.setItem('today_realized_profit', newTotal.toString())
      localStorage.setItem('today_realized_profit_date', today)
      // 서버에도 누적값을 저장해야 다른 기기에서도 같은 값이 보인다
      void saveRealizedProfitToServer(newTotal, today)
      console.log(`[실현손익 누적] +${added.toLocaleString()}원, 오늘 총 실현손익: ${newTotal.toLocaleString()}원`)
      return newTotal
    })
  // holdingStocks도 의존성에 넣는다.
  // 매도 체결 직후에는 buyPrice가 비어 있을 수 있고, 잔고가 나중에 도착하면
  // 그때 평균단가로 실현손익을 계산할 수 있다.
  }, [orderLogs, holdingStocks])

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
  const detectedStocksRef = useRef<DetectedStock[]>([])
  
  useEffect(() => {
    displayedStockCountRef.current = displayedStockCount
  }, [displayedStockCount])
  
  useEffect(() => {
    detectedStocksLengthRef.current = detectedStocks.length
    detectedStocksRef.current = detectedStocks // 최신 detectedStocks를 ref에 저장
  }, [detectedStocks])

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
    // 연결 상태 확인 (종목 유무와 무관하게 연결해 둔다. 종목은 나중에 생길 수 있고,
    // 종목이 없다고 여기서 return 하면 이후 종목이 추가돼도 WS가 영영 열리지 않는다)
    if (!isConnected || !connected) {
      return
    }

    let ws: WebSocket | null = null
    let isMounted = true

    const connectWebSocket = async () => {
      try {
        // 서버의 WebSocket에 연결 (Vite 프록시를 통해 /ws 경로로 연결)
        // 세션 인증은 HttpOnly 쿠키로 이뤄진다 (URL에 키를 넣지 않는다 — 로그에 남는다)
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsHost = window.location.host
        const wsUrl = `${wsProtocol}//${wsHost}/ws`
        ws = new WebSocket(wsUrl)

        ws.onopen = async () => {
          console.log('[실시간 시세] WebSocket 연결 성공')
          
          // 서버에 WebSocket 연결 요청 (키움증권 WebSocket 연결)
          try {
            await kiwoomApi.connectWebSocket()
            console.log('[실시간 시세] 키움 WebSocket 연결 완료')
          } catch (error: any) {
            console.error('[실시간 시세] 서버 WebSocket 연결 실패:', error.message)
          }

          // 재연결일 수 있으므로 캡처된 스냅샷이 아닌 최신 종목을 등록한다
          const currentCodes = detectedStocksRef.current.map(stock => stock.code)
          if (currentCodes.length > 0) {
            try {
              await kiwoomApi.registerRealTimeStocks(currentCodes)
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
                // 0B: 주식체결(시세), 00: 내 계좌 주문체결 — FID 의미가 다르다
                if ((item.type === '00' || item.type === '0B') && item.values && item.item) {
                  // 주식체결 데이터 파싱
                  const code = item.item
                  const values = item.values
                  
                  // FID 값 파싱 (키움증권 실시간 시세 필드)
                  // '10': 현재가, '11': 전일대비, '12': 등락률, '13': 누적거래량
                  const currentPrice = Math.abs(parseFloat((values['10'] || '0').replace(/[+\s]/g, '')) || 0)
                  const change = parseFloat((values['11'] || '0').replace(/[+\s]/g, '')) || 0
                  const changePercent = parseFloat((values['12'] || '0').replace(/[+\s]/g, '')) || 0
                  const volume = parseFloat(values['13'] || '0') || 0
                  
                  // 체결 정보 파싱 (00 주문체결 전용 FID)
                  // '900': 주문수량, '901': 주문가격, '902': 미체결수량, '910': 체결가(평균), '911': 누적체결량, '913': 주문상태
                  const orderQuantity = parseInt(values['900'] || '0') || 0
                  const filledQuantity = parseInt(values['911'] || '0') || 0 // 누적 체결수량
                  const unfilledQuantity = parseInt(values['902'] || '0') || 0
                  const executedPrice = Math.abs(parseFloat((values['910'] || '0').replace(/[+\s]/g, '')) || 0)
                  const orderType = values['905'] || '' // "+매수" 또는 "-매도"
                  const orderOption = values['906'] || '' // "시장가", "지정가" 등
                  const orderStatus = values['913'] || '' // 접수, 체결, 확인, 취소, 거부
                  
                  // 실제 체결수량 계산 (누적 체결량 우선, 없으면 주문수량 - 미체결수량)
                  const actualFilledQuantity = filledQuantity > 0
                    ? filledQuantity
                    : orderQuantity > 0
                      ? orderQuantity - unfilledQuantity
                      : 0
                  
                  // 디버깅: 체결 정보 로그 출력
                  if (orderQuantity > 0) {
                    console.log(`[체결 정보 파싱] 종목코드: ${code}, 주문상태: ${orderStatus}, 주문수량: ${orderQuantity}, 체결수량: ${filledQuantity}, 실제체결수량: ${actualFilledQuantity}, 미체결수량: ${unfilledQuantity}, 체결가: ${executedPrice}, 주문구분: ${orderType} ${orderOption}`)
                  }

                  // 시세(현재가/등락률/거래량) 갱신은 0B(주식체결)일 때만 한다.
                  // 00(주문체결)에는 등락률·누적거래량이 없어 0으로 덮어쓰게 된다.
                  const isMarketTick = item.type === '0B'

                  if (isMarketTick && currentPrice > 0 && isMounted) {
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

                    // 보유종목 실시간 가격 업데이트 및 수익률 재계산
                    setHoldingStocks(prevHolding => {
                      if (prevHolding.length === 0) return prevHolding
                      
                      let updated = false
                      const result = prevHolding.map(stock => {
                        if (stock.code === code) {
                          const profit = (currentPrice - stock.purchasePrice) * stock.quantity
                          const profitPercent = stock.purchasePrice > 0 
                            ? ((currentPrice - stock.purchasePrice) / stock.purchasePrice) * 100 
                            : 0
                          updated = true
                          console.log(`[실시간 시세] ${stock.name} 가격 업데이트: ${stock.currentPrice.toLocaleString()} → ${currentPrice.toLocaleString()}원, 수익률: ${profitPercent.toFixed(2)}%`)
                          return {
                            ...stock,
                            currentPrice: currentPrice,
                            profit: profit,
                            profitPercent: profitPercent,
                          }
                        }
                        return stock
                      })
                      
                      if (updated) {
                        const 총평가금액 = result.reduce((sum, s) => sum + (s.currentPrice * s.quantity), 0)
                        const 총평가손익 = result.reduce((sum, s) => sum + s.profit, 0)
                        console.log(`[계좌 요약 업데이트] 총평가금액: ${총평가금액.toLocaleString()}원, 총평가손익: ${총평가손익.toLocaleString()}원`)
                      }
                      
                      return result
                    })

                    // 체결된 주문의 실시간 가격 업데이트 (매수 주문만, 부분체결 포함)
                    setOrderLogs(prevOrders => {
                      let updated = false
                      const result = prevOrders.map(order => {
                        if (order.stockCode === code && 
                            order.type === 'buy' && 
                            (order.status === '체결' || order.status === '부분체결' || order.isExecuted)) {
                          // 체결된 매수 주문의 현재가와 수익률 업데이트
                          const 체결가격 = order.price || 0
                          // 부분체결인 경우 체결된 수량 계산 (미체결수량이 있으면 주문수량 - 미체결수량)
                          const 체결수량 = order.status === '부분체결' && order.unfilledQuantity !== undefined
                            ? order.quantity - order.unfilledQuantity
                            : order.quantity
                          const 현재가 = currentPrice
                          const 수익 = (현재가 - 체결가격) * 체결수량
                          const 수익률 = 체결가격 > 0 ? ((현재가 - 체결가격) / 체결가격) * 100 : 0
                          
                          if (order.currentPrice !== 현재가) {
                            updated = true
                            console.log(`[주문 내역 업데이트] ${order.stockName}: 현재가 ${현재가.toLocaleString()}원, 수익률 ${수익률.toFixed(2)}%`)
                          }
                          
                          return {
                            ...order,
                            currentPrice: 현재가,
                            profit: 수익,
                            profitPercent: 수익률,
                          }
                        }
                        return order
                      })
                      
                      return result
                    })
                  }
                  
                  // WebSocket 체결 정보를 즉시 반영하여 체결 상태 업데이트
                  // 미체결수량이 줄어들거나 체결수량이 있으면 체결로 판단
                  // FID 900은 총 보유 수량일 수 있으므로, 실제 주문 수량과 비교해야 함
                  // 체결 정보 반영은 00(내 계좌 주문체결)에서만
                  if (item.type === '00' && orderQuantity > 0 && isMounted) {
                    console.log(`[WebSocket 체결 정보] 종목코드: ${code}, 총보유수량(FID900): ${orderQuantity}, 체결수량(FID901): ${filledQuantity}, 실제체결수량: ${actualFilledQuantity}, 미체결수량(FID902): ${unfilledQuantity}, 체결가격(FID903): ${executedPrice}, 주문구분: ${orderType}`)
                    
                    // 체결 정보를 orderLogs에 즉시 반영
                    setOrderLogs(prev => {
                      return prev.map(order => {
                        // 해당 종목의 미체결 매수 주문 찾기
                        if (order.stockCode === code && 
                            order.type === 'buy' && 
                            (order.status === '접수' || order.status === '확인' || order.status === '미체결' || order.status === '부분체결') &&
                            !order.isExecuted &&
                            order.orderNumber) {
                          
                          // 실제 주문 수량 (order.quantity)과 미체결수량 비교
                          const 주문수량 = order.quantity
                          const 이전미체결수량 = order.unfilledQuantity || 주문수량 // 이전 미체결수량 (없으면 주문수량으로 초기화)
                          
                          // 미체결 수량이 0이면 전량 체결
                          if (unfilledQuantity === 0 && 주문수량 > 0) {
                            const 체결수량 = 주문수량
                            // executedPrice는 누적 체결금액이므로 평균 체결가 계산
                            const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                            console.log(`[WebSocket 체결] ${order.stockName} 매수 주문 전량 체결 (체결수량: ${체결수량}주, 주문수량: ${주문수량}주, 누적체결금액: ${executedPrice.toLocaleString()}원, 평균체결가: ${평균체결가.toLocaleString()}원)`)
                            addLog(`[체결 완료] ${order.stockName} ${체결수량}주 매수 체결 (평균가: ${평균체결가.toLocaleString()}원)`, 'success')
                            
                            // 체결 완료 시 즉시 보유종목 및 계좌 정보 조회하여 실제 계좌 상태 확인 및 반영
                            // WebSocket 체결 정보만으로 보유종목을 추가하지 않고, API 조회 결과를 기준으로 함
                            setTimeout(() => {
                              console.log(`[체결 완료] 보유종목 및 계좌 정보 조회 실행 - ${order.stockName} (${order.stockCode})`)
                              refetchBalance()
                              // 계좌 정보 캐시 무효화 후 즉시 재조회 (예수금 업데이트)
                              queryClient.invalidateQueries(['accountInfo', selectedAccount])
                              refetchAccountInfo()
                            }, 1000) // 1초 후 보유종목 조회 (API 반영 시간 고려)
                            
                            return {
                              ...order,
                              status: '체결',
                              isExecuted: true,
                              price: 평균체결가, // 평균 체결가로 업데이트
                              unfilledQuantity: 0, // 미체결수량 업데이트
                            }
                          } 
                          // 미체결 수량이 줄어들었으면 부분 체결 또는 전량 체결
                          else if (unfilledQuantity >= 0 && unfilledQuantity < 이전미체결수량) {
                            const 체결수량 = 이전미체결수량 - unfilledQuantity
                            const 총체결수량 = 주문수량 - unfilledQuantity
                            
                            if (unfilledQuantity === 0) {
                              // 전량 체결
                              // executedPrice는 누적 체결금액이므로 평균 체결가 계산
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              console.log(`[WebSocket 체결] ${order.stockName} 매수 주문 전량 체결 (체결수량: ${총체결수량}주, 주문수량: ${주문수량}주, 누적체결금액: ${executedPrice.toLocaleString()}원, 평균체결가: ${평균체결가.toLocaleString()}원)`)
                              addLog(`[체결 완료] ${order.stockName} ${총체결수량}주 매수 체결 (평균가: ${평균체결가.toLocaleString()}원)`, 'success')
                              
                              // 체결 완료 시 즉시 보유종목 조회하여 실제 계좌 상태 확인 및 반영
                              // WebSocket 체결 정보만으로 보유종목을 추가하지 않고, API 조회 결과를 기준으로 함
                              setTimeout(() => {
                                console.log(`[체결 완료] 보유종목 조회 실행 - ${order.stockName} (${order.stockCode})`)
                                refetchBalance()
                                // 계좌 정보 캐시 무효화 후 즉시 재조회 (예수금 업데이트)
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000) // 1초 후 보유종목 조회 (API 반영 시간 고려)
                              
                              return {
                                ...order,
                                status: '체결',
                                isExecuted: true,
                                price: 평균체결가,
                                unfilledQuantity: 0,
                              }
                            } else {
                              // 부분 체결
                              // executedPrice는 누적 체결금액이므로 평균 체결가 계산
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              console.log(`[WebSocket 부분체결] ${order.stockName} 매수 주문 부분 체결 (이번체결: ${체결수량}주, 총체결: ${총체결수량}주, 미체결: ${unfilledQuantity}주, 주문: ${주문수량}주, 누적체결금액: ${executedPrice.toLocaleString()}원, 평균체결가: ${평균체결가.toLocaleString()}원)`)
                              addLog(`[부분 체결] ${order.stockName} 이번 ${체결수량}주 체결 (총 ${총체결수량}주 체결, 평균가: ${평균체결가.toLocaleString()}원, 미체결: ${unfilledQuantity}주)`, 'info')
                              
                              // 부분 체결 시 보유종목 조회하여 실제 계좌 상태 확인
                              // WebSocket 체결 정보만으로 보유종목을 추가하지 않고, API 조회 결과를 기준으로 함
                              setTimeout(() => {
                                console.log(`[부분 체결] 보유종목 조회 실행 - ${order.stockName} (${order.stockCode})`)
                                refetchBalance()
                                // 계좌 정보 캐시 무효화 후 즉시 재조회 (예수금 업데이트)
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000) // 1초 후 보유종목 조회 (API 반영 시간 고려)
                              
                              return {
                                ...order,
                                status: '부분체결',
                                price: 평균체결가,
                                unfilledQuantity: unfilledQuantity, // 미체결수량 업데이트
                              }
                            }
                          }
                          // 미체결수량이 주문수량보다 작으면 체결 진행 중
                          else if (unfilledQuantity >= 0 && unfilledQuantity < 주문수량) {
                            const 총체결수량 = 주문수량 - unfilledQuantity
                            console.log(`[WebSocket 체결 진행] ${order.stockName} 매수 주문 체결 진행 중 (총체결: ${총체결수량}주, 미체결: ${unfilledQuantity}주, 주문: ${주문수량}주)`)
                            
                            if (unfilledQuantity === 0) {
                              // 전량 체결
                              // executedPrice는 누적 체결금액이므로 평균 체결가 계산
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              addLog(`[체결 완료] ${order.stockName} ${총체결수량}주 매수 체결 (평균가: ${평균체결가.toLocaleString()}원)`, 'success')
                              
                              // 체결 완료 시 즉시 보유종목 조회하여 실제 계좌 상태 확인 및 반영
                              // WebSocket 체결 정보만으로 보유종목을 추가하지 않고, API 조회 결과를 기준으로 함
                              setTimeout(() => {
                                console.log(`[체결 완료] 보유종목 조회 실행 - ${order.stockName} (${order.stockCode})`)
                                refetchBalance()
                                // 계좌 정보 캐시 무효화 후 즉시 재조회 (예수금 업데이트)
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000) // 1초 후 보유종목 조회 (API 반영 시간 고려)
                              
                              return {
                                ...order,
                                status: '체결',
                                isExecuted: true,
                                price: 평균체결가,
                                unfilledQuantity: 0,
                              }
                            } else {
                              // 부분 체결
                              // executedPrice는 누적 체결금액이므로 평균 체결가 계산
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              addLog(`[부분 체결] ${order.stockName} ${총체결수량}주 체결 (평균가: ${평균체결가.toLocaleString()}원, 미체결: ${unfilledQuantity}주)`, 'info')
                              
                              // 부분 체결 시 보유종목 조회하여 실제 계좌 상태 확인
                              // WebSocket 체결 정보만으로 보유종목을 추가하지 않고, API 조회 결과를 기준으로 함
                              setTimeout(() => {
                                console.log(`[부분 체결] 보유종목 조회 실행 - ${order.stockName} (${order.stockCode})`)
                                refetchBalance()
                                // 계좌 정보 캐시 무효화 후 즉시 재조회 (예수금 업데이트)
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000) // 1초 후 보유종목 조회 (API 반영 시간 고려)
                              
                              return {
                                ...order,
                                status: '부분체결',
                                price: 평균체결가,
                                unfilledQuantity: unfilledQuantity,
                              }
                            }
                          }
                        }
                        
                        // 매도 주문 체결 확인
                        if (order.stockCode === code && 
                            order.type === 'sell' && 
                            (order.status === '접수' || order.status === '확인' || order.status === '미체결' || order.status === '부분체결') &&
                            !order.isExecuted &&
                            order.orderNumber) {
                          
                          const 주문수량 = order.quantity
                          const 이전미체결수량 = order.unfilledQuantity || 주문수량

                          // 취소/거부된 주문은 체결이 아니다.
                          // (취소되면 미체결수량이 0이 되어 '전량 체결'로 오인하고,
                          //  체결가가 없어 매도가 0원 → -100%로 계산되던 원인)
                          const isCancelledStatus =
                            orderStatus.includes('취소') || orderStatus.includes('거부')

                          if (isCancelledStatus) {
                            console.log(`[체결 무시] ${order.stockName}: 주문 상태가 '${orderStatus}'이므로 체결 처리하지 않음`)
                            return {
                              ...order,
                              status: '취소',
                              type: 'cancel' as const,
                              cancelTimestamp: Date.now(),
                            }
                          }

                          // 체결 수량이 실제로 있어야 체결이다.
                          // (미체결 0만 보고 판단하면 취소도 체결로 오인한다)
                          const hasFill = actualFilledQuantity > 0

                          // 미체결 수량이 0이고 실제 체결 수량이 있으면 전량 체결
                          if (unfilledQuantity === 0 && 주문수량 > 0 && hasFill) {
                            const 체결수량 = Math.min(actualFilledQuantity || 주문수량, 주문수량)
                            
                            // 실현손익 계산 (매도가 - 매수가) * 수량
                            // buyPrice가 0이면 잔고 평균단가/매수로그로 보강한다
                            const heldForCalc = holdingStocksRef.current.find(h => h.code === order.stockCode)
                            const 매수가 = resolveBuyPrice(
                              order.buyPrice,
                              heldForCalc,
                              orderLogs.find(o => o.type === 'buy' && o.stockCode === order.stockCode)?.price
                            )
                            // 체결가: 소켓값이 0이면 주문가/현재가 순으로 보강한다.
                            // 시장가는 order.price가 0이라 그대로 두면 매도가 0 → -100%가 된다.
                            const 평균체결가 = resolveExecutedPrice(executedPrice, order, heldForCalc?.currentPrice)

                            // 가격을 확정할 수 없으면 0원/-100%를 누적하지 않고 보류한다
                            if (!isValidTradePrice(평균체결가) || !isValidTradePrice(매수가)) {
                              console.warn(
                                `[실현손익 보류] ${order.stockName} (${order.stockCode}): ` +
                                `체결가=${평균체결가}, 매수가=${매수가} ` +
                                `(소켓=${executedPrice}, 주문가=${order.price}, 주문당시=${order.currentPrice}, ` +
                                `잔고현재가=${heldForCalc?.currentPrice}, 잔고단가=${heldForCalc?.purchasePrice})`
                              )
                              return {
                                ...order,
                                status: '체결',
                                isExecuted: true,
                                // realizedProfit을 설정하지 않아 이후 재집계 대상으로 남긴다
                              }
                            }

                            const 실현손익 = (평균체결가 - 매수가) * 체결수량
                            const 실현손익률 = ((평균체결가 - 매수가) / 매수가) * 100

                            console.log(`[WebSocket 체결] ${order.stockName} 매도 주문 전량 체결 (체결수량: ${체결수량}주, 주문수량: ${주문수량}주, 누적체결금액: ${executedPrice.toLocaleString()}원, 평균체결가: ${평균체결가.toLocaleString()}원, 매수가: ${매수가.toLocaleString()}원, 실현손익: ${실현손익.toLocaleString()}원, 실현손익률: ${실현손익률.toFixed(2)}%)`)
                            addLog(`[체결 완료] ${order.stockName} ${체결수량}주 매도 체결 (평균가: ${평균체결가.toLocaleString()}원, 실현손익: ${실현손익.toLocaleString()}원, ${실현손익률.toFixed(2)}%)`, 'success')

                            // 실현손익 누적은 아래 전용 effect가 orderLogs 변경을 보고 처리한다.
                            // (setOrderLogs 업데이터 안에서 다른 setState를 호출하면
                            //  React가 업데이터를 여러 번 실행하거나 배치 처리해 누락·중복이 생긴다)
                            // 여기서 realizedCountedRef를 선점하면 effect가 집계하지 못하므로 건드리지 않는다.
                            
                            // 매도 체결 완료 후 해당 매수/매도 주문을 orderLogs에서 삭제
                            // 집계 effect가 실행될 시간을 확보한다 (500ms는 너무 짧아 누락됐다)
                            setTimeout(() => {
                              setOrderLogs(prevLogs => {
                                const filtered = prevLogs.filter(log => 
                                  !(log.stockCode === order.stockCode && 
                                    (log.type === 'buy' || log.orderNumber === order.orderNumber))
                                )
                                console.log(`[주문 내역 정리] ${order.stockName} 매수/매도 주문 삭제 완료 (이전: ${prevLogs.length}개, 현재: ${filtered.length}개)`)
                                return filtered
                              })
                            }, 3000)
                            
                            // 체결 완료 시 보유종목 및 계좌 정보 조회
                            setTimeout(() => {
                              console.log(`[체결 완료] 보유종목 및 계좌 정보 조회 실행 - ${order.stockName} (${order.stockCode})`)
                              refetchBalance()
                              queryClient.invalidateQueries(['accountInfo', selectedAccount])
                              refetchAccountInfo()
                            }, 1000)
                            
                            // 일시적으로 주문 상태 업데이트 (곧 삭제될 예정)
                            return {
                              ...order,
                              status: '체결',
                              isExecuted: true,
                              price: 평균체결가,
                              unfilledQuantity: 0,
                              realizedProfit: 실현손익,
                              realizedProfitPercent: 실현손익률,
                            }
                          } 
                          // 미체결 수량이 줄어들었으면 부분 체결 또는 전량 체결
                          else if (unfilledQuantity >= 0 && unfilledQuantity < 이전미체결수량) {
                            const 체결수량 = 이전미체결수량 - unfilledQuantity
                            const 총체결수량 = 주문수량 - unfilledQuantity
                            
                            if (unfilledQuantity === 0) {
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              
                              // 실현손익 계산
                              // buyPrice가 0이면 잔고 평균단가/매수로그로 보강한다
                              const heldPartial = holdingStocksRef.current.find(h => h.code === order.stockCode)
                              const 매수가 = resolveBuyPrice(
                                order.buyPrice,
                                heldPartial,
                                orderLogs.find(o => o.type === 'buy' && o.stockCode === order.stockCode)?.price
                              )
                              const 실현손익 = isValidTradePrice(평균체결가) && isValidTradePrice(매수가)
                                ? (평균체결가 - 매수가) * 총체결수량
                                : 0
                              const 실현손익률 = 매수가 > 0 && isValidTradePrice(평균체결가)
                                ? ((평균체결가 - 매수가) / 매수가) * 100
                                : 0
                              
                              console.log(`[WebSocket 체결] ${order.stockName} 매도 주문 전량 체결 (체결수량: ${총체결수량}주, 주문수량: ${주문수량}주, 실현손익: ${실현손익.toLocaleString()}원)`)
                              addLog(`[체결 완료] ${order.stockName} ${총체결수량}주 매도 체결 (평균가: ${평균체결가.toLocaleString()}원, 실현손익: ${실현손익.toLocaleString()}원, ${실현손익률.toFixed(2)}%)`, 'success')

                              // 누적은 아래 전용 effect가 담당한다 (realizedProfit만 기록)
                              
                              // 매도 체결 완료 후 해당 매수/매도 주문을 orderLogs에서 삭제
                              setTimeout(() => {
                                setOrderLogs(prevLogs => {
                                  const filtered = prevLogs.filter(log => 
                                    !(log.stockCode === order.stockCode && 
                                      (log.type === 'buy' || log.orderNumber === order.orderNumber))
                                  )
                                  console.log(`[주문 내역 정리] ${order.stockName} 매수/매도 주문 삭제 완료 (이전: ${prevLogs.length}개, 현재: ${filtered.length}개)`)
                                  return filtered
                                })
                              }, 500)
                              
                              setTimeout(() => {
                                refetchBalance()
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000)
                              
                              return {
                                ...order,
                                status: '체결',
                                isExecuted: true,
                                price: 평균체결가,
                                unfilledQuantity: 0,
                                // 가격 미확정이면 realizedProfit을 남기지 않아 재집계 대상이 된다
                                ...(isValidTradePrice(평균체결가) && isValidTradePrice(매수가)
                                  ? {
                                      realizedProfit: 실현손익,
                                      realizedProfitPercent: 실현손익률,
                                    }
                                  : {}),
                              }
                            } else {
                              const 평균체결가 = resolveExecutedPrice(executedPrice, order)
                              
                              // 부분체결 실현손익 계산 (체결된 수량만큼)
                              // buyPrice가 0이면 잔고 평균단가/매수로그로 보강한다
                              const heldPartial2 = holdingStocksRef.current.find(h => h.code === order.stockCode)
                              const 매수가 = resolveBuyPrice(
                                order.buyPrice,
                                heldPartial2,
                                orderLogs.find(o => o.type === 'buy' && o.stockCode === order.stockCode)?.price
                              )
                              const 부분실현손익 = isValidTradePrice(평균체결가) && isValidTradePrice(매수가)
                                ? (평균체결가 - 매수가) * 총체결수량
                                : undefined
                              const 부분실현손익률 = 부분실현손익 !== undefined
                                ? ((평균체결가 - 매수가) / 매수가) * 100
                                : 0
                              
                              console.log(`[WebSocket 부분체결] ${order.stockName} 매도 주문 부분 체결 (이번체결: ${체결수량}주, 총체결: ${총체결수량}주, 미체결: ${unfilledQuantity}주, 부분실현손익: ${부분실현손익?.toLocaleString() ?? '보류'}원)`)
                              addLog(`[부분 체결] ${order.stockName} 이번 ${체결수량}주 체결 (총 ${총체결수량}주 체결, 평균가: ${평균체결가.toLocaleString()}원, 미체결: ${unfilledQuantity}주, 부분실현손익: ${부분실현손익?.toLocaleString() ?? '보류'}원)`, 'info')
                              
                              setTimeout(() => {
                                refetchBalance()
                                queryClient.invalidateQueries(['accountInfo', selectedAccount])
                                refetchAccountInfo()
                              }, 1000)
                              
                              return {
                                ...order,
                                status: '부분체결',
                                price: 평균체결가,
                                unfilledQuantity: unfilledQuantity,
                                // 가격을 확정하지 못했으면 realizedProfit을 남기지 않는다 (재집계 대상)
                                ...(부분실현손익 !== undefined
                                  ? {
                                      realizedProfit: 부분실현손익,
                                      realizedProfitPercent: 부분실현손익률,
                                    }
                                  : {}),
                              }
                            }
                          }
                        }
                        
                        return order
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
          
          // 재연결 시도 (3초 후). 연결 상태만 보면 되고 종목 유무와 무관하다.
          if (isMounted) {
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

    return () => {
      isMounted = false
      if (ws) {
        ws.close()
      }
      // 서버 WebSocket 연결 해제는 하지 않음 (다른 클라이언트가 사용할 수 있음)
    }
  }, [isConnected, connected]) // 종목 변경 시 재연결하지 않는다. 등록은 아래 별도 effect에서 처리.

  // 검색된 종목이 늘어나면 실시간 등록만 추가한다 (브라우저 WS는 유지)
  // 서버 WS가 아직 준비되지 않아 등록이 실패할 수 있으므로 주기적으로 재시도한다.
  const registeredCodesRef = useRef<Set<string>>(new Set())
  const connectedSessionKey = `${connected ? 1 : 0}-${selectedAccount}`
  const registeredSessionRef = useRef<string>('')
  useEffect(() => {
    if (!isConnected || !connected) return

    // 서버가 재시작되면 서버측 등록 상태는 비는데 클라이언트 캐시는 남아 있게 된다.
    // 연결이 새로 성립하면 캐시를 버리고 전체를 다시 등록한다.
    if (registeredSessionRef.current !== connectedSessionKey) {
      registeredSessionRef.current = connectedSessionKey
      registeredCodesRef.current.clear()
    }

    const sync = () => {
      const codes = detectedStocksRef.current.map(s => s.code)
      const newCodes = codes.filter(code => !registeredCodesRef.current.has(code))
      if (newCodes.length === 0) return
      newCodes.forEach(code => registeredCodesRef.current.add(code))
      kiwoomApi.registerRealTimeStocks(newCodes).catch((error) => {
        // 실패하면 다음 주기에 다시 시도할 수 있도록 기록을 되돌린다
        newCodes.forEach(code => registeredCodesRef.current.delete(code))
        console.error('[실시간 시세] 등록 실패:', error.message)
      })
    }

    sync()
    const id = window.setInterval(sync, 5000)
    return () => window.clearInterval(id)
  }, [isConnected, connected, connectedSessionKey])

  // 체결된 주문의 종목코드를 실시간 시세에 등록
  useEffect(() => {
    if (!isConnected || !connected) return

    // 체결된 매수 주문의 종목코드 추출 (부분체결 포함)
    const executedOrderCodes = orderLogs
      .filter(order => order.type === 'buy' && (order.status === '체결' || order.status === '부분체결' || order.isExecuted))
      .map(order => order.stockCode)
      .filter((code, index, self) => self.indexOf(code) === index) // 중복 제거

    if (executedOrderCodes.length > 0) {
      // 실시간 시세 등록 (약간의 딜레이를 두어 WebSocket 연결이 완료된 후 등록)
      setTimeout(() => {
        kiwoomApi.registerRealTimeStocks(executedOrderCodes).catch((error) => {
          console.error('[실시간 시세 등록 오류]', error)
        })
      }, 1000)
    }
  }, [isConnected, connected, orderLogs]) // 체결된 주문이 추가될 때마다 실행

  // 보유종목이 비어있으면 체결된 주문 기반으로 생성
  // 주의: 잔고 조회가 성공한 상태에서는 절대 로그로 보유종목을 만들지 않는다.
  // (로그 기반 생성이 잔고보다 먼저/나중에 실행되면 목록이 달라져 보인다)
  useEffect(() => {
    if (holdingStocks.length > 0) return
    if (orderLogs.length === 0) return
    if (!isConnected || !connected) return
    // 잔고를 조회할 수 있는 상태면 잔고 결과를 기다린다 (로그로 대체하지 않음)
    if (isConnected && !!selectedAccount && !balanceError) return

    const executedBuyOrders = orderLogs.filter(order => 
      order.type === 'buy' && 
      (order.status === '체결' || order.status === '부분체결' || order.isExecuted)
    )

    if (executedBuyOrders.length === 0) return

    console.log(`[보유종목 자동 생성] 체결된 주문 ${executedBuyOrders.length}개 기반으로 보유종목 생성`)

    // 종목별로 그룹화
    const ordersByStock = new Map<string, typeof executedBuyOrders>()
    executedBuyOrders.forEach(order => {
      if (!ordersByStock.has(order.stockCode)) {
        ordersByStock.set(order.stockCode, [])
      }
      ordersByStock.get(order.stockCode)!.push(order)
    })

    const newHoldingStocks: HoldingStock[] = []
    ordersByStock.forEach((orders, stockCode) => {
      let 총체결수량 = 0
      let 총매입금액 = 0

      orders.forEach(order => {
        const 체결수량 = order.status === '부분체결' && order.unfilledQuantity !== undefined
          ? order.quantity - order.unfilledQuantity
          : order.quantity
        
        총체결수량 += 체결수량
        총매입금액 += 체결수량 * (order.price || 0)
      })

      if (총체결수량 > 0) {
        const 평균매입가 = 총매입금액 / 총체결수량
        const 현재가 = orders[0].currentPrice || 평균매입가
        const 평가손익 = (현재가 - 평균매입가) * 총체결수량
        const 수익률 = 평균매입가 > 0 ? ((현재가 - 평균매입가) / 평균매입가) * 100 : 0

        newHoldingStocks.push({
          code: stockCode,
          name: orders[0].stockName,
          quantity: 총체결수량,
          purchasePrice: 평균매입가,
          currentPrice: 현재가,
          profit: 평가손익,
          profitPercent: 수익률,
          maxProfitPercent: 수익률 > 0 ? 수익률 : 0,
        })

        console.log(`[보유종목 자동 생성] ${orders[0].stockName}: 수량 ${총체결수량}주, 평균매입가 ${평균매입가.toLocaleString()}원, 현재가 ${현재가.toLocaleString()}원`)
      }
    })

    if (newHoldingStocks.length > 0) {
      setHoldingStocks(newHoldingStocks)
      console.log(`[보유종목 자동 생성] 완료 - ${newHoldingStocks.length}개 종목 생성됨`)
      
      // 생성된 보유종목의 실시간 시세 등록
      const codes = newHoldingStocks.map(s => s.code)
      if (codes.length > 0) {
        setTimeout(() => {
          kiwoomApi.registerRealTimeStocks(codes).catch((error) => {
            console.error('[실시간 시세 등록 오류]', error)
          })
          console.log(`[실시간 시세 등록] 자동 생성된 보유종목 ${codes.length}개 등록`)
        }, 1000)
      }
    }
  }, [holdingStocks, orderLogs, isConnected, connected])

  // 보유종목의 현재가를 체결된 주문에 동기화
  useEffect(() => {
    if (holdingStocks.length === 0) return

    setOrderLogs(prevOrders => {
      let updated = false
      const updatedOrders = prevOrders.map(order => {
        if (order.type === 'buy' && 
            (order.status === '체결' || order.status === '부분체결' || order.isExecuted)) {
          const holdingStock = holdingStocks.find(h => h.code === order.stockCode)
          if (holdingStock && holdingStock.currentPrice > 0) {
            // 보유종목의 현재가가 있고, 주문의 현재가가 없거나 다르면 업데이트
            if (!order.currentPrice || order.currentPrice !== holdingStock.currentPrice) {
              const 체결가격 = order.price || 0
              const 체결수량 = order.status === '부분체결' && order.unfilledQuantity !== undefined
                ? order.quantity - order.unfilledQuantity
                : order.quantity
              const 현재가 = holdingStock.currentPrice
              const 수익 = (현재가 - 체결가격) * 체결수량
              const 수익률 = 체결가격 > 0 ? ((현재가 - 체결가격) / 체결가격) * 100 : 0
              
              updated = true
              return {
                ...order,
                currentPrice: 현재가,
                profit: 수익,
                profitPercent: 수익률,
              }
            }
          }
        }
        return order
      })
      
      if (updated) {
        console.log(`[주문 내역 동기화] 보유종목의 현재가를 체결된 주문에 반영`)
      }
      
      return updatedOrders
    })
  }, [holdingStocks]) // 보유종목이 업데이트될 때마다 실행

  // 손절 모니터링 (보유종목의 수익률을 실시간 체크하여 손절 기준에 도달하면 시장가 매도)
  useEffect(() => {
    if (!stopLossEnabled) return
    if (stepProfit.사용) return // 단계별 익절/손절 사용 시 단계 손절이 담당 (이중 매도 방지)
    if (!isRunning) return
    if (holdingStocks.length === 0) return
    if (!isConnected || !connected || !selectedAccount) return

    holdingStocks.forEach(stock => {
      // 이미 손절 실행 중인 종목은 스킵
      if (stopLossExecuting.has(stock.code)) {
        return
      }

      // 손절 기준에 도달한 경우 (손실률이 설정값 이하)
      if (stock.profitPercent <= stopLossRate) {
        console.log(`[손절 감지] ${stock.name} (${stock.code}): 현재 수익률 ${stock.profitPercent.toFixed(2)}% <= 손절 기준 ${stopLossRate}%`)
        
        // 손절 실행 중 상태로 설정 (중복 주문 방지)
        setStopLossExecuting(prev => new Set(prev).add(stock.code))

        // 시장가 매도 주문 실행
        const executeSellOrder = async () => {
          try {
            addLog(`[손절 실행] ${stock.name} ${stock.quantity}주 시장가 매도 (현재 수익률: ${stock.profitPercent.toFixed(2)}%)`, 'warning')
            
            const sellResult = await kiwoomApi.placeOrder({
              accountNo: selectedAccount.split('-')[0],
              accountProductCode: selectedAccount.split('-')[1] || '01',
              order_type: 'sell',
              code: stock.code,
              quantity: stock.quantity,
              price: 0, // 시장가
              order_option: '03', // 시장가
            })

            if (sellResult && (sellResult.success || sellResult.orderNumber)) {
              console.log(`[손절 완료] ${stock.name} 매도 주문 전송 완료 (주문번호: ${sellResult.orderNumber || sellResult.order_number || 'N/A'})`)
              addLog(`[손절 완료] ${stock.name} ${stock.quantity}주 시장가 매도 주문 완료`, 'success')
              
              // 주문 내역에 추가
              const newOrder: OrderLog = {
                id: Date.now(),
                date: new Date().toLocaleDateString('ko-KR'),
                time: new Date().toLocaleTimeString('ko-KR'),
                type: 'sell',
                stockName: stock.name,
                stockCode: stock.code,
                quantity: stock.quantity,
                price: stock.currentPrice, // 시장가이지만 현재가를 기록
                status: '접수',
                orderNumber: sellResult.orderNumber || sellResult.order_number,
                isExecuted: false,
                orderTimestamp: Date.now(),
                buyPrice: resolveBuyPrice(stock.purchasePrice, stock), // 실현손익 계산용 매수가
                currentPrice: stock.currentPrice,
              }
              
              setOrderLogs(prev => [newOrder, ...prev])
              
              // 일정 시간 후 손절 실행 상태 해제 (중복 방지 타이머)
              setTimeout(() => {
                setStopLossExecuting(prev => {
                  const newSet = new Set(prev)
                  newSet.delete(stock.code)
                  return newSet
                })
              }, 10000) // 10초 후 해제
            } else {
              console.error(`[손절 실패] ${stock.name} 매도 주문 실패:`, sellResult.message)
              addLog(`[손절 실패] ${stock.name} 매도 주문 실패: ${sellResult.message}`, 'error')
              
              // 실패 시 즉시 상태 해제
              setStopLossExecuting(prev => {
                const newSet = new Set(prev)
                newSet.delete(stock.code)
                return newSet
              })
            }
          } catch (error: any) {
            console.error(`[손절 오류] ${stock.name} 매도 중 오류:`, error)
            addLog(`[손절 오류] ${stock.name} 매도 중 오류: ${error.message}`, 'error')
            
            // 오류 시 상태 해제
            setStopLossExecuting(prev => {
              const newSet = new Set(prev)
              newSet.delete(stock.code)
              return newSet
            })
          }
        }

        executeSellOrder()
      }
    })
  }, [holdingStocks, stopLossEnabled, stopLossRate, stepProfit.사용, isRunning, isConnected, connected, selectedAccount])

  // 차트 데이터로 검색된 종목 화면 갱신 (주기적으로 차트 데이터 조회하여 가격 정보 업데이트)
  // 조건검색 직후에는 차트 데이터 조회를 지연시켜 API 제한 방지
  const lastSearchTimeRef = useRef<number>(0)
  
  // 주문 API 요청 제한 방지를 위한 마지막 주문 시간 추적
  const lastOrderTimeRef = useRef<number>(0)
  const minOrderInterval = 5000 // 주문 간 최소 간격: 5초 (API 요청 제한 방지)
  const apiLimitErrorRef = useRef<boolean>(false) // API 제한 에러 발생 플래그
  // 실행 중첩 방지: 1회 실행이 30초를 넘으면 다음 인터벌과 겹쳐 같은 종목을 중복 주문한다
  const isExecutingRef = useRef<boolean>(false)
  // 주문 처리 중 종목을 동기적으로 기록한다.
  // setProcessingOrders는 다음 렌더에야 반영되므로 같은 루프 안에서 중복 주문을 막지 못한다.
  const processingOrdersRef = useRef<Set<string>>(new Set())
  // 실행 루프는 시작 시점 state 스냅샷을 붙들므로 최신 값을 ref로 읽는다
  // (holdingStocksRef는 상단에서 선언했다)
  const orderedOrHoldingRef = useRef<Set<string>>(new Set())
  orderedOrHoldingRef.current = orderedOrHoldingStocks
  
  useEffect(() => {
    if (!isConnected || !connected || detectedStocks.length === 0) {
      return
    }

    let isMounted = true
    let intervalId: number | null = null
    let isFetching = false // 이전 조회가 끝나기 전에 겹쳐 실행되지 않도록

    const updateStocksFromChartData = async () => {
      if (!isMounted || detectedStocks.length === 0 || isFetching) {
        return
      }

      // 조건검색 직후에는 차트 데이터 조회를 지연시켜 API 제한 방지.
      // 단 시가/고가가 아직 없는 종목이 있으면 짧게만 기다린다 (표가 '-'로 남지 않도록).
      const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
      const needsOpenHigh = detectedStocks.some(s => !s.openPrice || !s.highPrice)
      const waitMs = needsOpenHigh ? 3000 : 30000
      if (timeSinceLastSearch < waitMs) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[차트 갱신] 조건검색 직후 대기 중 (${Math.ceil((waitMs - timeSinceLastSearch) / 1000)}초 남음)`)
        }
        return
      }

      try {
        isFetching = true
        // 검색된 종목들의 최신 가격만 필요하므로 다종목 시세(ka10095)로 한 번에 조회한다.
        // 종목별 현재가(ka10001)를 반복하면 서버 TR 큐 간격 때문에 수십 초가 걸린다.
        const codes = detectedStocks.map(s => s.code)
        const prices = await kiwoomApi.getMultipleStockPrices(codes)

        if (isMounted && prices.length > 0) {
          const priceMap = new Map<string, any>(prices.map((p: any) => [p.code, p]))

          setDetectedStocks(prevStocks => {
            return prevStocks.map(s => {
              const latest = priceMap.get(s.code)
              if (!latest || !latest.price) {
                return s
              }

              const closePrice = latest.price
              // 대비/등락률은 전일 종가 기준이어야 한다 (시작가 기준 상대변화율은 매수 조건에서 별도 계산)
              const change = latest.change ?? (closePrice - (s.startPrice || closePrice))
              const changePercent = latest.changePercent ?? s.changePercent

              // 시가/고가는 ka10095 응답에서만 오므로, 한 번 받으면 유지한다
              const openPrice = latest.openPrice || latest.시가 || s.openPrice
              const highPrice = latest.highPrice || latest.고가 || s.highPrice
              const prevClose = latest.prevClose || s.prevClose

              if (
                closePrice === s.price &&
                change === s.change &&
                changePercent === s.changePercent &&
                openPrice === s.openPrice &&
                highPrice === s.highPrice &&
                prevClose === s.prevClose
              ) {
                return s
              }

              return {
                ...s,
                price: closePrice,
                change: change,
                changePercent: changePercent,
                volume: latest.volume > 0 ? latest.volume : s.volume,
                openPrice,
                highPrice,
                prevClose,
              }
            })
          })
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[가격 갱신] 오류:', error)
        }
      } finally {
        isFetching = false
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
    }, 4000) // 첫 실행은 4초 후 (시가/고가 보강 대기)

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
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: key.trim() })
      })

      const data = await response.json()
      
      if (data.success) {
        const info = {
          expiresAt: data.expiresAt,
          remainingDays: data.remainingDays
        }
        setKeyInfo(info)
        // 검증 결과를 저장해 재시작 후에도 "검증 완료"가 유지되게 한다.
        // 키 자체는 서버가 HttpOnly 쿠키로 관리하므로 localStorage에 남기지 않는다.
        // (남기면 XSS 한 번에 키가 탈취된다. 만료 정보만 저장한다)
        try {
          localStorage.removeItem('kiwoom_license_key')
          localStorage.setItem('kiwoom_license_info', JSON.stringify({ expiresAt: info.expiresAt, remainingDays: info.remainingDays }))
        } catch (storageError) {
          console.warn('[라이선스] 검증 결과 저장 실패:', storageError)
        }
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
      // 세션 표시값이면 실제 키가 아니다 (HttpOnly 쿠키로 이미 인증됨)
      const isSessionAuth = licenseKey.trim() === SESSION_PLACEHOLDER

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
      // 세션 쿠키로 이미 인증된 경우에는 서버가 쿠키로 검증하므로 건너뛴다.
      if (!isSessionAuth) {
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
      // 주의: appkey/secretkey는 브라우저에 남는다. 서버 세션에만 두는 것이 이상적이나
      //       서버 재시작 후 자동 재연결에 필요해 유지한다. (공용 PC에서는 사용 금지)
      localStorage.setItem('kiwoom_appkey', finalAppkey)
      localStorage.setItem('kiwoom_secretkey', finalSecretkey)
      localStorage.setItem('kiwoom_apimode', apiMode)
      // 라이선스 키는 HttpOnly 쿠키로 관리되므로 localStorage에 저장하지 않는다
      try {
        localStorage.removeItem('kiwoom_license_key')
      } catch {
        // 저장소 접근 불가 시 무시
      }

      // API 연결 시도 (백엔드에 요청)
      const response = await fetch('/api/kiwoom/connect', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
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
      await fetch('/api/kiwoom/disconnect', { method: 'POST', credentials: 'include', headers: authHeaders() })
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

  // 검색 직후 시가/고가 보강: 순위정보 API는 시가/고가를 주지 않으므로
  // 다종목 시세(ka10095)로 한 번 채워 표에 '-'가 남지 않게 한다.
  const enrichOpenHigh = async (codes: string[]) => {
    if (codes.length === 0) return
    try {
      const prices = await kiwoomApi.getMultipleStockPrices(codes)
      if (!prices || prices.length === 0) return
      const map = new Map<string, any>(prices.map((p: any) => [p.code, p]))
      setDetectedStocks(prev => prev.map(s => {
        const latest = map.get(s.code)
        if (!latest) return s
        const openPrice = latest.openPrice || latest.시가 || s.openPrice
        const highPrice = latest.highPrice || latest.고가 || s.highPrice
        const prevClose = latest.prevClose || s.prevClose
        if (openPrice === s.openPrice && highPrice === s.highPrice && prevClose === s.prevClose) return s
        return { ...s, openPrice, highPrice, prevClose }
      }))
    } catch (error: any) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[시가/고가 보강] 오류:', error.message)
      }
    }
  }

  // 수동 종목 검색 (조건검색식에 종목 직접 추가)
  const handleManualSearch = async () => {
    const keyword = manualKeyword.trim()
    if (!keyword) return
    setIsManualSearching(true)
    try {
      const stocks = await kiwoomApi.searchStocks(keyword)
      setManualResults(stocks)
      setManualSelectedCodes(new Set())
      if (stocks.length === 0) addLog(`'${keyword}' 검색 결과가 없습니다`, 'warning')
    } catch (error: any) {
      addLog(`종목 검색 실패: ${error.message}`, 'error')
    } finally {
      setIsManualSearching(false)
    }
  }

  // 검색 결과에서 선택한 종목을 검색된 종목 목록에 추가
  const handleManualAdd = async () => {
    const picked = manualResults.filter(s => manualSelectedCodes.has(s.code))
    if (picked.length === 0) {
      addLog('추가할 종목을 선택하세요', 'warning')
      return
    }

    // 현재가/등락률을 채워야 매매 로직이 바로 동작한다
    let priceMap = new Map<string, any>()
    try {
      const prices = await kiwoomApi.getMultipleStockPrices(picked.map(s => s.code))
      priceMap = new Map<string, any>((prices || []).map((p: any) => [p.code, p]))
    } catch {
      // 시세 조회 실패해도 종목은 추가한다 (이후 폴링에서 채워짐)
    }

    const now = new Date().toLocaleTimeString()
    const added: DetectedStock[] = []
    const skipped: string[] = []

    setDetectedStocks(prev => {
      const existing = new Set(prev.map(s => s.code))
      const next = [...prev]
      for (const pickedStock of picked) {
        if (existing.has(pickedStock.code)) {
          skipped.push(pickedStock.name)
          continue
        }
        const p = priceMap.get(pickedStock.code) || {}
        const price = p.price ?? 0
        const change = p.change ?? 0
        const changePercent = p.changePercent ?? 0
        const stock: DetectedStock = {
          code: pickedStock.code,
          name: pickedStock.name || p.name || pickedStock.code,
          price,
          change,
          changePercent,
          volume: p.volume ?? 0,
          openPrice: p.openPrice,
          highPrice: p.highPrice,
          prevClose: p.prevClose ?? (price - change),
          detectedCondition: '수동추가',
          detectedTime: now,
          startPrice: price,
          detectedChangePercent: changePercent,
        }
        next.push(stock)
        added.push(stock)
      }
      return next
    })

    // 시세를 못 받아온 종목은 한 번 더 보강
    const missing = picked.filter(s => !(priceMap.get(s.code)?.price))
    if (missing.length > 0) enrichOpenHigh(missing.map(s => s.code))

    if (added.length > 0) addLog(`수동 종목 추가: ${added.map(s => s.name).join(', ')}`, 'success')
    if (skipped.length > 0) addLog(`이미 검색된 종목: ${skipped.join(', ')}`, 'warning')

    setManualSelectedCodes(new Set())
  }

  // 수동 추가 종목 해제 (검색된 종목 목록에서 제거)
  const handleManualRemove = (code: string, name: string) => {
    setDetectedStocks(prev => prev.filter(s => s.code !== code))
    setManualSelectedCodes(prev => {
      if (!prev.has(code)) return prev
      const next = new Set(prev)
      next.delete(code)
      return next
    })
    addLog(`수동 종목 삭제: ${name} (${code})`, 'info')
  }

  // 조건식 검색 결과로 목록을 교체하되, 수동 추가 종목은 유지한다
  const applyConditionResults = (newStocks: DetectedStock[]) => {
    setDetectedStocks(prev => {
      const manual = prev.filter(s => s.detectedCondition === '수동추가')
      const codes = new Set(newStocks.map(s => s.code))
      return [...manual.filter(s => !codes.has(s.code)), ...newStocks]
    })
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
          change: changeFromRate(stock.price, stock.changeRate),
          changePercent: stock.changeRate,
          volume: stock.volume,
          openPrice: stock.openPrice,
          highPrice: stock.highPrice,
          detectedCondition: result.appliedConditions.join(', '),
          detectedTime: new Date().toLocaleTimeString(),
          startPrice: stock.price, // 자동매매 시작 시점의 가격 저장
          detectedChangePercent: stock.changeRate, // 조건 감지 시점의 등락률 저장 (매수 조건 비교용)
        }))
        
        applyConditionResults(newStocks)
        
        // 조건검색 시간 기록 (차트 데이터 조회 지연용)
        lastSearchTimeRef.current = Date.now()
        
        // 시가/고가 즉시 보강 (순위정보에는 없는 값)
        enrichOpenHigh(newStocks.map(s => s.code))
        
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

  // 0. My_매수신호_1 함수 (이동평균선 기반 간단한 매수 신호)
  const My_매수신호_1 = async (stock: DetectedStock, candles: CandleData[]): Promise<boolean> => {
    try {
      // 분봉 데이터 유효성 체크 (최소 20개 필요)
      if (!candles || candles.length < 20) {
        return false
      }

      // 이동평균선 계산 (MA5, MA20)
      const ma5 = calculateMA(candles, 5, '종가')
      const ma20 = calculateMA(candles, 20, '종가')

      if (ma5.length < 2 || ma20.length < 2) {
        return false
      }

      // 상승봉 카운트 계산 (최근 3개 봉 중)
      let 상승봉카운트 = 0
      for (let i = 0; i < Math.min(3, candles.length); i++) {
        if (candles[i].종가 > candles[i].시가) {
          상승봉카운트++
        }
      }

      // 현재가 상승 여부 확인
      const 현재가 = stock.price
      const 현재봉시가 = candles[0].시가
      const 현재가상승 = 현재가 > 현재봉시가

      // MA5가 MA20 위에 있는지 확인
      const ma5Above = ma5[0] > ma20[0]

      // 매수 신호 조건: (MA5 > MA20 && 상승봉카운트 >= 3 && 현재가상승)
      // C# 코드에서는 차트 패턴 분석도 포함하지만, 여기서는 기본 조건만 구현
      if (ma5Above && 상승봉카운트 >= 3 && 현재가상승) {
        const ma5ma20비율 = ((ma5[0] / ma20[0]) - 1) * 100
        addLog(`[매수신호1] ${stock.name}: MA5/MA20 상승비율:${ma5ma20비율.toFixed(2)}%, 연속상승봉:${상승봉카운트}개, 현재가:${현재가.toLocaleString()}원`, 'success')
        return true
      }

      return false
    } catch (error: any) {
      console.error(`[My_매수신호_1] ${stock.name} 오류:`, error)
      return false
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

  // 매수 가능 시간 여부 (최신 ref 기준 - 인터벌 클로저 대응)
  const isBuyTimeNow = () => {
    const g = timeGateRef.current
    const d = new Date()
    const sec = hmsToSec(d.getHours(), d.getMinutes(), d.getSeconds())
    if (g.buyStopped) return false
    if (!secInRange(sec, hmsToSec(g.startHour, g.startMinute), hmsToSec(g.endHour, g.endMinute, g.endSecond))) return false
    if (g.pauseBuyEnabled && secInRange(sec, hmsToSec(g.pauseStartHour, g.pauseStartMinute), hmsToSec(g.pauseEndHour, g.pauseEndMinute))) return false
    return true
  }

  // 매수 조건 확인 함수 (async로 변경)
  const checkBuyConditions = async (stock: DetectedStock): Promise<boolean> => {
    // 기본 매수 조건 체크 (C# 코드의 기존매수조건확인과 동일)
    // 1. 이미 보유 중인 종목은 제외 (C# 코드: b계좌보유중 || 매수주문했거나보유중인종목.Contains)
    if (stock.isHolding || orderedOrHoldingRef.current.has(stock.code)) {
      return false
    }
    
    // 2. holdingStocks에도 있는지 확인 (이중 체크)
    if (holdingStocksRef.current.some(h => h.code === stock.code)) {
      return false
    }

    // 3. 최대 동시 보유 종목 수 체크
    if (holdingStocksRef.current.length >= maxSimultaneousBuy) {
      return false
    }

    // 3. 매매 시간 체크 (시작/종료 + 시간대정지 + 즉시 매수정지)
    if (!isBuyTimeNow()) {
      return false
    }

    // 전략별 시간 구간 비교용 (분 단위)
    const nowForStrategy = new Date()
    const currentTime = nowForStrategy.getHours() * 60 + nowForStrategy.getMinutes()

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
    // 차트 분석이 필요한 알고리즘: My_매수신호_1, 장시작급등주, 볼린저밴드, 스캘핑, 돌파매매, 장마감종가배팅
    // 기본매수설정은 차트 분석이 필요 없음 (등락률 차이만 확인)
    const 차트분석필요알고리즘 = [
      buyFormula1,           // My_매수신호_1 (이동평균선 기반)
      // 전략 6종은 매수수식 2가 켜져 있을 때만 동작하므로 함께 묶는다
      buyFormula2 && strategyMarketOpen,   // 장시작급등주
      buyFormula2 && strategyBollinger,    // 볼린저밴드
      buyFormula2 && strategyScalping,     // 스캘핑
      buyFormula2 && strategyBreakout,     // 돌파매매
      buyFormula2 && strategyMarketClose   // 장마감종가배팅
    ]
    
    const 차트분석필요 = 차트분석필요알고리즘.some(checked => checked)
    
    let candles: CandleData[] = []
    const maxRetries = 2 // 최대 2번 재시도
    let retryCount = 0
    
    // 차트 분석이 필요한 알고리즘이 체크되어 있으면 차트 데이터 조회
    // 단, 조건검색 직후 5초 이내에는 차트 데이터 조회를 지연시켜 API 제한 방지 (10초 -> 5초로 단축)
    if (차트분석필요) {
      const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
      if (timeSinceLastSearch < 5000) {
        // 조건검색 직후 5초 이내에는 차트 데이터 조회하지 않음 (실시간 시세 기반으로 진행)
        if (process.env.NODE_ENV === 'development') {
          console.log(`[차트 데이터] ${stock.name}: 조건검색 직후 대기 중 (${Math.ceil((5000 - timeSinceLastSearch) / 1000)}초 남음), 실시간 시세 기반으로 진행`)
        }
        // 차트 데이터 없이 진행 (실시간 시세 기반으로만 판단)
      } else {
        while (retryCount <= maxRetries && candles.length === 0) {
          try {
            // 차트 분석이 필요한 종목에 대해 차트 데이터 조회 시도
            candles = await getCandleData(stock.code)
            
            // API 제한 방지를 위한 추가 딜레이 (500ms -> 1000ms로 증가)
            await new Promise(resolve => setTimeout(resolve, 1000))
            
            if (candles && candles.length > 0) {
              // 체크된 알고리즘 중 가장 많은 차트 데이터가 필요한 알고리즘의 최소 요구사항 확인
              const requiredPeriods: number[] = []
              if (buyFormula1) requiredPeriods.push(20) // My_매수신호_1은 최소 20개 필요
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
            
            // API 제한 에러(429)는 재시도하지 않고 즉시 실시간 시세 기반으로 진행
            if (error.response?.status === 429 || error.response?.data?.return_code === 5) {
              if (process.env.NODE_ENV === 'development') {
                console.log(`[차트 데이터] ${stock.name}: API 제한으로 차트 데이터 조회 중단, 실시간 시세 기반으로 진행`)
              }
              addLog(`[차트 데이터] ${stock.name}: API 제한으로 차트 데이터 없이 진행`, 'warning')
              break
            }
          }
          
          // 재시도 전 대기 (API 호출 제한 방지) - 재시도 횟수에 따라 대기 시간 증가
          if (retryCount < maxRetries && candles.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))) // 1초, 2초 대기
          }
          
          retryCount++
        }
        
        // 차트 데이터가 없으면 실시간 시세 기반 로직으로 fallback
        if (candles.length === 0) {
          if (process.env.NODE_ENV === 'development') {
            console.log(`[차트 데이터] ${stock.name}: 차트 데이터 없음, 실시간 시세 기반으로 진행`)
          }
          // 차트 데이터가 없어도 실시간 시세 기반 매수 조건 확인은 계속 진행됨
        }
      }
    }

    // 5. My_매수신호_1 로직 적용 (이동평균선 기반 간단한 매수 신호)
    // My_매수신호_1은 차트 데이터가 필요하므로 차트 데이터가 있을 때만 실행
    if (buyFormula1 && candles.length >= 20) {
      const 매수신호1결과 = await My_매수신호_1(stock, candles)
      if (매수신호1결과) {
        return true // My_매수신호_1이 발생하면 즉시 매수 신호 반환
      }
    }

    // 6. My_매수신호_2 로직 적용: 체크된 매매 전략별 조건 확인
    let 매수신호 = false

    // 기본매수설정이 체크되어 있고, 등락률 차이가 0% 이하이면 다른 알고리즘의 매수 신호를 무시
    // 기본매수설정: 등락률 차이가 2% 이상 15% 이하로 상승한 종목만 매수
    // 단, 등락률차이가 0%인 경우(변화 없음)에는 다른 알고리즘도 실행 가능하도록 허용
    const 기본매수설정차단 = strategyBasicBuy && 등락률차이 < 0 // 0% 이하 -> 0% 미만으로 변경 (0%는 허용)

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
    if (!기본매수설정차단 && buyFormula2 && 장시작직후 && strategyMarketOpen) {
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
      if (buyFormula2 && strategyBollinger) {
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
      if (buyFormula2 && strategyScalping) {
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
      if (buyFormula2 && strategyBreakout) {
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
      if (!기본매수설정차단 && buyFormula2 && 장마감종가배팅 && strategyMarketClose) {
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

    // 4. 기본매수설정 체크 (매수수식 2 + strategyBasicBuy가 체크되어 있을 때만 적용)
    // 매매설정의 % 값은 조건 감지 시점 등락률과 현재 등락률의 차이를 의미함
    // 기본매수설정: 등락률 차이가 2% 이상 15% 이하로 상승한 종목만 매수
    if (buyFormula2 && strategyBasicBuy) {
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
        // 단, 이미 다른 알고리즘에서 매수 신호가 발생한 경우는 유지
        if (등락률차이 <= 0) {
          // 기본매수설정이 체크되어 있고 등락률 차이가 0% 이하면 다른 알고리즘의 매수 신호를 무시
          // 하지만 이미 매수신호가 true인 경우는 유지 (다른 알고리즘이 먼저 신호를 발생시킨 경우)
          if (!매수신호) {
            // 다른 알고리즘에서도 매수 신호가 없었던 경우에만 차단
            if (process.env.NODE_ENV === 'development') {
              console.log(`[매수조건] ${stock.name}: 기본매수설정 차단 (등락률차이: ${등락률차이.toFixed(2)}%, 다른 알고리즘 매수신호 없음)`)
            }
          } else {
            // 다른 알고리즘에서 매수 신호가 발생한 경우는 유지
            if (process.env.NODE_ENV === 'development') {
              console.log(`[매수조건] ${stock.name}: 기본매수설정 조건 불충족하지만 다른 알고리즘 매수신호 유지 (등락률차이: ${등락률차이.toFixed(2)}%)`)
            }
          }
        }
      }
    }

    // 매수 신호 결과 로그 출력
    if (매수신호) {
      console.log(`[매수조건] ${stock.name}: 매수 신호 발생 ✓ (차트데이터: ${candles.length}개, 등락률차이: ${등락률차이.toFixed(2)}%, 상대변화율: ${상대변화율.toFixed(2)}%, 가격: ${실시간가격.toLocaleString()}원)`)
    } else {
      console.log(`[매수조건] ${stock.name}: 매수 신호 없음 (차트데이터: ${candles.length}개, 등락률차이: ${등락률차이.toFixed(2)}%, 상대변화율: ${상대변화율.toFixed(2)}%, 가격: ${실시간가격.toLocaleString()}원)`)
    }

    return 매수신호
  }

  // 단계별 익절/손절 판단 (C# 키움데이터수신처리.cs 727~790행 로직)
  // 실행 루프가 시작 시점 클로저를 쓰므로 최신 설정은 ref에서 읽는다
  // 반환: 매도할 수량과 사유. 조건 미충족이면 null
  const getStepSellPlan = (holding: HoldingStock): { quantity: number; reason: string } | null => {
    const tier = stepSellTier(holding.profitPercent, stepProfitRef.current, stepSoldRef.current.get(holding.code) || 0)
    if (!tier) return null
    stepSoldRef.current.set(holding.code, tier.step) // 이후 단계만 진행되도록 확정
    return { quantity: Math.ceil(holding.quantity * tier.ratio), reason: tier.reason }
  }

  // 매도 단계 기록 정리 (보유 목록에서 사라진 종목)
  useEffect(() => {
    const codes = new Set(holdingStocks.map(h => h.code))
    for (const code of Array.from(stepSoldRef.current.keys())) {
      if (!codes.has(code)) stepSoldRef.current.delete(code)
    }
  }, [holdingStocks])

  // 매도 조건 확인 함수 (My_매도신호_1 로직 적용)
  const checkSellConditions = (holding: HoldingStock): boolean => {
    // 매도수식이 하나도 선택되어 있지 않으면 자동 매도하지 않는다
    // (사용자가 매도수식 1·2를 모두 해제한 경우)
    if (!sellFormula1 && !sellFormula2) return false

    // 최고 수익률 갱신
    if (holding.profitPercent > holding.maxProfitPercent) {
      holding.maxProfitPercent = holding.profitPercent
    }
    const 최고수익률 = holding.maxProfitPercent

    // 1. 트레일링 스탑 조건 체크 (매도수식 2: 트레일링 매도 조건)
    // checkBox_Trailing매도.Checked && 최고수익률 >= numericUpDown_Trailing매도기준.Value
    if (sellFormula2 && trailingStop && 최고수익률 >= trailingProfitThreshold) {
      const 하락률기준 = Math.abs(trailingDropThreshold) // numericUpDown_Trailing최고점대비.Value
      const 현재하락률 = 최고수익률 - holding.profitPercent
      
      if (현재하락률 >= 하락률기준) {
        addLog(`[매도신호2] ${holding.name}: 트레일링 매도 - 최고수익률: ${최고수익률.toFixed(2)}% → 현재수익률: ${holding.profitPercent.toFixed(2)}% (하락률: ${현재하락률.toFixed(2)}%)`, 'warning')
        return true
      }
    }

    // 아래 익절/손절은 매도수식 1 (익절/손절 조건)
    if (!sellFormula1) return false

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
    // 목표시간 전량매도는 executeAutoTrading의 forceFullSell에서 처리하므로 여기서는 생략

    return false
  }

  // 자동매매 실행 함수
  const executeAutoTrading = async () => {
    if (!isRunning) {
      console.log('[자동매매] isRunning이 false입니다')
      return
    }
    
    // API 제한 에러가 발생한 경우 즉시 종료
    if (apiLimitErrorRef.current) {
      console.log('[자동매매] API 제한 에러로 인해 일시 중지됨')
      return
    }
    
    if (!selectedAccount) {
      console.log('[자동매매] 계좌가 선택되지 않았습니다')
      return
    }

    try {
      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'

      // 1. 조건식 검색 실행 (주기적으로)
      const enabledConditions = conditions.filter(c => c.enabled)
      if (enabledConditions.length === 0) {
        console.log('[자동매매] 활성화된 조건식이 없습니다')
        // 조건식이 없어도 기존 detectedStocks에 대해 매수 조건 확인은 계속 진행
      } else {
        const result = await kiwoomApi.searchCondition(enabledConditions)
        
        if (result.success && result.stocks && result.stocks.length > 0) {
          // 검색된 종목 업데이트
          // 기존 종목의 시작 가격과 감지 시점 등락률은 유지하고, 새로 검색된 종목만 설정
          // newStocks를 먼저 계산 (setDetectedStocks 밖에서)
          // ref를 통해 최신 값을 가져옴 (클로저 문제 방지)
          const prevStocks = detectedStocksRef.current // 현재 상태 가져오기
          const existingStartPrices = new Map(prevStocks.map(s => [s.code, s.startPrice]))
          const existingDetectedChangePercent = new Map(prevStocks.map(s => [s.code, s.detectedChangePercent]))
          
          const newStocks: DetectedStock[] = result.stocks.map((stock: any) => {
            const existingStock = prevStocks.find(s => s.code === stock.code)
            return {
              code: stock.code,
              name: stock.name,
              price: stock.price,
              change: changeFromRate(stock.price, stock.changeRate),
              changePercent: stock.changeRate,
              volume: stock.volume,
              openPrice: stock.openPrice,
              highPrice: stock.highPrice,
              detectedCondition: result.appliedConditions.join(', '),
              detectedTime: existingStock?.detectedTime || new Date().toLocaleTimeString(),
              // 기존 종목이면 시작 가격 유지, 새 종목이면 현재 가격을 시작 가격으로 설정
              startPrice: existingStartPrices.get(stock.code) || stock.price,
              // 기존 종목이면 감지 시점 등락률 유지, 새 종목이면 현재 등락률을 감지 시점 등락률로 설정
              detectedChangePercent: existingDetectedChangePercent.get(stock.code) ?? stock.changeRate
            }
          })
          
          // 상태 업데이트 (수동 추가 종목은 조건식 결과와 무관하게 유지)
          applyConditionResults(newStocks)

          // 조건검색 시간 기록 (차트 데이터 조회 지연용)
          lastSearchTimeRef.current = Date.now()

          // 시가/고가 즉시 보강 (순위정보에는 없는 값)
          enrichOpenHigh(newStocks.map(s => s.code))
          
          console.log(`[자동매매] 조건식 검색 완료: ${newStocks.length}개 종목`)
        } else {
          console.log('[자동매매] 조건식 검색 결과가 없습니다')
        }
      }

      // 2. 매수 조건 확인 및 실행 (차트 데이터 기반으로 수행)
      // detectedStocks가 있으면 해당 종목들에 대해 매수 조건 확인
      // ref를 통해 최신 값을 가져옴 (클로저 문제 방지)
      const currentDetectedStocks = detectedStocksRef.current
      const stocksToCheck = currentDetectedStocks.length > 0 ? currentDetectedStocks : []
      
      if (stocksToCheck.length === 0) {
        console.log('[자동매매] 확인할 종목이 없습니다')
        return
      }
      
      // 예수금 체크 (매수 가능 여부 확인) - 경고만 표시하고 계속 진행
      if (accountInfoData?.deposit !== undefined && accountInfoData?.deposit !== null) {
        const depositStr = String(accountInfoData.deposit).trim()
        const availableDeposit = depositStr ? parseInt(depositStr, 10) : 0
        const minimumRequired = amountPerStock // 최소 1종목 매수 금액
        
        console.log(`[예수금 확인] 예수금: ${availableDeposit.toLocaleString()}원, 종목당 투자금액: ${amountPerStock.toLocaleString()}원`)
        
        if (isNaN(availableDeposit) || availableDeposit < minimumRequired) {
          addLog(`[예수금 경고] 예수금이 부족할 수 있습니다. (예수금: ${availableDeposit.toLocaleString()}원, 최소 필요: ${minimumRequired.toLocaleString()}원)`, 'warning')
          console.log(`[자동매매] 예수금이 부족할 수 있지만 매수 시도는 계속합니다 (서버에서 최종 판단)`)
          // 경고만 표시하고 계속 진행 (서버에서 실제 예수금 체크)
        }
      } else {
        console.log(`[예수금] accountInfoData.deposit이 없습니다. 서버에서 예수금 체크를 진행합니다.`)
      }
      
      console.log(`[자동매매] ${stocksToCheck.length}개 종목에 대해 매수 조건 확인 시작`)
      addLog(`[자동매매] ${stocksToCheck.length}개 종목 매수 조건 확인 시작`, 'info')
      
      // API 제한을 고려하여 종목별로 딜레이 추가
      for (let i = 0; i < stocksToCheck.length; i++) {
            const stock = stocksToCheck[i]
            // isRunning 상태 확인 (API 제한 에러로 중지된 경우 즉시 종료)
            if (!isRunning) {
              console.log(`[자동매매] isRunning이 false입니다. 루프 종료`)
              break // 중지되면 중단
            }
            
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
            
            // 매매제한 종목 체크 (이전에 매매제한으로 판단된 종목은 재시도하지 않음)
            if (restrictedStocks.has(stock.code)) {
              continue // 매매제한 종목은 건너뜀
            }
            
            // 주문 처리 중인 종목 체크 (중복 주문 방지)
            if (processingOrders.has(stock.code) || processingOrdersRef.current.has(stock.code)) {
              console.log(`[자동매수 건너뜀] ${stock.name} (${stock.code}): 이미 주문 처리 중입니다`)
              continue // 이미 주문 처리 중인 종목은 건너뜀
            }
            
            // API 제한 에러 플래그 확인 (에러 발생 시 즉시 종료)
            if (apiLimitErrorRef.current) {
              console.log(`[자동매매] API 제한 에러로 인해 종목 처리 중단`)
              break
            }
            
            // API 제한 방지를 위한 딜레이 (조건검색 직후에는 더 긴 딜레이)
            const timeSinceLastSearch = Date.now() - lastSearchTimeRef.current
            if (timeSinceLastSearch < 10000) {
              // 조건검색 직후 10초 이내에는 각 종목 처리 전 2초 대기
              await new Promise(resolve => setTimeout(resolve, 2000))
            } else {
              // 그 이후에는 1초 대기 (API 제한 방지)
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
            
            // API 제한 에러 플래그 재확인 (대기 중 에러 발생 가능)
            if (apiLimitErrorRef.current) {
              console.log(`[자동매매] API 제한 에러로 인해 종목 처리 중단`)
              break
            }
            
            // 차트 데이터 기반으로 매수 조건 확인 (차트 데이터를 우선적으로 사용)
            const buyConditionResult = await checkBuyConditions(stock)
            if (buyConditionResult) {
              console.log(`[자동매수] ${stock.name}: 매수 조건 확인 완료, 주문 준비 시작`)
              try {
                // 종목코드 검증: 6자리 숫자만 허용 (ELW, ETF 등 비표준 종목코드 제외)
                const stockCode = String(stock.code).trim()
                if (!/^\d{6}$/.test(stockCode)) {
                  addLog(`[자동매수 건너뜀] ${stock.name} (${stockCode}): 지원하지 않는 종목코드 형식 (6자리 숫자만 지원)`, 'warning')
                  console.log(`[자동매수] ${stock.name}: 종목코드 형식 오류로 건너뜀`)
                  continue
                }
                
                // 매수 수량 계산 (종목당 투자금액 기준)
                const buyPrice = stock.price || 0
                if (buyPrice <= 0) {
                  console.log(`[자동매수] ${stock.name}: 가격이 0 이하로 건너뜀 (가격: ${buyPrice})`)
                  continue
                }
                
                // 수수료 고려한 매수 수량 계산
                const investmentAmount = amountPerStock
                const feeRate = feePercent / 100
                const availableAmount = investmentAmount * (1 - feeRate)
                
                // 종목별 매수가격 설정에 따른 매수 가격 결정 (C# 코드의 매수가격결정 메서드 참고)
                // 기본값은 시장가로 설정하여 즉시 체결되도록 함
                let orderPrice = buyPrice
                let orderOption = '03' // 기본값: 시장가 (즉시 체결을 위해)
                
                if (buyPriceSettings.종목별매수가격설정실행) {
                  if (buyPriceSettings.매수가격옵션 === '시장가') {
                    // 시장가: 현재가 그대로 사용
                    orderPrice = buyPrice
                    orderOption = '03' // 시장가
                  } else if (buyPriceSettings.매수가격옵션 === '지정가') {
                    // 지정가: 매수호가 값 사용
                    // C# 코드: 호가비율 = 매수호가 / 100.0, 매수희망가 = 현재가 * (1.0 - 호가비율)
                    const 호가비율 = buyPriceSettings.매수호가 / 100.0
                    orderPrice = Math.floor(buyPrice * (1.0 - 호가비율))
                    
                    // 지정가가 현재가보다 높으면 체결이 어려우므로 시장가로 변경
                    if (orderPrice > buyPrice) {
                      console.warn(`[주문 가격] ${stock.name}: 지정가(${orderPrice.toLocaleString()}원)가 현재가(${buyPrice.toLocaleString()}원)보다 높아 시장가로 변경`)
                      orderPrice = buyPrice
                      orderOption = '03' // 시장가로 변경
                    } else {
                      orderOption = '00' // 지정가
                      console.log(`[주문 가격] ${stock.name}: 지정가 주문 (현재가: ${buyPrice.toLocaleString()}원, 호가비율: ${호가비율.toFixed(2)}%, 주문가격: ${orderPrice.toLocaleString()}원)`)
                    }
                  }
                } else {
                  // 설정이 비활성화된 경우 시장가 주문 사용 (즉시 체결을 위해)
                  orderPrice = buyPrice
                  orderOption = '03' // 시장가 (현금/신용 모두 시장가로 통일)
                  console.log(`[주문 가격] ${stock.name}: 종목별매수가격설정 비활성화 - 시장가 주문 사용 (현재가: ${buyPrice.toLocaleString()}원)`)
                }
                
                // 주문 수량 계산: (투자금액 * (1 - 수수료율)) / 주문가격
                const quantity = Math.floor(availableAmount / orderPrice)
                
                // 주문 수량 계산 상세 로그
                console.log(`[주문 수량 계산] ${stock.name}:`, {
                  투자금액: `${investmentAmount.toLocaleString()}원`,
                  수수료율: `${(feeRate * 100).toFixed(2)}%`,
                  수수료제외금액: `${availableAmount.toLocaleString()}원`,
                  현재가: `${buyPrice.toLocaleString()}원`,
                  주문가격: `${orderPrice.toLocaleString()}원`,
                  계산된수량: `${quantity}주`,
                  총주문금액: `${(quantity * orderPrice).toLocaleString()}원`,
                })
                
                if (quantity <= 0) {
                  console.log(`[자동매수] ${stock.name}: 수량이 0 이하로 건너뜀 (수량: ${quantity}, 투자금액: ${investmentAmount}, 주문가격: ${orderPrice})`)
                  addLog(`[자동매수 건너뜀] ${stock.name}: 수량 부족 (투자금액: ${investmentAmount.toLocaleString()}원, 주문가격: ${orderPrice.toLocaleString()}원)`, 'warning')
                  continue
                }

                console.log(`[자동매수] ${stock.name}: 주문 전송 시작 (종목코드: ${stockCode}, 수량: ${quantity}, 가격: ${orderPrice}, 옵션: ${orderOption}, 계좌: ${accountNo})`)
                
                // 주문 API 요청 제한 방지: 마지막 주문 시간 확인
                const timeSinceLastOrder = Date.now() - lastOrderTimeRef.current
                if (timeSinceLastOrder < minOrderInterval) {
                  const waitTime = minOrderInterval - timeSinceLastOrder
                  console.log(`[주문 제한] 마지막 주문 후 ${timeSinceLastOrder}ms 경과, ${waitTime}ms 대기 후 주문 진행`)
                  addLog(`[주문 제한] API 요청 제한 방지를 위해 ${Math.ceil(waitTime / 1000)}초 대기`, 'info')
                  await new Promise(resolve => setTimeout(resolve, waitTime))
                }
                
                // 주문 처리 중 상태로 표시 (중복 방지)
                processingOrdersRef.current.add(stockCode)
                setProcessingOrders(prev => new Set(prev).add(stockCode))
                
                // 매수 주문 실행
                let orderResult
                try {
                  orderResult = await kiwoomApi.placeOrder({
                    code: stockCode,
                    quantity: quantity,
                    price: orderPrice,
                    order_type: 'buy',
                    order_option: orderOption,
                    accountNo,
                    accountProductCode,
                  })
                  console.log(`[자동매수] ${stock.name}: 주문 전송 완료`, orderResult)
                  
                  // 주문 성공 시 마지막 주문 시간 업데이트 (API 요청 제한 방지)
                  lastOrderTimeRef.current = Date.now()
                } catch (orderError: any) {
                  // 에러 상세 정보 로깅 (항상 실행되도록 보장)
                  const errorDetail = orderError.response?.data?.detail || orderError.response?.data?.error || orderError.message || '알 수 없는 오류'
                  const errorCode = orderError.response?.data?.code || stockCode
                  const isMockApiLimit = orderError.response?.data?.isMockApiLimit || false
                  const isTradingRestricted = orderError.response?.data?.isTradingRestricted || false
                  const statusCode = orderError.response?.status || 'N/A'
                  
                  // 상세 에러 로그 출력 (항상 실행)
                  console.error(`[자동매수 실패] ${stock.name} (${stockCode}):`, {
                    에러메시지: errorDetail,
                    종목코드: errorCode,
                    수량: quantity,
                    가격: orderPrice,
                    상태코드: statusCode,
                    isMockApiLimit,
                    isTradingRestricted,
                    전체응답: orderError.response?.data,
                    에러객체: orderError,
                  })
                  
                  // 매수증거금 부족 에러인 경우
                  if (errorDetail.includes('매수증거금이 부족') || 
                      errorDetail.includes('RC4025') ||
                      errorDetail.includes('증거금 부족')) {
                    const currentDeposit = accountInfoData?.deposit ? parseInt(String(accountInfoData.deposit).trim(), 10) : 0
                    addLog(`[예수금 부족] ${stock.name} 매수 불가 - 예수금이 부족합니다. (현재 예수금: ${currentDeposit.toLocaleString()}원, 주문금액: ${(quantity * orderPrice).toLocaleString()}원)`, 'warning')
                    console.log(`[자동매매] ${stock.name} 예수금 부족으로 건너뜀`)
                    // 주문 처리 중 상태 해제
                    processingOrdersRef.current.delete(stockCode)
                    setProcessingOrders(prev => {
                      const updated = new Set(prev)
                      updated.delete(stockCode)
                      return updated
                    })
                    // 해당 종목만 건너뛰고 다음 종목 계속 시도
                    continue
                  }
                  
                  // API 요청 제한 에러인 경우
                  if (errorDetail.includes('허용된 요청 개수를 초과') || 
                      errorDetail.includes('요청 개수를 초과') ||
                      statusCode === 429 ||
                      orderError.response?.status === 429) {
                    // API 제한 에러 플래그 설정
                    apiLimitErrorRef.current = true
                    // API 제한 에러 발생 시 일정 시간 동안 요청 중단
                    addLog(`[API 제한] 요청 제한에 걸렸습니다. 90초간 대기합니다.`, 'error')
                    // API 제한 에러 발생 시 자동매매 일시 중지 (90초 후 자동 재개)
                    setIsRunning(false)
                    setTimeout(() => {
                      apiLimitErrorRef.current = false // API 제한 에러 플래그 해제
                      setIsRunning(true)
                      addLog(`[API 제한 해제] 자동매매를 재개합니다.`, 'info')
                    }, 90000) // 90초 대기 (더 긴 대기 시간)
                    // 주문 처리 중 상태 해제
                    processingOrdersRef.current.delete(stockCode)
                    setProcessingOrders(prev => {
                      const updated = new Set(prev)
                      updated.delete(stockCode)
                      return updated
                    })
                    // 현재 루프 즉시 중단 및 함수 종료
                    return // executeAutoTrading 함수 전체 종료
                  }
                  
                  // 모의투자 환경 제한 에러인 경우 매매제한 종목으로 추가
                  if (isMockApiLimit || 
                      isTradingRestricted ||
                      orderError.message?.includes('모의투자 환경 제한') ||
                      orderError.message?.includes('매매제한 종목') ||
                      orderError.message?.includes('RC4007') ||
                      statusCode === 503) {
                    setRestrictedStocks(prev => new Set(prev).add(stock.code))
                    addLog(`[자동매수 건너뜀] ${stock.name}: 모의투자 매매 제한 종목 (${errorDetail})`, 'warning')
                  } else {
                    // 일반 에러인 경우에도 매매제한 종목으로 추가하여 재시도 방지
                    setRestrictedStocks(prev => new Set(prev).add(stock.code))
                    addLog(`[자동매수 실패] ${stock.name}: ${errorDetail} (상태코드: ${statusCode})`, 'error')
                  }
                  
                  // 에러 발생 시 주문 처리 중 상태 해제
                  processingOrdersRef.current.delete(stockCode)
                  setProcessingOrders(prev => {
                    const updated = new Set(prev)
                    updated.delete(stockCode)
                    return updated
                  })
                  
                  // 에러 발생 시 다음 종목으로 진행
                  continue
                }

                // 주문 내역 즉시 갱신 (주문번호가 있는 경우)
                if (orderResult?.orderNumber) {
                  // 주문번호 중복 체크
                  const orderNumber = orderResult.orderNumber
                  const isMarketOrderValue = orderOption === '03' // 시장가 주문 여부 (스코프 밖에서 사용하기 위해 여기서 정의)
                  
                  setProcessedOrderNumbers(prev => {
                    if (prev.has(orderNumber)) {
                      console.log(`[주문 내역] 중복 주문번호 감지 - ${stock.name} (주문번호: ${orderNumber}) 이미 처리됨, 건너뜀`)
                      // 주문 처리 중 상태 해제
                      processingOrdersRef.current.delete(stockCode)
                      setProcessingOrders(prevOrders => {
                        const updated = new Set(prevOrders)
                        updated.delete(stockCode)
                        return updated
                      })
                      return prev
                    }
                    const updated = new Set(prev).add(orderNumber)
                    
                    // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로, 로컬 상태에 직접 추가
                    const orderTimestamp = Date.now() // 주문 접수 시점 기록
                    const newOrder: OrderLog = {
                      id: Date.now(), // 고유 ID 생성
                      date: new Date().toLocaleDateString('ko-KR'),
                      time: new Date().toLocaleTimeString('ko-KR'),
                      type: 'buy',
                      stockName: stock.name,
                      stockCode: stockCode,
                      quantity: quantity,
                      price: orderPrice,
                      status: '접수', // 주문 접수 상태
                      orderNumber: orderNumber,
                      orderTimestamp, // 주문 접수 시점 기록
                      isMarketOrder: isMarketOrderValue, // 시장가 주문 여부
                      unfilledQuantity: quantity, // 초기 미체결수량은 주문수량과 동일
                    }
                    
                    // 주문 내역에 추가 (중복 체크: 주문번호 및 ID 기준)
                    setOrderLogs(prevLogs => {
                      // 이미 같은 주문번호가 있으면 추가하지 않음
                      const existingOrder = prevLogs.find(o => o.orderNumber === newOrder.orderNumber)
                      if (existingOrder) {
                        console.log(`[주문 내역] 중복 주문 감지 - ${stock.name} (주문번호: ${newOrder.orderNumber}) 이미 존재함, 건너뜀`)
                        return prevLogs
                      }
                      // 같은 ID가 있으면 추가하지 않음 (추가 안전장치)
                      const existingById = prevLogs.find(o => o.id === newOrder.id)
                      if (existingById) {
                        console.log(`[주문 내역] 중복 ID 감지 - ${stock.name} (ID: ${newOrder.id}) 이미 존재함, 건너뜀`)
                        return prevLogs
                      }
                      const updatedLogs = [newOrder, ...prevLogs]
                      console.log(`[주문 내역] 로컬 상태에 주문 추가 완료 - 총 주문 개수: ${updatedLogs.length}`, newOrder)
                      
                      // C# 코드와 동일: 매수 주문 성공 시 매수주문했거나보유중인종목에 추가
                      setOrderedOrHoldingStocks(prev => new Set(prev).add(stockCode))
                      console.log(`[보유 종목 관리] ${stock.name} (${stockCode}): 매수 주문 성공 - 매수주문했거나보유중인종목에 추가`)
                      return updatedLogs
                    })
                    
                    // 주문한 종목을 검색된 종목에서 제거 (중복 제거 방지)
                    setDetectedStocks(prevStocks => {
                      // 이미 제거되었는지 확인
                      const exists = prevStocks.some(s => s.code === stockCode)
                      if (!exists) {
                        console.log(`[검색된 종목] 이미 제거됨 - ${stock.name} (${stockCode}), 건너뜀`)
                        return prevStocks
                      }
                      const filtered = prevStocks.filter(s => s.code !== stockCode)
                      console.log(`[검색된 종목] 주문한 종목 제거 - ${stock.name} (${stockCode}) 제거됨, 남은 종목: ${filtered.length}개`)
                      return filtered
                    })
                    
                    // 주문 처리 중 상태 해제
                    processingOrdersRef.current.delete(stockCode)
                    setProcessingOrders(prevOrders => {
                      const updated = new Set(prevOrders)
                      updated.delete(stockCode)
                      return updated
                    })
                    
                    return updated
                  })
                  
                  // 시장가 매수 주문은 즉시 체결되어야 하므로, 주문 후 즉시 보유종목 조회하여 체결 확인
                  if (isMarketOrderValue) {
                    console.log(`[시장가 매수] ${stock.name}: 즉시 체결 확인을 위한 보유종목 조회 실행 (주문번호: ${orderNumber})`)
                    // 시장가 매수는 즉시 체결되므로 여러 번 보유종목 조회 (체결 확인을 위해)
                    // 1초, 2초, 3초 후 각각 조회하여 체결 여부 확인
                    const checkExecution = async (delay: number, attempt: number) => {
                      setTimeout(async () => {
                        try {
                          console.log(`[시장가 매수] ${stock.name}: 보유종목 조회 시도 ${attempt}회 (${delay}ms 후)`)
                          const result = await refetchBalance()
                          console.log(`[시장가 매수] ${stock.name}: 보유종목 조회 완료 ${attempt}회 - 체결 여부 확인됨`, result)
                        } catch (error) {
                          console.error(`[시장가 매수] ${stock.name}: 보유종목 조회 실패 ${attempt}회`, error)
                        }
                      }, delay)
                    }
                    
                    // 여러 번 조회하여 체결 확인 (1초, 2초, 3초 후)
                    checkExecution(1000, 1)
                    checkExecution(2000, 2)
                    checkExecution(3000, 3)
                  } else {
                    // 지정가 주문은 체결까지 시간이 걸릴 수 있으므로 주기적 조회에 의존
                    console.log(`[지정가 매수] ${stock.name}: 주기적 보유종목 조회에 의존 (주문번호: ${orderNumber})`)
                  }
                  
                  // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로 refetch 호출하지 않음
                  // (refetch하면 빈 배열이 반환되어 기존 주문이 사라질 수 있음)
                  // 실전 환경에서는 아래 주석을 해제하여 주문 내역 조회
                  // setTimeout(() => {
                  //   refetchOrders()
                  //   queryClient.invalidateQueries(['orders', selectedAccount])
                  // }, 1000)
                }

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

                const priceTypeText = buyPriceSettings.종목별매수가격설정실행 
                  ? (buyPriceSettings.매수가격옵션 === '시장가' ? '시장가' : `지정가(${orderPrice.toLocaleString()}원)`)
                  : `지정가(${orderPrice.toLocaleString()}원)`
                addLog(`[자동매수] ${stock.name} ${quantity}주 매수 주문 (${priceTypeText}, 주문번호: ${orderResult?.orderNumber || 'N/A'}, 매매횟수: ${tradeCount + 1}/${tradeLimitPerStock})`, 'success')
                
                // API 호출 제한을 위한 딜레이
                await new Promise(resolve => setTimeout(resolve, 500))
              } catch (error: any) {
                // 모의투자 환경 제한 에러인 경우 경고로 처리
                const errorMessage = error.message || error.response?.data?.detail || '알 수 없는 오류'
                if (error.response?.data?.isMockApiLimit || 
                    error.message?.includes('모의투자 환경 제한') ||
                    error.message?.includes('매매제한 종목') ||
                    error.message?.includes('RC4007')) {
                  // 매매제한 종목으로 판단된 경우 Set에 추가하여 재시도 방지
                  setRestrictedStocks(prev => new Set(prev).add(stock.code))
                  addLog(`[자동매수 건너뜀] ${stock.name}: 모의투자 매매 제한 종목 (재시도 안 함)`, 'warning')
                } else {
                  addLog(`[자동매수 실패] ${stock.name}: ${errorMessage}`, 'error')
                }
              }
            }
          }

      // 3. 보유 종목 매도 조건 확인 및 실행
      const nowDate = new Date()
      const nowSecValue = hmsToSec(nowDate.getHours(), nowDate.getMinutes(), nowDate.getSeconds())
      const gate = timeGateRef.current
      // 목표시간 도달 → 전량매도 (단계별 익절 사용 중에도 우선)
      const dropSellNow = gate.dropSellTime && nowSecValue >= hmsToSec(gate.dropSellStartHour, gate.dropSellStartMinute, gate.dropSellEndSecond)
      const stepEnabled = stepProfitRef.current.사용
      // 손절은 단계별 익절 사용 여부와 무관하게 항상 적용한다.
      // (단계별 손절이 -10%여도 사용자가 설정한 -1.5%가 더 타이트하면 그쪽을 따른다)
      const hardStop = stepEnabled
        ? Math.max(lossLimit, stepProfitRef.current.손절)
        : lossLimit

      // 클로저 스냅샷이 아닌 최신 보유종목을 사용한다 (매도가 안 되던 원인)
      for (const holding of holdingStocksRef.current) {
        if (!isRunning) break // 중지되면 중단

        // 손절 기준 도달 → 전량 매도
        const stopLossHit = hardStop < 0 && holding.profitPercent <= hardStop
        const forceFullSell = dropSellNow || stopLossHit
        // 단계별 익절이 켜져 있으면 단계 로직만 사용 (C#과 동일: else-if 구조)
        const stepPlan = !forceFullSell && stepEnabled ? getStepSellPlan(holding) : null
        const sellQuantity = forceFullSell
          ? holding.quantity
          : stepPlan
            ? Math.min(stepPlan.quantity, holding.quantity)
            : holding.quantity

        if (stopLossHit) {
          addLog(`[손절] ${holding.name}: 현재 수익률 ${holding.profitPercent.toFixed(2)}% ≤ 기준 ${hardStop}% → 전량 매도`, 'warning')
        }
        
        if (forceFullSell || stepPlan || (!stepEnabled && checkSellConditions(holding))) {
          try {
            // 매도 가격 결정
            let sellPrice = 0 // 시장가
            let orderOption = '03' // 시장가
            const sellStyle = sellStyleRef.current
            
            // 강제 전량매도(목표시간 도달)는 시장가
            if (forceFullSell) {
              sellPrice = 0
              orderOption = '03'
            }
            // 단계별 익절/손절인 경우 (C# radioButton_매도_시장가/지정가 + numericUpDown_매도호가)
            else if (stepPlan) {
              const isStepLoss = stepPlan.reason === '단계별손절'
              const type = isStepLoss ? sellStyle.lossType : sellStyle.profitType
              const offset = isStepLoss ? sellStyle.lossPriceOffset : 0
              if (type === 'limit') {
                sellPrice = Math.max(0, holding.currentPrice + offset)
                orderOption = '00'
              }
            }
            // 익절인 경우
            else if (holding.profitPercent >= profitTarget) {
              if (sellStyle.profitType === 'market') {
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
              if (sellStyle.lossType === 'market') {
                sellPrice = 0
                orderOption = '03' // 시장가
              } else {
                // 지정가 매도호가 (현재가 + lossPriceOffset)
                sellPrice = Math.max(0, holding.currentPrice + sellStyle.lossPriceOffset)
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

            // 이미 미체결 매도 주문이 있으면 신규 주문 금지
            // (보유 수량이 그 주문에 묶여 매도가능수량 부족 800033으로 거부된다)
            const pendingSell = orderLogs.find(o =>
              o.stockCode === stockCode && o.type === 'sell' && isPendingSellStatus(o.status)
            )
            if (pendingSell) {
              addLog(`[자동매도 건너뜀] ${holding.name}: 미체결 매도 주문이 이미 있습니다 (주문번호: ${pendingSell.orderNumber || 'N/A'}, ${pendingSell.quantity}주)`, 'warning')
              continue
            }

            // 주문 API 요청 제한 방지: 마지막 주문 시간 확인
            const timeSinceLastOrder = Date.now() - lastOrderTimeRef.current
            if (timeSinceLastOrder < minOrderInterval) {
              const waitTime = minOrderInterval - timeSinceLastOrder
              console.log(`[주문 제한] 마지막 주문 후 ${timeSinceLastOrder}ms 경과, ${waitTime}ms 대기 후 주문 진행`)
              addLog(`[주문 제한] API 요청 제한 방지를 위해 ${Math.ceil(waitTime / 1000)}초 대기`, 'info')
              await new Promise(resolve => setTimeout(resolve, waitTime))
            }

            // 실제 보유 수량 - 미체결 매도 수량 = 매도가능수량
            // (클라이언트 로컬 수량이 크면 800033 매도가능수량 부족으로 거부된다)
            let actualSellQty = sellQuantity
            // 잔고 응답에서 확인한 평균단가. 실현손익 계산의 신뢰할 수 있는 출처다.
            let liveBuyPrice = 0
            try {
              const balance = await kiwoomApi.getBalance(accountNo, accountProductCode)
              const rows = normalizeBalanceRows(balance)
              const live = rows.find((b: any) => String(b.code ?? b.stockCode ?? b.종목코드).trim() === stockCode)
              const heldQty = Number(live?.quantity ?? live?.보유수량 ?? 0)
              const apiSellable = live?.sellableQuantity
              // 평균단가: pur_pric이 0이면 매입금액/수량으로 역산한다
              liveBuyPrice = resolveBuyPrice(
                Number(live?.purchasePrice ?? live?.매입가 ?? 0),
                {
                  purchasePrice: Number(live?.purchasePrice ?? live?.매입가 ?? 0),
                  purchaseAmount: Number(live?.purchaseAmount ?? live?.매입금액 ?? 0),
                  quantity: heldQty,
                }
              )
              if (Number.isFinite(heldQty) && heldQty > 0) {
                const pendingQty = orderLogs
                  .filter(o => o.stockCode === stockCode && o.type === 'sell' && isPendingSellStatus(o.status))
                  .reduce((sum, o) => sum + (o.quantity || 0), 0)
                const sellable = calcSellableQuantity(heldQty, pendingQty, apiSellable)
                if (sellable <= 0) {
                  addLog(`[자동매도 건너뜀] ${holding.name}: 매도가능수량이 없습니다 (보유 ${heldQty}주, 미체결 매도 ${pendingQty}주)`, 'warning')
                  continue
                }
                actualSellQty = Math.min(sellQuantity, sellable)
              } else if (Number.isFinite(heldQty) && heldQty === 0) {
                addLog(`[자동매도 건너뜀] ${holding.name}: 계좌에 보유 수량이 없습니다 (잔고 0주)`, 'warning')
                // 잔고가 없으므로 로컬 로그에서도 제거 (표에 유령 종목이 남지 않도록)
                dropLocalHolding(stockCode)
                continue
              }
            } catch (balanceError: any) {
              // 잔고 조회 실패는 주문을 막지 않는다 (서버가 최종 판단)
              console.warn(`[자동매도] ${holding.name}: 잔고 조회 실패, 로컬 수량으로 진행 - ${balanceError.message}`)
            }

            if (actualSellQty <= 0) {
              addLog(`[자동매도 건너뜀] ${holding.name}: 매도 가능 수량이 0주입니다`, 'warning')
              continue
            }

            // 매도 주문 실행 (단계별 익절은 일부 수량만 매도)
            const sellOrderResult = await kiwoomApi.placeOrder({
              code: stockCode,
              quantity: actualSellQty,
              price: sellPrice,
              order_type: 'sell',
              order_option: orderOption,
              accountNo,
              accountProductCode,
            })
            
            // 주문 성공 시 마지막 주문 시간 업데이트 (API 요청 제한 방지)
            lastOrderTimeRef.current = Date.now()

            // 주문 내역 즉시 갱신
            if (sellOrderResult?.orderNumber) {
              // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로, 로컬 상태에 직접 추가
              const orderTimestamp = Date.now() // 주문 접수 시점 기록
              const isMarketOrder = orderOption === '03' // 시장가 주문 여부
                const newOrder: OrderLog = {
                  id: Date.now(),
                  date: new Date().toLocaleDateString('ko-KR'),
                  time: new Date().toLocaleTimeString('ko-KR'),
                  type: 'sell',
                  stockName: holding.name,
                  stockCode: stockCode,
                  quantity: actualSellQty,
                  price: sellPrice,
                  status: '접수',
                  orderNumber: sellOrderResult.orderNumber,
                  orderTimestamp, // 주문 접수 시점 기록
                  isMarketOrder, // 시장가 주문 여부
                  // 매수가: 잔고에서 방금 읽은 평균단가를 최우선한다
                  // (로컬 보유종목 캐시는 오래됐거나 비어 있을 수 있다)
                  buyPrice: resolveBuyPrice(
                    liveBuyPrice || holding.purchasePrice,
                    holding,
                    orderLogs.find(o => o.type === 'buy' && o.stockCode === stockCode)?.price
                  ), // 실현손익 계산용 매수가
                  currentPrice: holding.currentPrice,
                }

              setOrderLogs(prev => {
                const updated = [newOrder, ...prev]
                console.log(`[주문 내역] 로컬 상태에 매도 주문 추가 완료 - 총 주문 개수: ${updated.length}`, newOrder)
                return updated
              })
              
              // C# 코드와 동일: 전량 매도 시에만 보유 목록에서 제거 (단계별 익절은 잔량 유지)
              if (actualSellQty >= holding.quantity) {
                setDetectedStocks(prev => prev.map(stock => 
                  stock.code === stockCode
                    ? { ...stock, isHolding: false }
                    : stock
                ))
                
                // 매도 주문 성공 시 orderedOrHoldingStocks에서 제거 (보유 수량이 0이 되면 제거)
                setOrderedOrHoldingStocks(prev => {
                  const updated = new Set(prev)
                  updated.delete(stockCode)
                  return updated
                })
              }
              
              // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로 refetch 호출하지 않음
              // setTimeout(() => {
              //   refetchOrders()
              //   queryClient.invalidateQueries(['orders', selectedAccount])
              // }, 1000)
            }

            const priceType = sellPrice === 0 ? '시장가' : `지정가(${sellPrice.toLocaleString()}원)`
            addLog(`[자동매도${stepPlan ? ` ${stepPlan.reason}` : ''}] ${holding.name} ${actualSellQty}주 매도 주문 (${priceType}, 수익률: ${holding.profitPercent.toFixed(2)}%)`, 'success')
            
            // API 호출 제한을 위한 딜레이
            await new Promise(resolve => setTimeout(resolve, 500))
          } catch (error: any) {
            // 모의투자 환경 제한 에러인 경우 경고로 처리
            // axios 에러는 message가 "Request failed with status code 500"이라
            // 서버가 내려준 실제 원인(detail/error)을 우선 사용한다
            const apiData = error.response?.data
            const errorMessage = apiData?.detail || apiData?.error || error.message || '알 수 없는 오류'
            const returnCode = apiData?.returnCode
            if (apiData?.isMockApiLimit ||
                errorMessage.includes('모의투자 환경 제한') ||
                errorMessage.includes('매매제한 종목') ||
                errorMessage.includes('RC4007')) {
              addLog(`[자동매도 건너뜀] ${holding.name}: 모의투자 매매 제한 종목`, 'warning')
            } else {
              addLog(`[자동매도 실패] ${holding.name}: ${errorMessage}${returnCode ? ` (return_code: ${returnCode})` : ''}`, 'error')
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

    // 1회 실행이 끝난 뒤에만 다음 주기를 예약한다.
    // setInterval은 실행 시간이 주기를 넘으면 다음 실행과 겹쳐 같은 종목을 중복 주문한다.
    const runOnce = async () => {
      if (isExecutingRef.current) {
        console.log('[자동매매] 이전 실행이 진행 중입니다. 이번 주기는 건너뜁니다.')
        return
      }
      isExecutingRef.current = true
      try {
        await executeAutoTrading()
      } finally {
        isExecutingRef.current = false
      }
    }

    const intervalId = window.setInterval(runOnce, 30000)
    // 첫 실행은 2초 후
    const timeoutId = window.setTimeout(runOnce, 2000)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
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
        setRestrictedStocks(new Set()) // 매매제한 종목 목록도 초기화
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
  // 현재 보유 종목 표에 실제로 표시되는 행
  // 잔고 조회가 성공하면 "계좌에 실제로 있는 종목"만 표시한다.
  // (주문 로그만 쓰면 매도 후에도 유령 종목이 남는다)
  // 보유 종목 표의 데이터 소스 결정
  //  - 잔고 조회 성공: 계좌의 실제 종목만 표시 (정답)
  //  - 잔고 조회 실패: 표를 비운다. 로그로 대체하면 이미 매도한 종목이 유령으로 남는다.
  //  - 잔고 조회 중: 로그로 대체하지 않고 "불러오는 중" 유지
  const balanceLoading = isConnected && !!selectedAccount && !balanceData && !balanceError
  const balanceHoldings = (() => {
    if (!isConnected || !selectedAccount) return null // 조회 전: 로그 기준 유지
    if (balanceError) return [] // 조회 실패: 보유 종목을 알 수 없으므로 비운다
    // 서버는 { stocks: [...] } 또는 배열을 반환한다
    const rows: any[] | null = Array.isArray(balanceData)
      ? balanceData
      : Array.isArray((balanceData as any)?.stocks)
        ? (balanceData as any).stocks
        : null
    if (!rows) return null
    // 잔고 조회에 에러가 실린 경우(모의투자 제한 등)는 신뢰할 수 없으므로 비운다
    if ((balanceData as any)?.error) return []
    return rows
      .map((b: any) => ({
        code: String(b.code ?? b.stockCode ?? b.종목코드 ?? '').trim(),
        name: String(b.name ?? b.stockName ?? b.종목명 ?? '').trim(),
        quantity: Number(b.quantity ?? b.보유수량 ?? 0),
        sellableQuantity: Number(b.sellableQuantity ?? b.quantity ?? b.보유수량 ?? 0),
        purchasePrice: Number(b.purchasePrice ?? b.매입가 ?? 0),
        currentPrice: Number(b.currentPrice ?? b.현재가 ?? 0),
        profitPercent: Number(b.profitPercent ?? b.수익률 ?? 0),
      }))
      // 매도가능수량이 0인 종목은 '보유' 표에 넣지 않는다.
      // (미체결 매도 주문이 전량 잡고 있어 팔 수 없는 상태 — 표시하면 오해를 준다)
      .filter((b: any) => b.code && b.quantity > 0 && b.sellableQuantity > 0)
  })()

  const logRows = buildDisplayOrders(orderLogs)
  const displayHoldingOrders = balanceHoldings
    ? balanceHoldings.map((b: any) => {
        const fromLog = logRows.find((r) => r.stockCode === b.code)
        // OrderLog 형태로 맞춰 표 렌더링을 그대로 재사용한다
        return {
          ...(fromLog || ({
            id: b.code,
            date: '',
            time: '',
            type: 'buy' as const,
            stockCode: b.code,
            stockName: b.name || b.code,
            quantity: b.quantity,
            price: b.purchasePrice,
            status: '체결',
            isExecuted: true,
          } as OrderLog)),
          stockCode: b.code,
          stockName: b.name || fromLog?.stockName || b.code,
          quantity: b.quantity,
          // 매도가능수량: 주문 가능한 실제 수량 (미체결 매도 주문분 제외)
          sellableQuantity: b.sellableQuantity,
          // 표는 잔고 기준 '보유' 목록이므로 상태는 항상 체결이다.
          // (로그의 '종료'/'취소' 상태를 그대로 쓰면 보유 중인데 취소로 보인다)
          status: '체결',
          isExecuted: true,
          price: b.purchasePrice || (fromLog?.price ?? 0),
          buyPrice: b.purchasePrice || fromLog?.buyPrice,
          currentPrice: b.currentPrice || fromLog?.currentPrice,
          profitPercent: b.profitPercent,
          count: fromLog?.count ?? 1,
          latestTime: fromLog?.latestTime ?? '',
        }
      })
    : (balanceLoading ? [] : logRows)
  // 표의 수익률/현재가만 실시간 시세(WebSocket)로 보강한다.
  // 수량·매도가능수량은 잔고 API(kt00018) 값이 유일한 정답이다.
  // (holdingStocks는 오늘 체결 로그를 합산해 만들기 때문에 수량이 실제 잔고보다 클 수 있다)
  const displayHoldingOrdersWithLive = displayHoldingOrders.map(row => {
    const live = holdingStocksRef.current.find(h => h.code === row.stockCode)
    if (!live) return row
    return {
      ...row,
      currentPrice: live.currentPrice || row.currentPrice,
      profitPercent: Number.isFinite(live.profitPercent) ? live.profitPercent : row.profitPercent,
    }
  })

  // 계좌 요약 합계: 서버 합계를 기준으로 삼아 "보유 종목"과 항상 일치시킨다.
  // (평균단가 반올림 × 수량 재계산은 실제 매입금액과 어긋난다)
  const accountTotals = (() => {
    const data: any = balanceData
    const serverPurchase = Number(data?.totalPurchase) || 0
    const serverValue = Number(data?.totalStockValue) || 0
    const serverProfit = Number(data?.totalProfit) || 0

    const list = holdingStocksRef.current
    // 서버 합계가 없을 때만 로컬로 계산 (매입금액은 purchaseAmount 우선)
    const localPurchase = list.reduce(
      (sum, s: any) => sum + (Number(s.purchaseAmount) || (s.purchasePrice || 0) * (s.quantity || 0)),
      0,
    )
    const localValue = list.reduce(
      (sum, s: any) => sum + (Number(s.evaluation) || (s.currentPrice || 0) * (s.quantity || 0)),
      0,
    )
    const localProfit = list.reduce((sum, s) => sum + (s.profit || 0), 0)

    const totalPurchase = serverPurchase > 0 ? serverPurchase : localPurchase
    const totalStockValue = serverValue > 0 ? serverValue : localValue
    const totalProfit = serverValue > 0 || totalPurchase > 0 ? serverProfit : localProfit

    // 총수익률은 표시된 합계로 다시 계산해 앞뒤가 맞게 한다
    const totalProfitRate = totalPurchase > 0
      ? (totalProfit / totalPurchase) * 100
      : (Number(data?.totalProfitRate) || 0)

    return { totalPurchase, totalStockValue, totalProfit, totalProfitRate }
  })()

  // 잔고에 없는 종목을 로컬 상태에서 제거 (유령 종목 방지)
  const dropLocalHolding = (stockCode: string) => {
    setDetectedStocks(prev => prev.map(s => s.code === stockCode ? { ...s, isHolding: false } : s))
    setOrderedOrHoldingStocks(prev => {
      if (!prev.has(stockCode)) return prev
      const next = new Set(prev)
      next.delete(stockCode)
      return next
    })
    setOrderLogs(prev => {
      const filtered = prev.filter(o => !(o.stockCode === stockCode && o.type === 'buy'))
      return filtered.length === prev.length ? prev : filtered
    })
  }

  // 잔고 기준 보유 종목과 로컬 로그를 동기화한다.
  // 잔고 조회가 성공했는데 로그에만 남은 종목은 실제로 없는 종목이므로 제거한다.
  useEffect(() => {
    if (!balanceHoldings) return
    const liveCodes = new Set(balanceHoldings.map(b => b.code))
    setOrderLogs(prev => {
      const filtered = prev.filter(o => o.type !== 'buy' || liveCodes.has(o.stockCode))
      return filtered.length === prev.length ? prev : filtered
    })
    setSelectedHoldingCodes(prev => {
      const next = new Set(Array.from(prev).filter(code => liveCodes.has(code)))
      return next.size === prev.size ? prev : next
    })
  }, [balanceData, balanceError, isConnected, selectedAccount])

  const handleSellAll = async () => {
    if (displayHoldingOrdersWithLive.length === 0) {
      return
    }

    if (!selectedAccount) {
      return
    }

    // 표에서 체크한 종목만 매도한다 (전체 선택 시 전량매도와 동일)
    const selected = displayHoldingOrdersWithLive.filter(d => selectedHoldingCodes.has(d.stockCode))
    if (selected.length === 0) {
      addLog('매도할 종목을 선택해주세요 (전체 선택 후 선택매도 가능)', 'warning')
      return
    }

    // 매도가능수량이 0인 종목은 주문해도 800033으로 거부되므로 미리 제외한다
    const targets = selected.filter(d => !(d.sellableQuantity !== undefined && d.sellableQuantity <= 0))
    const blocked = selected.filter(d => d.sellableQuantity !== undefined && d.sellableQuantity <= 0)
    if (blocked.length > 0) {
      addLog(
        `매도가능수량 부족으로 제외: ${blocked.map(b => b.stockName).join(', ')} (미체결 매도 주문을 먼저 취소하세요)`,
        'warning'
      )
    }
    if (targets.length === 0) return

    try {
      let successCount = 0
      for (const target of targets) {
        const stockCode = String(target.stockCode).trim()
        // 보유 수량은 계좌 조회 값을 우선 사용하고, 없으면 표의 수량을 쓴다
        const live = holdingStocks.find(h => h.code === stockCode)
        const stock = {
          code: stockCode,
          name: target.stockName,
          quantity: live?.quantity ?? target.quantity,
          purchasePrice: live?.purchasePrice ?? target.buyPrice ?? target.price,
          currentPrice: live?.currentPrice ?? target.currentPrice ?? target.price,
          // 매도 가격 결정(익절/손절 지정가)에 필요하다
          profitPercent: live?.profitPercent ?? target.profitPercent ?? 0,
        }
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

          // 주문 API 요청 제한 방지: 마지막 주문 시간 확인
          const timeSinceLastOrder = Date.now() - lastOrderTimeRef.current
          if (timeSinceLastOrder < minOrderInterval) {
            const waitTime = minOrderInterval - timeSinceLastOrder
            console.log(`[주문 제한] 마지막 주문 후 ${timeSinceLastOrder}ms 경과, ${waitTime}ms 대기 후 주문 진행`)
            addLog(`[주문 제한] API 요청 제한 방지를 위해 ${Math.ceil(waitTime / 1000)}초 대기`, 'info')
            await new Promise(resolve => setTimeout(resolve, waitTime))
          }

          // 미체결 매도 주문이 있으면 신규 주문 금지 (물량이 이미 묶여 있음)
          const pendingSellAll = orderLogs.find(o =>
            o.stockCode === stockCode && o.type === 'sell' && isPendingSellStatus(o.status)
          )
          if (pendingSellAll) {
            addLog(`[선택매도 건너뜀] ${stock.name}: 미체결 매도 주문이 이미 있습니다 (주문번호: ${pendingSellAll.orderNumber || 'N/A'})`, 'warning')
            continue
          }

          // 실제 잔고 수량으로 제한 (로컬 수량 초과 주문은 800033으로 거부된다)
          let sellAllQty = stock.quantity
          try {
            const balance = await kiwoomApi.getBalance(accountNo, accountProductCode)
            const rows = normalizeBalanceRows(balance)
            const liveRow = rows.find((b: any) => String(b.code ?? b.stockCode ?? b.종목코드).trim() === stockCode)
            const heldQty = Number(liveRow?.quantity ?? liveRow?.보유수량 ?? 0)
            const apiSellable = liveRow?.sellableQuantity
            if (Number.isFinite(heldQty) && heldQty > 0) {
              const pendingQty = orderLogs
                .filter(o => o.stockCode === stockCode && o.type === 'sell' && isPendingSellStatus(o.status))
                .reduce((sum, o) => sum + (o.quantity || 0), 0)
              const sellable = calcSellableQuantity(heldQty, pendingQty, apiSellable)
              if (sellable <= 0) {
                addLog(`[선택매도 건너뜀] ${stock.name}: 매도가능수량이 없습니다 (보유 ${heldQty}주, 미체결 매도 ${pendingQty}주)`, 'warning')
                continue
              }
              sellAllQty = Math.min(stock.quantity, sellable)
            } else if (Number.isFinite(heldQty) && heldQty === 0) {
              addLog(`[선택매도 건너뜀] ${stock.name}: 계좌에 보유 수량이 없습니다 (잔고 0주)`, 'warning')
              continue
            }
          } catch (balanceError: any) {
            console.warn(`[선택매도] ${stock.name}: 잔고 조회 실패, 로컬 수량으로 진행 - ${balanceError.message}`)
          }

          if (sellAllQty <= 0) {
            addLog(`[선택매도 건너뜀] ${stock.name}: 매도 가능 수량이 0주입니다`, 'warning')
            continue
          }

          // 매도 가격/옵션: 매매조건의 지정가 설정을 따른다
          const { profitType: sProfitType, lossType: sLossType, lossPriceOffset: sLossOffset } = sellStyleRef.current
          const sLivePrice = stock.currentPrice || stock.purchasePrice || 0
          const sIsLoss = (stock.profitPercent ?? 0) < 0
          const sSellType = sIsLoss ? sLossType : sProfitType
          const sSellOffset = sIsLoss ? sLossOffset : 0
          const { price: sSellPrice, order_option: sSellOption } = resolveSellOrderPrice(sLivePrice, sSellType, sSellOffset)

          const sellAllOrderResult = await kiwoomApi.placeOrder({
            code: stockCode,
            quantity: sellAllQty,
            price: sSellPrice,
            order_type: 'sell',
            order_option: sSellOption,
            accountNo,
            accountProductCode,
          })
          
          // 주문 성공 시 마지막 주문 시간 업데이트 (API 요청 제한 방지)
          lastOrderTimeRef.current = Date.now()

          // 주문 내역 즉시 갱신
          if (sellAllOrderResult?.orderNumber) {
            // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로, 로컬 상태에 직접 추가
            const orderTimestamp = Date.now() // 주문 접수 시점 기록
            const isMarketOrder = sSellOption === '03'
            const newOrder: OrderLog = {
              id: Date.now(),
              date: new Date().toLocaleDateString('ko-KR'),
              time: new Date().toLocaleTimeString('ko-KR'),
              type: 'sell',
              stockName: stock.name,
              stockCode: stockCode,
              quantity: sellAllQty,
              price: isMarketOrder ? sLivePrice : sSellPrice,
              status: '접수',
              orderNumber: sellAllOrderResult.orderNumber,
              orderTimestamp, // 주문 접수 시점 기록
              isMarketOrder, // 시장가 주문 여부
              buyPrice: resolveBuyPrice(
                stock.purchasePrice,
                live,
                orderLogs.find(o => o.type === 'buy' && o.stockCode === stockCode)?.price
              ), // 실현손익 계산용 매수가
              currentPrice: stock.currentPrice,
            }

            setOrderLogs(prev => {
              const updated = [newOrder, ...prev]
              console.log(`[주문 내역] 로컬 상태에 전량매도 주문 추가 완료 - 총 주문 개수: ${updated.length}`, newOrder)
              return updated
            })
            
            // C# 코드와 동일: 전량매도 주문 성공 시 매수주문했거나보유중인종목에서 제거
            setDetectedStocks(prev => prev.map(s => 
              s.code === stockCode
                ? { ...s, isHolding: false }
                : s
            ))
            
            // 전량매도 주문 성공 시 orderedOrHoldingStocks에서 제거
            setOrderedOrHoldingStocks(prev => {
              const updated = new Set(prev)
              updated.delete(stockCode)
              return updated
            })
            
            // 모의투자 환경에서는 주문 내역 조회 API가 실패하므로 refetch 호출하지 않음
            // setTimeout(() => {
            //   refetchOrders()
            //   queryClient.invalidateQueries(['orders', selectedAccount])
            // }, 1000)
          }

          successCount++
          addLog(`${stock.name} 전량매도 주문 전송`, 'success')
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error: any) {
          const { message: errorMessage, returnCode } = getOrderErrorInfo(error)
          if (error.response?.data?.isMockApiLimit ||
              errorMessage.includes('모의투자 환경 제한') ||
              errorMessage.includes('매매제한 종목') ||
              errorMessage.includes('RC4007')) {
            addLog(`${stock.name} 전량매도 건너뜀: 모의투자 매매 제한 종목`, 'warning')
          } else {
            addLog(`${stock.name} 매도 실패: ${errorMessage}${returnCode !== undefined ? ` (return_code: ${returnCode})` : ''}`, 'error')
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

  // 개별 종목 매도 (주문 내역에서 클릭한 종목만 매도)

  // 주문 내역 클릭 → 해당 종목 차트 표시
  const showChartForOrder = (order: OrderLog) => {
    const fromDetected = detectedStocks.find(s => s.code === order.stockCode)
    const fromWatchlist = watchlistStocks.find(s => s.code === order.stockCode)
    const fromHolding = holdingStocks.find(h => h.code === order.stockCode)

    // 차트는 DetectedStock 형태를 요구하므로 보유/주문 정보로 보강한다
    const base: DetectedStock = fromDetected || fromWatchlist || {
      code: order.stockCode,
      name: order.stockName,
      price: order.currentPrice ?? order.price,
      change: 0,
      changePercent: order.profitPercent ?? 0,
      volume: 0,
      detectedCondition: '',
      detectedTime: order.time,
    }

    setSelectedStockForChart(fromHolding
      ? { ...base, price: fromHolding.currentPrice || base.price, changePercent: fromHolding.profitPercent }
      : base)
    setChartPeriod('5')
    // PC: 우측 컬럼, 모바일: 아래에 붙으므로 해당 영역으로 스크롤
    setTimeout(() => {
      document.querySelector('.at-sec-chart')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 100)
  }

  const handleSellStock = async (stockCode: string, stockName: string) => {
    console.log(`[매도 함수 시작] ${stockName} (${stockCode}), 계좌: ${selectedAccount}, 연결: ${connected}`)
    
    if (!selectedAccount) {
      addLog('계좌를 선택해주세요', 'error')
      return
    }

    // holdingStocks에서 해당 종목 찾기
    console.log(`[매도] holdingStocks 검색 시작: ${stockName} (${stockCode}), 총 ${holdingStocks.length}개 보유종목`)
    let stock = holdingStocks.find(s => s.code === stockCode)
    
    // holdingStocks에 없으면 orderLogs에서 체결된 주문 찾기
    if (!stock) {
      const executedOrder = orderLogs.find(order => 
        order.stockCode === stockCode && 
        order.type === 'buy' && 
        (order.status === '체결' || order.status === '부분체결' || order.isExecuted)
      )
      
      if (executedOrder) {
        const quantity = executedOrder.status === '부분체결' && executedOrder.unfilledQuantity !== undefined
          ? executedOrder.quantity - executedOrder.unfilledQuantity
          : executedOrder.quantity
        
        stock = {
          code: stockCode,
          name: stockName,
          quantity: quantity,
          purchasePrice: executedOrder.price,
          currentPrice: executedOrder.currentPrice || executedOrder.price,
          profit: executedOrder.profit || 0,
          profitPercent: executedOrder.profitPercent || 0,
          maxProfitPercent: 0,
        }
        console.log(`[매도] holdingStocks에 없어 orderLogs에서 복원: ${stockName} ${quantity}주`)
      } else {
        addLog(`${stockName} 보유 종목 또는 체결 주문을 찾을 수 없습니다`, 'error')
        console.error(`[매도 실패] ${stockName} (${stockCode}): holdingStocks와 orderLogs 모두에서 찾을 수 없음`)
        return
      }
    }


    try {
      // 종목코드 검증: 6자리 숫자만 허용
      const validStockCode = String(stockCode).trim()
      if (!/^\d{6}$/.test(validStockCode)) {
        addLog(`[매도 건너뜀] ${stockName} (${validStockCode}): 지원하지 않는 종목코드 형식 (6자리 숫자만 지원)`, 'warning')
        return
      }

      const accountParts = selectedAccount.split('-')
      const accountNo = accountParts[0] || selectedAccount
      const accountProductCode = accountParts[1] || '01'

      // 주문 API 요청 제한 방지: 마지막 주문 시간 확인
      const timeSinceLastOrder = Date.now() - lastOrderTimeRef.current
      if (timeSinceLastOrder < minOrderInterval) {
        const waitTime = minOrderInterval - timeSinceLastOrder
        console.log(`[주문 제한] 마지막 주문 후 ${timeSinceLastOrder}ms 경과, ${waitTime}ms 대기 후 주문 진행`)
        addLog(`[주문 제한] API 요청 제한 방지를 위해 ${Math.ceil(waitTime / 1000)}초 대기`, 'info')
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }

      // 미체결 매도 주문이 있으면 신규 주문 금지 (물량이 이미 묶여 있음)
      const pendingIndividualSell = orderLogs.find(o =>
        o.stockCode === validStockCode && o.type === 'sell' && isPendingSellStatus(o.status)
      )
      if (pendingIndividualSell) {
        addLog(`${stockName}: 미체결 매도 주문이 이미 있습니다 (주문번호: ${pendingIndividualSell.orderNumber || 'N/A'})`, 'warning')
        return
      }

      // 실제 보유 수량으로 제한 (로컬 수량이 잔고보다 크면 800033으로 거부된다)
      let individualSellQty = stock.quantity
      try {
        const balance = await kiwoomApi.getBalance(accountNo, accountProductCode)
        const rows = normalizeBalanceRows(balance)
        const live = rows.find((b: any) => String(b.code ?? b.stockCode ?? b.종목코드).trim() === validStockCode)
        const heldQty = Number(live?.quantity ?? live?.보유수량 ?? 0)
        const apiSellable = live?.sellableQuantity
        if (Number.isFinite(heldQty) && heldQty > 0) {
          const pendingQty = orderLogs
            .filter(o => o.stockCode === validStockCode && o.type === 'sell' && isPendingSellStatus(o.status))
            .reduce((sum, o) => sum + (o.quantity || 0), 0)
          const sellable = calcSellableQuantity(heldQty, pendingQty, apiSellable)
          if (sellable <= 0) {
            addLog(`${stockName}: 매도가능수량이 없습니다 (보유 ${heldQty}주, 미체결 매도 ${pendingQty}주)`, 'warning')
            return
          }
          individualSellQty = Math.min(stock.quantity, sellable)
        } else if (Number.isFinite(heldQty) && heldQty === 0) {
          addLog(`${stockName}: 계좌에 보유 수량이 없습니다 (잔고 0주)`, 'warning')
          return
        }
      } catch (balanceError: any) {
        console.warn(`[매도] ${stockName}: 잔고 조회 실패, 로컬 수량으로 진행 - ${balanceError.message}`)
      }

      if (individualSellQty <= 0) {
        addLog(`${stockName}: 매도 가능 수량이 0주입니다`, 'warning')
        return
      }

      // 매도 가격/옵션: 매매조건의 '익절 지정가' 설정을 따른다.
      // (상한가처럼 매도 호가가 얇으면 시장가 주문이 체결되지 않고 물량만 잠긴다)
      const { profitType: profitSellType, lossType: lossSellType, lossPriceOffset: lossOffset } = sellStyleRef.current
      const livePrice = stock.currentPrice || stock.purchasePrice || 0
      const isLoss = (stock.profitPercent ?? 0) < 0
      const sellType = isLoss ? lossSellType : profitSellType
      const sellOffset = isLoss ? lossOffset : 0
      const { price: sellPrice, order_option: sellOrderOption } = resolveSellOrderPrice(livePrice, sellType, sellOffset)

      const orderParams = {
        code: validStockCode,
        quantity: individualSellQty,
        price: sellPrice,
        order_type: 'sell' as const,
        order_option: sellOrderOption,
        accountNo,
        accountProductCode,
      }
      
      console.log(`[매도 주문 전송] ${stockName} (${validStockCode}):`, {
        종목코드: validStockCode,
        종목명: stockName,
        수량: individualSellQty,
        가격: sellPrice,
        주문타입: 'sell',
        주문옵션: sellOrderOption,
        계좌번호: accountNo,
        계좌상품코드: accountProductCode,
        전체파라미터: orderParams,
      })

      const sellOrderResult = await kiwoomApi.placeOrder(orderParams)

      // 주문 성공 시 마지막 주문 시간 업데이트
      lastOrderTimeRef.current = Date.now()

      // 주문 내역 즉시 갱신
      if (sellOrderResult?.orderNumber || sellOrderResult?.order_number) {
        const orderNumber = sellOrderResult.orderNumber || sellOrderResult.order_number
        
        // 주문 내역 표시용 가격: 지정가면 주문가, 시장가면 현재가
        const referencePrice = sellOrderOption === '00'
          ? sellPrice
          : (stock.currentPrice || stock.purchasePrice || 0)
        
        const newOrder: OrderLog = {
          id: Date.now(),
          date: new Date().toLocaleDateString('ko-KR'),
          time: new Date().toLocaleTimeString('ko-KR'),
          type: 'sell',
          stockName: stockName,
          stockCode: validStockCode,
          quantity: individualSellQty,
          price: referencePrice,
          status: '접수',
          orderNumber: orderNumber,
          orderTimestamp: Date.now(),
          isMarketOrder: sellOrderOption === '03',
          currentPrice: referencePrice,
          buyPrice: resolveBuyPrice(
            stock.purchasePrice,
            stock,
            orderLogs.find(o => o.type === 'buy' && o.stockCode === validStockCode)?.price
          ),
        }

        setOrderLogs(prev => {
          const updated = [newOrder, ...prev]
          console.log(`[주문 내역] 로컬 상태에 매도 주문 추가 완료 - 총 주문 개수: ${updated.length}`, newOrder)
          return updated
        })

        // 검색된 종목에서 보유 플래그 제거
        setDetectedStocks(prev => prev.map(s =>
          s.code === validStockCode
            ? { ...s, isHolding: false }
            : s
        ))

        // orderedOrHoldingStocks에서 제거
        setOrderedOrHoldingStocks(prev => {
          const updated = new Set(prev)
          updated.delete(validStockCode)
          return updated
        })

        addLog(`${stockName} ${stock.quantity}주 시장가 매도 주문 전송 완료`, 'success')
        
        // 계좌 잔고 갱신
        setTimeout(() => {
          refetchBalance()
          queryClient.invalidateQueries('balance')
        }, 1000)
      } else {
        addLog(`${stockName} 매도 주문 실패: 주문번호를 받지 못했습니다`, 'error')
      }
    } catch (error: any) {
      const { message: errorMessage, status: statusCode, returnCode } = getOrderErrorInfo(error)
      console.error(`[매도 실패] ${stockName} (${stockCode}):`, {
        에러메시지: errorMessage,
        상태코드: statusCode,
        수량: stock.quantity,
        전체응답: error.response?.data,
        에러객체: error,
      })
      
      if (error.response?.data?.isMockApiLimit ||
          errorMessage.includes('모의투자 환경 제한') ||
          errorMessage.includes('매매제한 종목') ||
          errorMessage.includes('RC4007')) {
        addLog(`${stockName} 매도 건너뜀: 모의투자 매매 제한 종목`, 'warning')
      } else if (errorMessage.includes('800033') || errorMessage.includes('매도가능수량')) {
        // 잔고의 매도가능수량이 0인데 로컬 수량으로 주문한 경우다.
        // 잔고를 다시 받아 실제 수량을 반영하고 원인을 알려준다.
        addLog(
          `${stockName} 매도 불가: 매도가능수량이 부족합니다. ` +
          `미체결 매도 주문이 물량을 잡고 있거나 보유 수량이 없습니다. ` +
          `'미체결취소' 후 다시 시도하세요.`,
          'error'
        )
        refetchBalance()
        queryClient.invalidateQueries('balance')
      } else {
        // 서버가 내려준 실제 사유를 그대로 보여준다 (상태코드만으로는 원인을 알 수 없음)
        addLog(`${stockName} 매도 실패: ${errorMessage}${returnCode !== undefined ? ` (return_code: ${returnCode})` : ''}`, 'error')
      }
    }
  }

  // 미체결 주문 취소
  const handleCancelUnfilledOrders = async () => {
    try {
      if (!selectedAccount) {
        addLog('계좌를 선택해주세요', 'error')
        return
      }

      // 로컬 상태뿐 아니라 키움 서버의 미체결 주문을 직접 조회한다.
      // (로컬에 병합되지 않은 주문은 화면에 안 보이지만 실제로는 물량을 잡고 있다)
      addLog('미체결 주문 조회 중...', 'info')
      let serverOrders: any[] = []
      try {
        serverOrders = await kiwoomApi.getOrderHistory(selectedAccount)
      } catch (error: any) {
        addLog(`주문 내역 조회 실패, 로컬 목록으로 진행: ${error.message}`, 'warning')
      }

      const isUnfilledStatus = (status?: string) =>
        status === '접수' || status === '확인' || status === '미체결'

      // 서버 응답 기준 미체결 주문
      const serverUnfilled = (serverOrders || []).filter(o => isUnfilledStatus(o.status))

      // 로컬 기준 미체결 주문 (서버에서 못 받은 경우 대비)
      const localUnfilled = orderLogs.filter(o => isUnfilledStatus(o.status))

      // 주문번호 기준 중복 제거
      const targets = new Map<string, { orderNumber: string; stockCode: string; stockName: string; quantity: number; type: string }>()
      for (const o of serverUnfilled) {
        if (!o.orderNumber) continue
        targets.set(String(o.orderNumber), {
          orderNumber: String(o.orderNumber),
          stockCode: String(o.stockCode || '').trim(),
          stockName: o.stockName || o.stockCode || '',
          quantity: Number(o.unfilledQuantity) > 0 ? Number(o.unfilledQuantity) : Number(o.quantity) || 0,
          type: o.type || 'sell',
        })
      }
      for (const o of localUnfilled) {
        if (!o.orderNumber || targets.has(o.orderNumber)) continue
        targets.set(o.orderNumber, {
          orderNumber: o.orderNumber,
          stockCode: String(o.stockCode || '').trim(),
          stockName: o.stockName || o.stockCode || '',
          quantity: o.unfilledQuantity && o.unfilledQuantity > 0 ? o.unfilledQuantity : o.quantity,
          type: o.type,
        })
      }

      const list = Array.from(targets.values())
        .filter(t => t.stockCode && t.quantity > 0)
        .filter(t => {
          // 이미 종료된 매도 주문은 제외한다.
          // 매도가능수량이 보유수량보다 적을 때만 실제로 물량이 잠겨 있다.
          if (t.type !== 'sell') return true
          const held = holdingStocksRef.current.find(h => h.code === t.stockCode)
          const sellable = held?.sellableQuantity
          if (held && sellable !== undefined) return sellable < held.quantity
          return true
        })
      if (list.length === 0) {
        addLog('취소할 미체결 주문이 없습니다 (이미 종료된 주문)', 'info')
        queryClient.invalidateQueries('orders')
        queryClient.invalidateQueries('balance')
        return
      }

      addLog(`미체결 주문 ${list.length}건 취소 시작`, 'info')

      let successCount = 0
      let failCount = 0

      for (const order of list) {
        try {
          await kiwoomApi.cancelOrder(order.orderNumber, order.stockCode, order.quantity)
          addLog(`[취소 접수] ${order.stockName} ${order.quantity}주 (원주문: ${order.orderNumber})`, 'success')

          // 로컬 상태를 취소로 갱신
          setOrderLogs(prev => prev.map(o =>
            o.orderNumber === order.orderNumber
              ? { ...o, status: '취소', type: 'cancel', cancelTimestamp: Date.now() }
              : o
          ))
          if (order.type === 'buy') {
            setOrderedOrHoldingStocks(prev => {
              const next = new Set(prev)
              next.delete(order.stockCode)
              return next
            })
          }
          successCount++
          await new Promise(resolve => setTimeout(resolve, 400))
        } catch (error: any) {
          const { message, returnCode } = getOrderErrorInfo(error)
          // 이미 체결·취소된 주문은 실패로 집계하되 ERROR 대신 warning으로 남긴다
          addLog(`[취소 건너뜀] ${order.stockName} (${order.orderNumber}): ${message}${returnCode !== undefined ? ` (return_code: ${returnCode})` : ''}`, 'warning')
          failCount++
        }
      }

      addLog(`미체결 주문 취소 완료: 성공 ${successCount}건, 실패 ${failCount}건`, successCount > 0 ? 'success' : 'warning')
      queryClient.invalidateQueries('orders')
      queryClient.invalidateQueries('balance')
      // 매도가능수량이 복구되도록 잔고를 다시 받아온다
      setTimeout(() => {
        refetchBalance()
        refetchOrders()
      }, 1000)
    } catch (error: any) {
      addLog(`미체결 주문 취소 실패: ${error.message}`, 'error')
    }
  }

  // 미체결 주문 자동 취소 (자동매매 실행 여부와 무관하게 동작)
  // ⚠️ 로컬 상태만 '취소'로 바꾸면 키움 서버 주문은 살아 있어 계속 물량을 잡는다.
  //    반드시 kt10003(주문취소) API를 호출해야 매도가능수량이 복구된다.
  useEffect(() => {
    if (!connected || !selectedAccount) {
      return
    }

    // 5초마다 미체결 주문 확인
    const checkInterval = setInterval(() => {
      const now = Date.now()
      const timeoutMs = 30000 // 30초 (체결 확인 시간 확보)

      // 이미 죽은 주문(유령 미체결)을 먼저 걸러낸다.
      // kt00007(주문내역)은 이미 끝난 주문도 '접수'로 남기는 경우가 있다.
      // 매도가능수량이 보유수량과 같으면 그 주문은 물량을 잡고 있지 않다.
      const staleIds = new Set<number>()
      for (const order of orderLogsRef.current) {
        if (!order.orderNumber) continue
        const isUnfilled = order.status === '접수' || order.status === '확인' || order.status === '미체결'
        if (!isUnfilled || order.type !== 'sell') continue
        const held = holdingStocksRef.current.find(h => h.code === order.stockCode)
        const sellable = held?.sellableQuantity
        if (held && sellable !== undefined && sellable >= held.quantity) {
          staleIds.add(order.id)
          cancelRequestedRef.current.add(order.orderNumber)
        }
      }
      if (staleIds.size > 0) {
        // 서버 호출 없이 로컬 상태만 정리한다 (이미 종료된 주문)
        setOrderLogs(prev => prev.map(o =>
          staleIds.has(o.id)
            ? { ...o, status: '취소', type: 'cancel' as const, cancelTimestamp: Date.now() }
            : o
        ))
      }

      const targets = orderLogsRef.current.filter(order => {
        if (!order.orderNumber) return false
        if (staleIds.has(order.id)) return false
        const isUnfilled = order.status === '접수' || order.status === '확인' || order.status === '미체결'
        if (!isUnfilled) return false
        if (cancelRequestedRef.current.has(order.orderNumber)) return false

        // 지정가 주문은 체결을 기다려야 한다. 자동취소하면 영원히 체결되지 않는다.
        // (시장가만 미체결로 남으면 물량을 잠그고 의미가 없으므로 취소 대상)
        // orderPrice > 0 이면 지정가 주문이다 (isMarketOrder는 API 병합 시 누락될 수 있음)
        if (order.isMarketOrder === false) return false
        if ((order.orderPrice ?? 0) > 0) return false

        // 주문 접수 시각: 타임스탬프가 없으면 '오전 11:35:23' 형태에서 복원한다
        let placedAt = order.orderTimestamp
        if (!placedAt) {
          const sec = parseClockSeconds(order.time)
          if (!Number.isFinite(sec)) return false
          const d = new Date()
          d.setHours(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60, 0)
          placedAt = d.getTime()
        }
        return now - placedAt >= timeoutMs
      })

      if (targets.length === 0) return

      // 서버 취소는 비동기이므로 상태 갱신과 분리해서 호출한다
      void (async () => {
        for (const order of targets) {
          const orderNo = order.orderNumber as string
          if (cancelRequestedRef.current.has(orderNo)) continue
          cancelRequestedRef.current.add(orderNo)

          const cancelQty = order.unfilledQuantity && order.unfilledQuantity > 0
            ? order.unfilledQuantity
            : order.quantity
          const placedAt = order.orderTimestamp
            || (() => {
              const sec = parseClockSeconds(order.time)
              const d = new Date()
              d.setHours(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60, 0)
              return d.getTime()
            })()
          const elapsed = Math.floor((Date.now() - placedAt) / 1000)

          try {
            await kiwoomApi.cancelOrder(orderNo, order.stockCode, cancelQty)
            addLog(
              `[자동 취소] ${order.stockName} ${cancelQty}주 ${order.type === 'buy' ? '매수' : '매도'} 주문 취소 (${elapsed}초 경과)`,
              'warning'
            )
            setOrderLogs(prev => prev.map(o =>
              o.id === order.id
                ? { ...o, status: '취소', type: 'cancel' as const, cancelTimestamp: Date.now() }
                : o
            ))
            if (order.type === 'buy') {
              setOrderedOrHoldingStocks(prev => {
                const next = new Set(prev)
                next.delete(order.stockCode)
                return next
              })
            }
          } catch (error: any) {
            const { message } = getOrderErrorInfo(error)
            // 이미 체결·취소된 주문은 취소할 수 없다 → 재시도하지 않도록 기록만 남긴다
            addLog(`[자동 취소 실패] ${order.stockName}: ${message}`, 'warning')
          }
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        // 취소 후 매도가능수량이 복구되도록 잔고를 즉시 갱신
        queryClient.invalidateQueries('balance')
        queryClient.invalidateQueries('orders')
      })()
    }, 5000) // 5초마다 확인

    return () => {
      clearInterval(checkInterval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedAccount])

  // 취소된 주문을 20초 후 자동 삭제
  useEffect(() => {
    if (!isRunning) {
      return
    }

    // 5초마다 취소된 주문 확인
    const deleteInterval = setInterval(() => {
      const now = Date.now()
      const deleteTimeoutMs = 20000 // 20초

      setOrderLogs(prev => {
        const ordersToDelete = prev.filter(order => {
          // 취소된 주문이고, 취소 시점이 20초 이상 지난 경우
          if (order.status !== '취소' && order.type !== 'cancel') {
            return false // 취소된 주문이 아니면 삭제 대상에서 제외
          }
          
          if (!order.cancelTimestamp) {
            // cancelTimestamp가 없으면 orderTimestamp를 기준으로 판단 (하위 호환성)
            if (!order.orderTimestamp) {
              return false
            }
            // 취소 시점을 알 수 없으므로, 주문 접수 시점 기준으로 40초 경과 시 삭제 (취소까지 20초 + 삭제까지 20초)
            const elapsedTime = now - order.orderTimestamp
            return elapsedTime >= 40000
          }
          
          const elapsedTime = now - order.cancelTimestamp
          const shouldDelete = elapsedTime >= deleteTimeoutMs

          if (shouldDelete) {
            console.log(`[자동 삭제] ${order.stockName} 취소 주문 삭제 (취소 후 경과 시간: ${Math.floor(elapsedTime / 1000)}초)`)
          }

          return shouldDelete
        })

        if (ordersToDelete.length === 0) {
          return prev // 삭제할 주문이 없으면 변경 없음
        }

        // 취소된 주문 삭제
        const updated = prev.filter(order => {
          const shouldDelete = ordersToDelete.some(deleteOrder => deleteOrder.id === order.id)
          return !shouldDelete
        })

        console.log(`[자동 삭제] ${ordersToDelete.length}건의 취소 주문 삭제 완료`)
        return updated
      })
    }, 5000) // 5초마다 확인

    return () => {
      clearInterval(deleteInterval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]) // isRunning만 의존성으로 사용 (함수형 업데이트로 최신 상태 참조)

  // 시장가 주문 자동 체결 처리 제거 - 실제 보유 종목 조회를 통해서만 체결 확인
  // 시장가 주문도 실제로 보유 종목에 나타날 때만 체결로 처리하도록 변경
  // (이전의 자동 체결 처리는 제거하고 보유 종목 조회 로직만 사용)

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

  // 서버가 재시작되면 키움 세션이 사라진다. 브라우저는 연결됨으로 알고 있어
  // 시세가 조용히 멈추므로, 주기적으로 서버 상태를 확인해 자동으로 다시 연결한다.
  const reconnectingRef = useRef(false)
  useEffect(() => {
    if (!connected) return

    let stopped = false
    const verify = async () => {
      if (stopped || reconnectingRef.current) return
      try {
        const status = await kiwoomApi.getStatus()
        if (status.connected) return

        // 서버 세션이 끊김 → 저장된 키로 재연결
        const savedAppkey = localStorage.getItem('kiwoom_appkey')
        const savedSecretkey = localStorage.getItem('kiwoom_secretkey')
        const savedMode = localStorage.getItem('kiwoom_apimode') || 'virtual'
        if (!savedAppkey || !savedSecretkey) {
          addLog('서버 연결이 끊겼습니다. 다시 연결해주세요', 'warning')
          return
        }

        reconnectingRef.current = true
        const host = savedMode === 'real' ? 'https://api.kiwoom.com' : 'https://mockapi.kiwoom.com'
        console.log('[자동 재연결] 서버 세션 없음 → 재연결 시도')
        addLog('[자동 재연결] 서버 연결이 끊겨 다시 연결합니다', 'warning')

        const response = await fetch('/api/kiwoom/connect', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ appkey: savedAppkey, secretkey: savedSecretkey, host }),
        })
        const data = await response.json()
        if (data.success) {
          await checkStatus()
          addLog('[자동 재연결] 키움증권 API 재연결 성공', 'success')
        } else {
          addLog(`[자동 재연결] 실패: ${data.message || '알 수 없는 오류'}`, 'error')
        }
      } catch (error: any) {
        console.error('[자동 재연결] 오류:', error.message)
      } finally {
        reconnectingRef.current = false
      }
    }

    const interval = window.setInterval(verify, 15000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [connected, checkStatus])

  // 조건식 변경시 텍스트 업데이트
  useEffect(() => {
    const selected = conditions.filter(c => c.enabled)
    if (selected.length === 0) {
      setSelectedConditionText('선택된 조건식이 없습니다. 조건식을 체크해주세요.')
    } else {
      setSelectedConditionText(selected.map(c => c.name).join(' § '))
    }
  }, [conditions])

  // 저장된 설정 로드 + 쿠키 세션 복원
  useEffect(() => {
    try {
      const savedAppkey = localStorage.getItem('kiwoom_appkey')
      const savedSecretkey = localStorage.getItem('kiwoom_secretkey')
      const savedApiMode = localStorage.getItem('kiwoom_apimode')

      // 과거 버전이 남긴 라이선스 키는 즉시 제거 (XSS 노출면 제거)
      const legacyKey = localStorage.getItem('kiwoom_license_key')
      if (legacyKey) {
        localStorage.removeItem('kiwoom_license_key')
      }

      // 저장된 appkey/secretkey 복원 (자동 재연결용)
      if (savedAppkey) setAppkey(savedAppkey)
      if (savedSecretkey) setSecretkey(savedSecretkey)
      if (savedApiMode) setApiMode(savedApiMode as 'real' | 'virtual')

      // 라이선스 세션은 HttpOnly 쿠키로 복원한다 (키를 localStorage에 두지 않는다)
      fetch('/api/auth/session', { credentials: 'include' })
        .then((res) => res.json())
        .then((data) => {
          if (data?.authenticated && data.remainingDays !== undefined) {
            setUseLicenseKey(true)
            setKeyInfo({ expiresAt: data.expiresAt, remainingDays: data.remainingDays })
            // 입력창이 비어 있으면 안 된다.
            // 키 값 자체는 HttpOnly 쿠키라 JS에서 읽을 수 없으므로
            // '세션 유지 중'임을 나타내는 표시값을 넣는다 (검증은 쿠키로 이뤄진다).
            setLicenseKey(prev => prev || SESSION_PLACEHOLDER)
          } else {
            setUseLicenseKey(true) // 키 입력 UI는 유지 (재로그인 유도)
          }
        })
        .catch(() => {
          // 세션 확인 실패는 치명적이지 않다 (로그인 화면에서 다시 검증)
        })
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
      
      // 종목별 매수가격 설정 로드 (priceSettings 우선, 없으면 tradingConditions에서)
      const savedPriceSettings = localStorage.getItem('priceSettings')
      if (savedPriceSettings) {
        try {
          const parsed = JSON.parse(savedPriceSettings)
          if (parsed.종목별매수가격설정실행 !== undefined) {
            setBuyPriceSettings({
              종목별매수가격설정실행: parsed.종목별매수가격설정실행 ?? true,
              매수가격옵션: parsed.매수가격옵션 === '시장가' ? '시장가' : '지정가',
              매수호가: parsed.매수호가 ?? 0,
            })
          }
        } catch (e) {
          console.error('종목별 매수가격 설정 파싱 오류:', e)
        }
      } else {
        // priceSettings가 없으면 tradingConditions에서 로드 (하위 호환성)
        const savedTradingConditions = localStorage.getItem('tradingConditions')
        if (savedTradingConditions) {
          try {
            const parsed = JSON.parse(savedTradingConditions)
            if (parsed.종목별매수가격설정실행 !== undefined) {
              setBuyPriceSettings({
                종목별매수가격설정실행: parsed.종목별매수가격설정실행 ?? true,
                매수가격옵션: parsed.매수가격옵션 === '시장가' ? '시장가' : '지정가',
                매수호가: parsed.매수호가 ?? 0,
              })
            }
          } catch (e) {
            console.error('종목별 매수가격 설정 파싱 오류:', e)
          }
        }
      }
      
      // 매매시간 설정 로드
      const savedTradingTime = localStorage.getItem('tradingTime')
      if (savedTradingTime) {
        try {
          const parsed = JSON.parse(savedTradingTime)
          if (parsed.시작시 !== undefined) setStartHour(parsed.시작시)
          if (parsed.시작분 !== undefined) setStartMinute(parsed.시작분)
          if (parsed.종료시 !== undefined) setEndHour(parsed.종료시)
          if (parsed.종료분 !== undefined) setEndMinute(parsed.종료분)
          if (parsed.종료초 !== undefined) setEndSecond(parsed.종료초)
          if (parsed.목표시간도달시보유종목전량매도 !== undefined) setDropSellTime(parsed.목표시간도달시보유종목전량매도)
          if (parsed.목표시 !== undefined) setDropSellStartHour(parsed.목표시)
          if (parsed.목표분 !== undefined) setDropSellStartMinute(parsed.목표분)
          if (parsed.목표초 !== undefined) setDropSellEndSecond(parsed.목표초)
          if (parsed.시간대정지사용 !== undefined) setPauseBuyEnabled(parsed.시간대정지사용)
          if (parsed.정지시작시 !== undefined) setPauseStartHour(parsed.정지시작시)
          if (parsed.정지시작분 !== undefined) setPauseStartMinute(parsed.정지시작분)
          if (parsed.정지종료시 !== undefined) setPauseEndHour(parsed.정지종료시)
          if (parsed.정지종료분 !== undefined) setPauseEndMinute(parsed.정지종료분)
        } catch (e) {
          console.error('매매시간 설정 파싱 오류:', e)
        }
      }
      
      // 매도 가격지정 설정 로드
      const savedSellPriceSettings = localStorage.getItem('sellPriceSettings')
      if (savedSellPriceSettings) {
        try {
          const parsed = JSON.parse(savedSellPriceSettings)
          if (parsed.익절목표수익률 !== undefined) setProfitTarget(parsed.익절목표수익률)
          if (parsed.익절주문옵션 !== undefined) setProfitType(parsed.익절주문옵션 === 'market' ? 'market' : 'limit')
          if (parsed.손절기준손실률 !== undefined) setLossLimit(parsed.손절기준손실률)
          if (parsed.손절주문옵션 !== undefined) setLossType(parsed.손절주문옵션 === 'market' ? 'market' : 'limit')
          if (parsed.매도호가 !== undefined) setLossPriceOffset(parsed.매도호가)
        } catch (e) {
          console.error('매도 가격지정 설정 파싱 오류:', e)
        }
      }
      
      // 기타조건 설정 로드
      const savedOtherConditions = localStorage.getItem('otherConditions')
      if (savedOtherConditions) {
        try {
          const parsed = JSON.parse(savedOtherConditions)
          if (parsed.프로그램실행시자동시작 !== undefined) setAutoStart(parsed.프로그램실행시자동시작)
          if (parsed.Trailing매도조건설정실행 !== undefined) setTrailingStop(parsed.Trailing매도조건설정실행)
          if (parsed.매도감시기준수익률 !== undefined) setTrailingProfitThreshold(parsed.매도감시기준수익률)
          if (parsed.최고수익률대비하락률 !== undefined) setTrailingDropThreshold(parsed.최고수익률대비하락률)
        } catch (e) {
          console.error('기타조건 설정 파싱 오류:', e)
        }
      }
      
      // 단계별 익절 설정 로드
      const savedStepProfit = localStorage.getItem('stepProfitSettings')
      if (savedStepProfit) {
        try {
          const parsed = JSON.parse(savedStepProfit)
          setStepProfit(prev => ({ ...prev, ...parsed }))
        } catch (e) {
          console.error('단계별 익절 설정 파싱 오류:', e)
        }
      }

      // 새 기본값 1회 적용 (기존 저장값이 덮어쓰지 않도록)
      if (localStorage.getItem('tradingDefaultsVersion') !== '4') {
        setPauseBuyEnabled(true)
        setStepProfit(prev => ({ ...prev, 사용: true }))
        setDropSellTime(true)
        setDropSellStartHour(12)
        setDropSellStartMinute(0)
        setDropSellEndSecond(0)
        // 기타 매도: 시장가 · 기준손실률 -3.0%
        setLossType('market')
        setLossLimit(-3.0)
        // Trailing 매도: 기준 5% / 최고점 대비 -3.0%
        setTrailingStop(true)
        setTrailingProfitThreshold(5)
        setTrailingDropThreshold(-3.0)
        localStorage.setItem('tradingDefaultsVersion', '4')
      }
    } catch (error) {
      console.error('매매설정 로드 오류:', error)
    }
  }, [])

  // 프로그램 실행 시 자동 시작 (autoStart)
  // API 연결 + 계좌 선택 + 조건식 선택이 모두 준비된 뒤 1회만 실행한다.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (autoStartedRef.current) return
    if (!autoStart) return
    if (isRunning) return // 이미 실행 중이면 아무 것도 하지 않음
    if (!isConnected || !selectedAccount) return
    if (conditions.filter(c => c.enabled).length === 0) return

    autoStartedRef.current = true
    addLog('프로그램 실행 시 자동시작 설정에 따라 자동매매를 시작합니다', 'info')
    // 상태(조건식·계좌)가 반영된 다음 틱에서 시작
    const timer = window.setTimeout(() => {
      handleStart().catch((e: any) => addLog(`자동시작 실패: ${e.message}`, 'error'))
    }, 800)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, isRunning, isConnected, selectedAccount, conditions])
  
  // TradingSettings에서 설정이 변경될 때 실시간으로 반영
  useEffect(() => {
    const handleStorageChange = () => {
      // priceSettings 우선 확인
      const savedPriceSettings = localStorage.getItem('priceSettings')
      if (savedPriceSettings) {
        try {
          const parsed = JSON.parse(savedPriceSettings)
          if (parsed.종목별매수가격설정실행 !== undefined) {
            setBuyPriceSettings({
              종목별매수가격설정실행: parsed.종목별매수가격설정실행 ?? true,
              매수가격옵션: parsed.매수가격옵션 === '시장가' ? '시장가' : '지정가',
              매수호가: parsed.매수호가 ?? 0,
            })
            return
          }
        } catch (e) {
          console.error('종목별 매수가격 설정 파싱 오류:', e)
        }
      }
      
      // priceSettings가 없으면 tradingConditions에서 확인 (하위 호환성)
      const savedTradingConditions = localStorage.getItem('tradingConditions')
      if (savedTradingConditions) {
        try {
          const parsed = JSON.parse(savedTradingConditions)
          if (parsed.종목별매수가격설정실행 !== undefined) {
            setBuyPriceSettings({
              종목별매수가격설정실행: parsed.종목별매수가격설정실행 ?? true,
              매수가격옵션: parsed.매수가격옵션 === '시장가' ? '시장가' : '지정가',
              매수호가: parsed.매수호가 ?? 0,
            })
          }
        } catch (e) {
          console.error('종목별 매수가격 설정 파싱 오류:', e)
        }
      }
    }
    
    // storage 이벤트 리스너 등록 (다른 탭에서 변경 시)
    window.addEventListener('storage', handleStorageChange)
    
    // 주기적으로 확인 (같은 탭에서 변경 시)
    const interval = setInterval(handleStorageChange, 1000)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      clearInterval(interval)
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
      
      // 종목별 매수가격 설정 저장
      const priceSettings = {
        종목별매수가격설정실행: buyPriceSettings.종목별매수가격설정실행,
        매수가격옵션: buyPriceSettings.매수가격옵션,
        매수호가: buyPriceSettings.매수호가,
      }
      localStorage.setItem('priceSettings', JSON.stringify(priceSettings))
      
      // 매매시간 설정 저장
      const tradingTime = {
        시작시: startHour,
        시작분: startMinute,
        종료시: endHour,
        종료분: endMinute,
        종료초: endSecond,
        목표시간도달시보유종목전량매도: dropSellTime,
        목표시: dropSellStartHour,
        목표분: dropSellStartMinute,
        목표초: dropSellEndSecond,
        시간대정지사용: pauseBuyEnabled,
        정지시작시: pauseStartHour,
        정지시작분: pauseStartMinute,
        정지종료시: pauseEndHour,
        정지종료분: pauseEndMinute,
      }
      localStorage.setItem('tradingTime', JSON.stringify(tradingTime))
      
      // 단계별 익절 설정 저장
      localStorage.setItem('stepProfitSettings', JSON.stringify(stepProfit))
      
      // 매도 가격지정 설정 저장
      const sellPriceSettings = {
        익절목표수익률: profitTarget,
        익절주문옵션: profitType,
        손절기준손실률: lossLimit,
        손절주문옵션: lossType,
        매도호가: lossPriceOffset,
      }
      localStorage.setItem('sellPriceSettings', JSON.stringify(sellPriceSettings))
      
      // 기타조건 설정 저장
      const otherConditions = {
        프로그램실행시자동시작: autoStart,
        Trailing매도조건설정실행: trailingStop,
        매도감시기준수익률: trailingProfitThreshold,
        최고수익률대비하락률: trailingDropThreshold,
      }
      localStorage.setItem('otherConditions', JSON.stringify(otherConditions))
    } catch (error) {
      console.error('매매설정 저장 오류:', error)
    }
  }, [
    amountPerStock, maxSimultaneousBuy, tradeLimitPerStock, maxDailyStocks, feePercent, buyPriceSettings,
    startHour, startMinute, endHour, endMinute, endSecond, dropSellTime, dropSellStartHour, dropSellStartMinute, dropSellEndSecond,
    pauseBuyEnabled, pauseStartHour, pauseStartMinute, pauseEndHour, pauseEndMinute, stepProfit,
    profitTarget, profitType, lossLimit, lossType, lossPriceOffset,
    autoStart, trailingStop, trailingProfitThreshold, trailingDropThreshold
  ])

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

        /* ===== 모바일(기본): 세로 1열 스택 ===== */
        .at-orders-scroll {
          flex: 1;
          min-height: 0;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 4px; /* 화면 간격 최소화 */
          padding: 0;
        }
        .at-right-col {
          display: contents;
        }
        /* 조건검색식 카드: PC에서는 조건식(좌) + 종목 직접 추가(우) 6:4 */
        .at-cond-body {
          display: block;
        }
        /* 사용자수식: PC에서는 매수조건/매도조건 2열 */
        .at-formula-grid {
          display: block;
        }
        @media (min-width: 1024px) {
          .at-formula-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            align-items: start;
          }
          .at-formula-grid > div { margin-bottom: 0 !important; }
          .at-formula-grid label {
            font-size: 11px;
            line-height: 1.3;
            align-items: flex-start !important;
          }
        }

        @media (min-width: 1024px) {
          /* 조건검색식 카드 목록은 3열 (좌측 6 비율 안에서) */
          .at-cond-list {
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
          }
          /* 3열에서는 카드가 좁아지므로 여백/글자 크기 축소 */
          .at-cond-list > label {
            padding: 5px 6px !important;
            gap: 4px !important;
            font-size: 12px !important;
          }
          .at-cond-list > label > input[type="checkbox"] {
            width: 15px !important;
            height: 15px !important;
          }
          .at-cond-list > label > div > div:first-child { font-size: 12px !important; }
          .at-cond-list > label > div > div:last-child { font-size: 10px !important; }
          .at-cond-list > label > div:last-child:not(:nth-child(2)) {
            padding: 1px 4px !important;
            font-size: 9px !important;
          }
          .at-cond-body {
            display: grid;
            grid-template-columns: minmax(0, 6fr) minmax(0, 4fr);
            gap: 10px;
            align-items: start;
          }
          .at-cond-manual {
            margin-top: 0 !important;
            padding-top: 0 !important;
            border-top: none !important;
            border-left: 1px solid #4b5563;
            padding-left: 10px !important;
            position: sticky;
            top: 0;
          }
          .bg-gray-50 .at-cond-manual {
            border-left-color: #d1d5db;
          }
        }

        /* 표 컬럼 헤더 고정 (세로 스크롤 시 상단 유지) */
        .at-detected-table thead th,
        .at-order-table thead th,
        .at-watch-table thead th {
          position: sticky !important;
          top: 0 !important;
          z-index: 3;
        }
        /* 그라데이션 텍스트는 sticky 배경 위에서 사라지므로 단색 처리 */
        .at-detected-table thead th {
          background-image: none !important;
          -webkit-text-fill-color: currentColor !important;
        }
        .bg-gradient-dark .at-detected-table thead th,
        .bg-gradient-dark .at-order-table thead th,
        .bg-gradient-dark .at-watch-table thead th { background-color: #374151 !important; }
        .bg-gray-50 .at-detected-table thead th,
        .bg-gray-50 .at-order-table thead th { background-color: #f3f4f6 !important; }
        .bg-gray-50 .at-watch-table thead th { background-color: #e5e7eb !important; }
        .at-conditions-grid {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-width: 100%;
          margin: 0 auto;
          width: 100%;
        }
        .at-conditions-cards {
          display: block;
          columns: 1;
          gap: 8px;
        }
        .at-conditions-cards > div {
          break-inside: avoid;
          margin-bottom: 8px;
        }
        .at-strategies-grid {
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-width: 800px;
          margin: 0 auto;
          width: 100%;
        }
        .at-log {
          height: 128px;
        }
        /* 주문 내역: 한 줄 표시 + 세로 스크롤 */
        .at-order-table th,
        .at-order-table td {
          white-space: nowrap;
          word-break: keep-all;
          line-height: 1.25;
          padding: 3px 4px !important;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* 10개 컬럼 폭 배분 (PC: 고정 레이아웃 / 모바일: 자동 + 가로 스크롤) */
        .at-order-table col.c-check   { width: 4%; }
        .at-order-table col.c-time    { width: 8%; }
        .at-order-table col.c-name    { width: 30%; }
        .at-order-table col.c-type    { width: 5%; }
        .at-order-table col.c-qty     { width: 6%; }
        .at-order-table col.c-price   { width: 10%; }
        .at-order-table col.c-status  { width: 6%; }
        .at-order-table col.c-cur     { width: 10%; }
        .at-order-table col.c-profit  { width: 8%; }
        .at-order-table col.c-action  { width: 6%; }
        .at-order-table-wrap {
          max-height: 220px;
        }

        /* ===== PC(1024px~): 3분할 트레이딩 터미널 레이아웃 ===== */
        @media (min-width: 1024px) {
          /* PC는 컬럼 비율을 고정해 수평 스크롤 없이 표시 */
          .at-order-table { table-layout: fixed; }
          .auto-trading-container {
            padding-left: 0;
            padding-right: 0;
          }
          /* 주문시작 탭: 좌측 '사이드'(매매조건→계좌요약→보유종목→로그)
             · 우측 '상세'(차트/선택종목/검색종목)로 완전히 분리한다.
             컨테이너는 화면에 고정하고, 각 영역이 내부에서 스크롤한다. */
          .at-orders-scroll {
            display: grid;
            grid-template-columns: minmax(300px, 350px) minmax(0, 1fr);
            /* 1·2행: 제어 카드(내용) / 3·4행: 보유종목·로그가 남는 높이를 나눠 갖는다 */
            grid-template-rows: max-content max-content minmax(150px, 1fr) minmax(120px, 0.8fr);
            gap: 8px;
            padding: 6px 6px 6px 4px;
            /* 화면 높이에 맞춰 자동 확장 (헤더/탭 높이만큼 빼고 채운다) */
            height: 100%;
            min-height: 0;
            overflow: hidden;
            align-content: stretch;
            align-items: stretch;
          }
          /* ── 좌측 사이드 ───────────────────────────────── */
          .at-sec-conditions {
            grid-column: 1;
            grid-row: 1;
            border: 1px solid #4b5563;
            border-radius: 8px;
            overflow: hidden;
            align-self: start;
          }
          .at-sec-account {
            grid-column: 1;
            grid-row: 2;
            border-radius: 8px;
            overflow: hidden;
            align-self: start;
          }
          /* 사이드 하단 두 영역은 남는 높이를 나눠 갖고 내부에서 스크롤 */
          .at-sec-orders {
            grid-column: 1;
            grid-row: 3;
            min-height: 0;
            overflow: hidden;
          }
          .at-log {
            grid-column: 1;
            grid-row: 4;
            min-height: 0;
            overflow: hidden;
          }
          /* ── 우측 상세 ─────────────────────────────────── */
          .at-right-col {
            display: flex;
            flex-direction: column;
            gap: 8px;
            grid-column: 2;
            grid-row: 1 / -1;
            min-width: 0;
            min-height: 0;
            align-self: stretch;
            overflow-y: auto;
            /* 사이드와의 경계를 시각적으로 분리 */
            border-left: 1px solid #374151;
            padding-left: 8px;
          }
          .at-sec-chart { align-self: stretch; margin-bottom: 0 !important; flex: 0 0 auto; }
          .at-sec-watchlist { min-height: 0 !important; flex: 0 0 auto; }
          /* 좌측 사이드바는 폭이 좁아 핵심 컬럼만 표시 (시간/가격/현재가 숨김)
             컬럼 순서: 1체크 2종목명 3구분 4수량 5가격 6상태 7현재가 8수익률 9매도 10시간 */
          .at-sec-orders .at-order-table col.c-time,
          .at-sec-orders .at-order-table col.c-price,
          .at-sec-orders .at-order-table col.c-cur,
          .at-sec-orders .at-order-table th:nth-child(5),
          .at-sec-orders .at-order-table td:nth-child(5),
          .at-sec-orders .at-order-table th:nth-child(7),
          .at-sec-orders .at-order-table td:nth-child(7),
          .at-sec-orders .at-order-table th:nth-child(10),
          .at-sec-orders .at-order-table td:nth-child(10) {
            display: none;
          }
          .at-sec-orders .at-order-table col.c-check  { width: 8%; }
          .at-sec-orders .at-order-table col.c-name   { width: 34%; }
          .at-sec-orders .at-order-table col.c-type   { width: 9%; }
          .at-sec-orders .at-order-table col.c-qty    { width: 11%; }
          .at-sec-orders .at-order-table col.c-status { width: 10%; }
          .at-sec-orders .at-order-table col.c-profit { width: 19%; }
          .at-sec-orders .at-order-table col.c-action { width: 9%; }
          .at-sec-orders .at-order-table-wrap { max-height: none; }
          /* 검색된 종목: 우측 컬럼 안에서 남는 높이를 모두 차지 */
          .at-sec-detected {
            display: flex;
            flex-direction: column;
            flex: 1 1 auto;
            height: auto !important;
            min-height: 200px !important;
            border: 1px solid #4b5563;
            border-radius: 8px;
            overflow: hidden;
            padding: 0 4px 0 4px !important;
          }
          .at-sec-detected > div:last-child {
            flex: 1 1 auto;
            min-height: 0;
            height: auto !important;
          }
          /* 사이드 '현재 보유 종목' 카드: 남는 높이 채우고 내부 스크롤 */
          .at-sec-orders {
            border: 1px solid #4b5563;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
          }
          /* 사이드 '로그' 카드: 남는 높이 채우고 내부 세로 스크롤 */
          .at-log {
            border: 1px solid #374151;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            height: auto !important;
            min-height: 0;
          }
          /* PC: 주문 내역은 남는 높이를 채우고 내부에서 스크롤 */
          .at-order-table-wrap {
            max-height: none;
            flex: 1 1 auto;
            min-height: 0;
          }
          /* 검색된 종목: 10컬럼이 수평 스크롤 없이 들어오도록 폭 배분 */
        .at-sec-detected > div:last-child { overflow-x: auto !important; }
        .at-detected-table th,
        .at-detected-table td {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        /* 종목명은 말줄임 없이 전체 표시 (컬럼이 내용에 맞춰 늘어난다) */
        .at-detected-table td.at-col-name {
          overflow: visible;
          text-overflow: clip;
          white-space: nowrap;
          min-width: 300px;
        }
          .at-sec-detected > div:first-child {
            margin-bottom: 0 !important;
            padding: 2px 4px !important;
          }
          .at-sec-detected > div:last-child {
            padding-bottom: 0 !important;
          }

          /* 매매조건 탭: 카드 2열 masonry (조건검색식/사용자수식은 전체 폭) */
          .at-conditions-grid {
            display: block;
            max-width: 1400px;
          }
          .at-conditions-cards {
            display: block;
            column-count: 2;
            column-gap: 10px;
          }
          .at-conditions-cards > div {
            break-inside: avoid;
            margin-bottom: 10px;
          }
          .at-span2 { column-span: all; }

          /* 매매설정 탭: 2열 카드 그리드 */
          .at-strategies-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            align-items: start;
            gap: 12px;
            max-width: 1280px;
          }
        }

        /* 대형 모니터: 매매조건 3열 */
        @media (min-width: 1600px) {
          .at-orders-scroll {
            grid-template-columns: minmax(380px, 440px) minmax(0, 1fr);
          }
          .at-conditions-grid {
            max-width: 1600px;
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

          /* 모바일: 좌우 여백 최소화 */
          .auto-trading-container {
            padding-left: 0 !important;
            padding-right: 0 !important;
          }
          .trading-conditions-section,
          .account-summary-section {
            margin-left: 2px !important;
            margin-right: 2px !important;
            margin-top: 2px !important;
            margin-bottom: 2px !important;
            border-radius: 6px !important;
          }

          /* 모바일: 카드 사이 간격/내부 여백 최소화 */
          .at-orders-scroll { gap: 2px !important; }
          .at-sec-orders { padding: 4px !important; }
          .at-log { margin-top: 0 !important; }
          .at-sec-detected { margin: 0 !important; }
          .at-sec-detected > div:first-child h3 { font-size: 11px !important; }
          .account-summary-section h3,
          .trading-conditions-section h3 { margin-bottom: 1px !important; }

          /* 계좌 요약: 화면 폭에 맞춰 2열 → 폭 부족 시 1열로 자동 전환 */
          .at-account-grid {
            display: grid !important;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important;
            gap: 2px 4px !important;
          }

          /* 검색된 종목: 모바일에서 수평 스크롤 (컬럼 잘림 방지) */
          .at-sec-detected {
            height: auto !important;
            min-height: 0 !important;
            padding: 0 2px !important;
          }
          .at-detected-scroll {
            overflow-x: auto !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch;
            /* 부모 높이가 auto라 inline height:0 + flex:1 이면 0으로 접힌다 */
            height: auto !important;
            max-height: 260px;
            min-height: 0 !important;
          }
          .at-detected-table {
            width: max-content !important;
            min-width: 100% !important;
          }
          .at-detected-table th,
          .at-detected-table td {
            padding: 2px 4px !important;
          }

          /* 보유 종목 표도 모바일에서 수평 스크롤 */
          .at-order-table-wrap {
            overflow-x: auto !important;
            -webkit-overflow-scrolling: touch;
          }
          /* 글자 잘림 방지: 내용 폭 기준(auto) 레이아웃 + 가로 스크롤 */
          .at-order-table {
            table-layout: auto !important;
            width: max-content !important;
            min-width: 100% !important;
          }
          .at-order-table col { width: auto !important; }
          .at-order-table th,
          .at-order-table td {
            padding: 3px 5px !important;
            overflow: visible !important;
            text-overflow: clip !important;
          }

          /* 검색된 종목: 종목명 좌우 여백 축소 (폭은 내용에 맞춤) */
          .at-detected-table td.at-col-name,
          .at-detected-table th:first-child {
            padding-left: 2px !important;
            padding-right: 2px !important;
            min-width: 0 !important;
          }

          /* 로그 높이 축소 */
          .at-log {
            min-height: 90px !important;
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
            className="at-orders-scroll"
            style={{
              backgroundColor: theme === 'dark' ? '#111827' : 'white',
            }}
          >
            {/* 매매 조건 섹션 */}
            <div 
              className="trading-conditions-section at-sec-conditions"
              style={{
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
                padding: '2px 4px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
                flexShrink: 0
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                <h2 style={{ 
                  fontSize: '13px', 
                  fontWeight: 'bold', 
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  margin: 0
                }}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
                  매매 조건
                </h2>
                {/* 테마 전환 스위치 */}
                <button
                  onClick={toggleTheme}
                  className="relative w-9 h-5 rounded-full transition-all duration-300 bg-gradient-to-r from-blue-600 to-green-500 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  aria-label="테마 전환"
                  style={{ flexShrink: 0 }}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 flex items-center justify-center ${
                      theme === 'dark' ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  >
                    {theme === 'dark' ? (
                      <svg className="w-2.5 h-2.5 text-gray-800" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                      </svg>
                    ) : (
                      <svg className="w-2.5 h-2.5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                </button>
              </div>
              
              {/* 조건식 / 종목 / 매수유형 - 내부 2열 그리드 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 6px', fontSize: '11px', lineHeight: '1.5', marginBottom: '2px' }}>
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#374151' }}>조건식: </span>
                  <span style={{ color: '#16a34a', fontWeight: 500 }}>
                    {conditions.filter(c => c.enabled).length > 0 
                      ? conditions.filter(c => c.enabled).map(c => c.name).join(', ')
                      : '없음'}
                  </span>
                </div>

                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#374151' }}>종목: </span>
                  <span style={{ color: '#f59e0b', fontWeight: 500 }}>
                    {watchlistStocks.length > 0 
                      ? watchlistStocks.map(s => s.name).join(', ')
                      : '없음'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', gridColumn: '1 / -1' }}>
                  <span style={{ fontSize: '11px', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>매수유형</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="buyType"
                      value="cash"
                      checked={buyType === 'cash'}
                      onChange={(e) => setBuyType(e.target.value as 'cash')}
                      style={{ width: '12px', height: '12px' }}
                    />
                    <span style={{ fontSize: '11px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>현금매수</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="buyType"
                      value="credit"
                      checked={buyType === 'credit'}
                      onChange={(e) => setBuyType(e.target.value as 'credit')}
                      style={{ width: '12px', height: '12px' }}
                    />
                    <span style={{ fontSize: '11px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>신용매수</span>
                  </label>
                </div>
              </div>

              {/* 제어 버튼 그리드 (3열 × 2행) */}
              <div 
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '2px',
                }}
              >
                <button
                  onClick={handleStart}
                  disabled={!connected || !selectedAccount || isRunning}
                  className={`px-2 rounded font-semibold flex items-center justify-center gap-1 transition-all duration-300 ${
                    (!connected || !selectedAccount || isRunning)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'btn-gradient-primary'
                  }`}
                  style={{ padding: '8px 4px', gridColumn: 'span 2', fontSize: '14px' }}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '14px' }}>자동매매</span>
                </button>
                <button
                  onClick={handleCancelUnfilledOrders}
                  disabled={!connected || !selectedAccount}
                  className={`px-2 py-0.5 rounded font-semibold flex items-center justify-center gap-1 transition-all duration-300 ${
                    (!connected || !selectedAccount)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 shadow-lg hover:shadow-yellow-500/50'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '11px' }}>미체결취소</span>
                </button>
                <button
                  onClick={handleSellAll}
                  disabled={!connected || !selectedAccount || displayHoldingOrdersWithLive.length === 0 || selectedHoldingCodes.size === 0}
                  title="현재 보유 종목에서 체크한 종목을 시장가로 매도합니다"
                  className={`px-2 py-0.5 rounded font-semibold flex items-center justify-center gap-1 transition-all duration-300 ${
                    (!connected || !selectedAccount || displayHoldingOrdersWithLive.length === 0 || selectedHoldingCodes.size === 0)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 shadow-lg hover:shadow-orange-500/50'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '11px' }}>
                    선택매도{selectedHoldingCodes.size > 0 ? ` (${selectedHoldingCodes.size})` : ''}
                  </span>
                </button>
                <button
                  onClick={handleStop}
                  disabled={!isRunning}
                  className={`px-2 py-0.5 rounded font-semibold flex items-center justify-center gap-1 transition-all duration-300 ${
                    !isRunning
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 shadow-lg hover:shadow-red-500/50'
                  }`}
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6h12v12H6z" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '11px' }}>정지</span>
                </button>
                <button
                  onClick={handleRestart}
                  className="rounded font-semibold flex items-center justify-center gap-1 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 transition-all duration-300" style={{ padding: '3px 4px', fontSize: '11px' }}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '11px' }}>재시작</span>
                </button>
                <button
                  onClick={handleRefreshAccount}
                  disabled={!connected || !selectedAccount}
                  className={`px-2 py-0.5 rounded font-semibold flex items-center justify-center gap-1 transition-all duration-300 ${
                    (!connected || !selectedAccount)
                      ? 'bg-gray-500 cursor-not-allowed opacity-50'
                      : 'btn-gradient-primary'
                  }`}
                  style={{ gridColumn: '1 / -1' }}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="font-bold text-white" style={{ fontSize: '11px' }}>갱신</span>
                </button>
              </div>
            </div>

            {/* 계좌 요약 */}
            <div
              className="account-summary-section at-sec-account"
              style={{
                padding: '2px 4px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
                flexShrink: 0
              }}
            >
              <h3 style={{ fontSize: '12px', fontWeight: 600, margin: '0 0 2px 0', color: theme === 'dark' ? '#f3f4f6' : '#111827', display: 'flex', alignItems: 'center', gap: '4px' }}>
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
                  <div className="at-account-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 6px', fontSize: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>예수금:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountInfoData?.deposit ? Number(accountInfoData.deposit).toLocaleString() : '-'}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '10px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총매입금액:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountTotals.totalPurchase.toLocaleString()}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '10px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총평가금액:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountTotals.totalStockValue.toLocaleString()}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      textAlign: 'right',
                      fontSize: '10px'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총평가손익:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountTotals.totalProfit.toLocaleString()}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      textAlign: 'right',
                      fontSize: '10px',
                      color: accountTotals.totalProfit > 0 ? '#dc2626' :
                             accountTotals.totalProfit < 0 ? '#2563eb' : 
                             (theme === 'dark' ? '#f3f4f6' : '#000')
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>총수익률:</label>
                  <input
                    type="text"
                    readOnly
                    value={accountTotals.totalProfitRate.toFixed(2) + '%'}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      textAlign: 'right',
                      fontSize: '10px',
                      color: accountTotals.totalProfitRate > 0 ? '#dc2626' :
                             accountTotals.totalProfitRate < 0 ? '#2563eb' :
                             (theme === 'dark' ? '#f3f4f6' : '#000')
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>오늘 실현손익:</label>
                  <input
                    type="text"
                    readOnly
                    value={todayTotalRealizedProfit > 0 
                      ? `+${todayTotalRealizedProfit.toLocaleString()}원`
                      : todayTotalRealizedProfit < 0
                      ? `${todayTotalRealizedProfit.toLocaleString()}원`
                      : '0원'}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '1px 4px',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      backgroundColor: theme === 'dark' ? '#374151' : 'white',
                      textAlign: 'right',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      color: todayTotalRealizedProfit > 0 ? '#dc2626' :
                             todayTotalRealizedProfit < 0 ? '#2563eb' : 
                             (theme === 'dark' ? '#f3f4f6' : '#111827')
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ whiteSpace: 'nowrap', fontWeight: 500, color: theme === 'dark' ? '#d1d5db' : '#111827' }}>보유종목:</label>
                  <span style={{ fontWeight: 'bold', fontSize: '12px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{displayHoldingOrdersWithLive.length}개</span>
                  {(() => {
                    // 매도가능수량이 0이라 표에서 제외된 종목 수
                    // (미체결 매도 주문이 전량 잡고 있어 팔 수 없는 상태)
                    const rawRows: any[] = Array.isArray((balanceData as any)?.stocks)
                      ? (balanceData as any).stocks
                      : Array.isArray(balanceData) ? (balanceData as any) : []
                    const hidden = rawRows.filter((b: any) => {
                      const qty = Number(b.quantity ?? 0)
                      const sellable = Number(b.sellableQuantity ?? b.quantity ?? 0)
                      return qty > 0 && sellable <= 0
                    }).length
                    if (hidden === 0) return null
                    return (
                      <span
                        style={{ marginLeft: '6px', fontSize: '10px', color: '#f59e0b', fontWeight: 'normal' }}
                        title="미체결 매도 주문이 물량을 잡고 있습니다. '미체결취소' 후 매도하세요."
                      >
                        매도대기 {hidden}개
                      </span>
                    )
                  })()}
                </div>
              </div>
            </div>

            {/* 현재 보유 종목 (매수 체결 기준, 매도 내역 제외) */}
            <div 
              className="at-sec-orders"
              style={{
                minHeight: '200px',
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db',
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
                borderBottom: theme === 'dark' ? '1px solid #374151' : '1px solid #d1d5db' 
              }}>
                <h3 style={{ fontSize: '12px', fontWeight: 600, color: theme === 'dark' ? '#f3f4f6' : '#111827', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  현재 보유 종목
                </h3>
              </div>
              <div className="at-order-table-wrap" style={{ overflowX: 'auto', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
                <table className="at-order-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col className="c-check" />
                    <col className="c-name" />
                    <col className="c-type" />
                    <col className="c-qty" />
                    <col className="c-price" />
                    <col className="c-status" />
                    <col className="c-cur" />
                    <col className="c-profit" />
                    <col className="c-action" />
                    <col className="c-time" />
                  </colgroup>
                  <thead>
                    <tr style={{ backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 4px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>
                        <input
                          type="checkbox"
                          aria-label="전체 선택"
                          title="전체 선택"
                          checked={displayHoldingOrdersWithLive.length > 0 && displayHoldingOrdersWithLive.every(o => selectedHoldingCodes.has(o.stockCode))}
                          onChange={(e) => {
                            // 헤더 클릭 → 전체 선택 / 전체 해제
                            setSelectedHoldingCodes(e.target.checked
                              ? new Set(displayHoldingOrdersWithLive.map(o => o.stockCode))
                              : new Set())
                          }}
                          style={{ width: '13px', height: '13px', cursor: 'pointer' }}
                        />
                      </th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>종목명</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>구분</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>수량</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>가격</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>상태</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>현재가</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>수익률</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', width: '60px', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>매도</th>
                      <th style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827', position: 'sticky', top: 0, zIndex: 2, backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>시간</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // 잔고 기준으로 필터링된 목록을 쓴다 (잔고 0주 종목은 표시하지 않음)
                      const filteredOrders = displayHoldingOrdersWithLive
                      
                      return filteredOrders.length > 0 ? (
                        filteredOrders.map((order) => (
                          <tr
                            key={order.id} 
                            onClick={(e) => {
                              // 매도 버튼 클릭은 별도 처리
                              if ((e.target as HTMLElement).closest('button')) return
                              showChartForOrder(order)
                            }}
                            title={`${order.stockName} 차트 보기`}
                            style={{ cursor: 'pointer', backgroundColor: theme === 'dark' ? '#1f2937' : 'white' }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f9fafb'
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : 'white'
                            }}
                          >
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 4px', textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                aria-label={`${order.stockName} 선택`}
                                checked={selectedHoldingCodes.has(order.stockCode)}
                                onChange={(e) => {
                                  e.stopPropagation()
                                  setSelectedHoldingCodes(prev => {
                                    const next = new Set(prev)
                                    if (e.target.checked) next.add(order.stockCode)
                                    else next.delete(order.stockCode)
                                    return next
                                  })
                                }}
                                onClick={(e) => e.stopPropagation()}
                                style={{ width: '13px', height: '13px', cursor: 'pointer' }}
                              />
                            </td>
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', color: theme === 'dark' ? '#f3f4f6' : '#111827', overflow: 'hidden', textOverflow: 'ellipsis' }} title={order.stockName}>
                              {order.stockName}
                              {order.count > 1 && (
                                <span style={{ marginLeft: '4px', fontSize: '9px', color: theme === 'dark' ? '#fbbf24' : '#b45309' }}>×{order.count}</span>
                              )}
                            </td>
                            <td style={{ 
                              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                              padding: '4px 8px', 
                              textAlign: 'center',
                              color: order.type === 'buy' ? '#dc2626' : '#2563eb'
                            }}>
                              {order.type === 'buy' ? '매수' : order.type === 'sell' ? '매도' : '취소'}
                            </td>
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                              {order.quantity.toLocaleString()}
                              {/* 매도가능수량이 보유수량보다 적으면 미체결 매도 주문이 물량을 잡고 있다 */}
                              {order.sellableQuantity !== undefined && order.sellableQuantity < order.quantity && (
                                <span style={{ display: 'block', fontSize: '9px', color: '#f59e0b' }} title="미체결 매도 주문이 잡아둔 수량을 제외한 주문 가능 수량">
                                  매도가능 {order.sellableQuantity}
                                </span>
                              )}
                            </td>
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'right', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                              {order.isMarketOrder ? (
                                <span>
                                  <span style={{ fontSize: '10px', color: '#9ca3af' }}>시장가</span>
                                  {order.price > 0 && (
                                    <span style={{ fontSize: '10px', color: '#9ca3af' }}> ({order.price.toLocaleString()})</span>
                                  )}
                                </span>
                              ) : (
                                order.price.toLocaleString()
                              )}
                            </td>
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'center', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{order.status}</td>
                            <td style={{ 
                              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                              padding: '4px 8px', 
                              textAlign: 'right', 
                              color: theme === 'dark' ? '#f3f4f6' : '#111827',
                              fontWeight: (order.currentPrice) ? 'bold' : 'normal'
                            }}>
                              {order.currentPrice 
                                ? order.currentPrice.toLocaleString() 
                                : '-'}
                            </td>
                            <td style={{ 
                              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                              padding: '4px 8px', 
                              textAlign: 'right', 
                              color: order.type === 'buy' && (order.status === '체결' || order.status === '부분체결' || order.isExecuted) && order.profitPercent !== undefined
                                ? (order.profitPercent > 0 ? '#dc2626' : order.profitPercent < 0 ? '#2563eb' : (theme === 'dark' ? '#f3f4f6' : '#111827'))
                                : (theme === 'dark' ? '#f3f4f6' : '#111827'),
                              fontWeight: (order.type === 'buy' && (order.status === '체결' || order.status === '부분체결' || order.isExecuted) && order.profitPercent !== undefined) ? 'bold' : 'normal'
                            }}>
                              {order.type === 'buy' && (order.status === '체결' || order.status === '부분체결' || order.isExecuted) && order.profitPercent !== undefined
                                ? `${order.profitPercent > 0 ? '+' : ''}${order.profitPercent.toFixed(2)}%`
                                : '-'}
                            </td>
                            <td style={{ 
                              border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                              padding: '2px 4px', 
                              textAlign: 'center' 
                            }}>
                              {order.type === 'buy' && (order.status === '체결' || order.status === '부분체결' || order.isExecuted) ? (
                                (() => {
                                  // 매도가능수량(잔고의 trde_able_qty)이 0이면 주문해도 800033으로 거부된다.
                                  // 미체결 매도 주문이 물량을 잡고 있으므로 버튼을 막고 사유를 알린다.
                                  const noSellable = order.sellableQuantity !== undefined && order.sellableQuantity <= 0
                                  const disabled = !connected || !selectedAccount || noSellable
                                  return (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    console.log(`[매도 버튼 클릭] ${order.stockName} (${order.stockCode})`)
                                    handleSellStock(order.stockCode, order.stockName)
                                  }}
                                  disabled={disabled}
                                  title={noSellable
                                    ? '매도가능수량이 0주입니다. 미체결 매도 주문을 먼저 취소하세요.'
                                    : undefined}
                                  style={{
                                    padding: '2px 8px',
                                    fontSize: '10px',
                                    fontWeight: 'bold',
                                    color: 'white',
                                    backgroundColor: disabled ? '#9ca3af' : '#dc2626',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                    opacity: disabled ? 0.5 : 1,
                                    whiteSpace: 'nowrap',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!disabled) {
                                      e.currentTarget.style.backgroundColor = '#b91c1c'
                                    }
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!disabled) {
                                      e.currentTarget.style.backgroundColor = '#dc2626'
                                    }
                                  }}
                                >
                                  {noSellable ? '불가' : '매도'}
                                </button>
                                  )
                                })()
                              ) : '-'}
                            </td>
                            <td style={{ border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', padding: '4px 8px', textAlign: 'left', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>{order.time}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={10} style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '16px', 
                            textAlign: 'center', 
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280', 
                            backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb' 
                          }}>
                            {balanceLoading ? '보유 종목을 불러오는 중...' : '보유 종목이 없습니다'}
                          </td>
                        </tr>
                      )
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 우측 패널 (PC 2열) - 모바일에서는 display:contents 로 기존 흐름 유지 */}
            <div className="at-right-col">
            {/* 선택된 종목 */}
            {watchlistStocks.length > 0 && (
              <div 
                className="at-sec-watchlist"
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
                <div style={{ overflowX: 'auto', maxHeight: '260px', overflowY: 'auto' }}>
                  <table className="at-watch-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
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
                          }}>
                            ★ {stock.name}
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
                            {stock.change > 0 ? '+' : ''}{Math.round(stock.change).toLocaleString()}
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
            {(() => {
              if (!selectedStockForChart) return null
              // 클릭 시점 스냅샷 대신 최신 시세를 사용한다.
              // (selectedStockForChart는 WebSocket/폴링 갱신을 받지 않아 실시간 반영이 안 됐다)
              const liveStock =
                detectedStocks.find(s => s.code === selectedStockForChart.code) ||
                watchlistStocks.find(s => s.code === selectedStockForChart.code) ||
                (() => {
                  const h = holdingStocks.find(x => x.code === selectedStockForChart.code)
                  return h
                    ? { ...selectedStockForChart, price: h.currentPrice, changePercent: h.profitPercent }
                    : selectedStockForChart
                })()
              return (
              <div 
                className="at-sec-chart"
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
                      {liveStock.name} ({liveStock.code}) 차트
                    </h3>
                    <span style={{ 
                      fontSize: '11px', 
                      fontWeight: 'bold',
                      backgroundImage: liveStock.changePercent > 0 
                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                        : liveStock.changePercent < 0 
                        ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
                        : theme === 'dark'
                        ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
                        : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text'
                    }}>
                      {liveStock.price.toLocaleString()}원 
                      ({liveStock.changePercent > 0 ? '+' : ''}{liveStock.changePercent.toFixed(2)}%)
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
                  code={liveStock.code} 
                  period={chartPeriod}
                  isConnected={connected}
                  stockInfo={liveStock}
                  isSelected={true} // 선택된 종목이므로 true
                />
              </div>
              )
            })()}

            {/* 검색된 종목 리스트 */}
            <div 
              className="at-sec-detected"
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
                className="at-detected-scroll"
                style={{ 
                  overflowX: 'auto', 
                  overflowY: 'auto',
                  flex: '1 1 auto',
                  height: 0, // flexbox에서 높이 계산을 위해 필요
                  minHeight: 0 // flexbox 스크롤을 위한 필수 설정
                }}
              >
                <table className="at-detected-table" style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: '11px', lineHeight: '1.2' }}>
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
                        minWidth: '300px',
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
                        width: `${columnWidths.algorithm}px`,
                        position: 'relative',
                        userSelect: 'none'
                      }}>
                        알고리즘
                        <div
                          onMouseDown={(e) => handleResizeStart('algorithm', e)}
                          style={{
                            position: 'absolute',
                            right: '-3px',
                            top: 0,
                            bottom: 0,
                            width: '6px',
                            cursor: 'col-resize',
                            backgroundColor: resizingColumn === 'algorithm' 
                              ? '#3b82f6' 
                              : theme === 'dark' 
                                ? 'rgba(255, 255, 255, 0.2)' 
                                : 'rgba(0, 0, 0, 0.1)',
                            zIndex: 1,
                            transition: 'background-color 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (resizingColumn !== 'algorithm') {
                              (e.currentTarget as HTMLElement).style.backgroundColor = theme === 'dark' 
                                ? 'rgba(59, 130, 246, 0.5)' 
                                : 'rgba(59, 130, 246, 0.3)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (resizingColumn !== 'algorithm') {
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
                          <td 
                            className="at-col-name"
                            style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px',
                            color: theme === 'dark' 
                              ? (stock.changePercent > 0 ? '#ff4444' : stock.changePercent < 0 ? '#60a5fa' : '#f3f4f6')
                              : (stock.changePercent > 0 ? '#dc2626' : stock.changePercent < 0 ? '#2563eb' : '#111827'),
                            fontSize: '13px',
                            fontWeight: isInWatchlist ? 'bold' : 'normal',
                            position: 'relative',
                            whiteSpace: 'nowrap',
                            lineHeight: '1.2'
                          }}>
                            {isInWatchlist && (
                              <span style={{ 
                                marginRight: '2px', 
                                color: '#f59e0b',
                                fontSize: '10px'
                              }}>★</span>
                            )}
                            {stock.name}
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
                            {stock.change > 0 ? '+' : ''}{Math.round(stock.change).toLocaleString()}
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
                          }}>{(() => {
                            const prevClose = stock.prevClose || (stock.price - stock.change)
                            const v = pricePercentFromPrevClose(stock.openPrice, prevClose)
                            return v === null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
                          })()}</td>
                          <td style={{ 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db', 
                            padding: '2px 6px', 
                            textAlign: 'right',
                            color: theme === 'dark' ? '#ff4444' : '#111827',
                            fontSize: '13px',
                            lineHeight: '1.2',
                            width: `${columnWidths.highPercent}px`
                          }}>{(() => {
                            const prevClose = stock.prevClose || (stock.price - stock.change)
                            const v = pricePercentFromPrevClose(stock.highPrice, prevClose)
                            return v === null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
                          })()}</td>
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
                            fontSize: '12px',
                            color: theme === 'dark' ? '#a78bfa' : '#7c3aed',
                            width: `${columnWidths.algorithm}px`,
                            fontWeight: 500
                          }} title={stock.detectedCondition}>
                            {stock.detectedCondition || '-'}
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
                        <td colSpan={10} style={{ 
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

            {/* 로그 (좌측 사이드 하단) - at-right-col과 형제 */}

            {/* 하단 로그 영역 */}
            {showLogSection && (
              <div 
                className="at-log"
                style={{
                  backgroundColor: '#111827',
                  color: '#4ade80',
                  borderTop: '2px solid #374151',
                  display: 'flex',
                  flexDirection: 'column',
                  flexShrink: 0
                }}
              >
                <div 
                  style={{
                    padding: '5px',
                    backgroundColor: '#1f2937',
                    borderBottom: '1px solid #374151',
                    width: '100%',
                    display: 'flex',
                    flexFlow: 'row',
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
            <div className="at-conditions-grid">
              {/* 조건검색식 - 매수후보 탐색 (웹 기반 자체 조건식) */}
              <div className="at-span2" style={{ 
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
                <div className="at-cond-body">
                <div className="at-cond-main">
                {conditions.length > 0 ? (
                  <div className="at-cond-list" style={{ marginBottom: '8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
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
                            change: changeFromRate(stock.price, stock.changeRate),
                            changePercent: stock.changeRate,
                            volume: stock.volume,
                            openPrice: stock.openPrice,
                            highPrice: stock.highPrice,
                            detectedCondition: result.appliedConditions.join(', '),
                            detectedTime: new Date().toLocaleTimeString(),
                          }))
                          
                          applyConditionResults(newStocks)
                          
                          // 시가/고가 즉시 보강 (순위정보에는 없는 값)
                          enrichOpenHigh(newStocks.map(s => s.code))
                          
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
                </div>

                {/* 종목 직접 추가 (수동) — PC에서는 조건식 우측에 배치 */}
                <div className="at-cond-manual" style={{
                  marginTop: '8px',
                  paddingTop: '8px',
                  borderTop: theme === 'dark' ? '1px solid #4b5563' : '1px solid #e5e7eb'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', color: theme === 'dark' ? '#d1d5db' : '#374151' }}>
                    종목 직접 추가
                  </div>
                  <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                    <input
                      type="text"
                      value={manualKeyword}
                      onChange={(e) => setManualKeyword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleManualSearch()
                      }}
                      placeholder="종목명 또는 종목코드"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '4px 8px',
                        fontSize: '12px',
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                        borderRadius: '6px',
                        backgroundColor: theme === 'dark' ? '#374151' : 'white',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}
                    />
                    <button
                      onClick={handleManualSearch}
                      disabled={isManualSearching || !manualKeyword.trim()}
                      style={{
                        padding: '4px 10px',
                        fontSize: '12px',
                        color: 'white',
                        backgroundColor: isManualSearching || !manualKeyword.trim() ? '#9ca3af' : '#2563eb',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: isManualSearching || !manualKeyword.trim() ? 'not-allowed' : 'pointer',
                        flexShrink: 0
                      }}
                    >
                      {isManualSearching ? '검색중' : '검색'}
                    </button>
                    <button
                      onClick={handleManualAdd}
                      disabled={manualSelectedCodes.size === 0}
                      style={{
                        padding: '4px 10px',
                        fontSize: '12px',
                        color: 'white',
                        backgroundColor: manualSelectedCodes.size === 0 ? '#9ca3af' : '#16a34a',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: manualSelectedCodes.size === 0 ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      선택종목 추가 ({manualSelectedCodes.size})
                    </button>
                  </div>

                  {manualResults.length > 0 && (
                    <div style={{
                      maxHeight: '180px',
                      overflowY: 'auto',
                      border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                      borderRadius: '6px'
                    }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                        <thead>
                          <tr style={{ backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6' }}>
                            <th style={{ padding: '3px 4px', width: '28px' }}>
                              <input
                                type="checkbox"
                                aria-label="전체 선택"
                                checked={manualResults.length > 0 && manualResults.every(s => manualSelectedCodes.has(s.code))}
                                onChange={(e) => setManualSelectedCodes(e.target.checked ? new Set(manualResults.map(s => s.code)) : new Set())}
                                style={{ width: '13px', height: '13px', cursor: 'pointer' }}
                              />
                            </th>
                            <th style={{ padding: '3px 4px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>종목코드</th>
                            <th style={{ padding: '3px 4px', textAlign: 'left', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>종목명</th>
                            <th style={{ padding: '3px 4px', width: '44px', fontWeight: 'normal', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>상태</th>
                          </tr>
                        </thead>
                        <tbody>
                          {manualResults.map((stock) => {
                            const checked = manualSelectedCodes.has(stock.code)
                            const addedStock = detectedStocks.find(s => s.code === stock.code)
                            return (
                              <tr
                                key={stock.code}
                                onClick={() => {
                                  if (addedStock) return
                                  setManualSelectedCodes(prev => {
                                    const next = new Set(prev)
                                    if (next.has(stock.code)) next.delete(stock.code)
                                    else next.add(stock.code)
                                    return next
                                  })
                                }}
                                style={{
                                  cursor: addedStock ? 'default' : 'pointer',
                                  opacity: addedStock ? 0.7 : 1,
                                  backgroundColor: addedStock
                                    ? (theme === 'dark' ? '#3f2d0f' : '#fef3c7')
                                    : checked
                                      ? (theme === 'dark' ? '#064e3b' : '#f0fdf4')
                                      : (theme === 'dark' ? '#1f2937' : 'white')
                                }}
                              >
                                <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                                  <input
                                    type="checkbox"
                                    checked={addedStock ? false : checked}
                                    disabled={!!addedStock}
                                    onChange={() => {}}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ width: '13px', height: '13px', cursor: addedStock ? 'default' : 'pointer' }}
                                  />
                                </td>
                                <td style={{ padding: '3px 4px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>{stock.code}</td>
                                <td style={{ padding: '3px 4px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>{stock.name}</td>
                                <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                                  {addedStock ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleManualRemove(stock.code, stock.name)
                                      }}
                                      title="선택 해제"
                                      style={{
                                        padding: '1px 5px',
                                        fontSize: '10px',
                                        color: 'white',
                                        backgroundColor: '#dc2626',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap'
                                      }}
                                    >
                                      추가됨 ✕
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: '10px', color: theme === 'dark' ? '#6b7280' : '#9ca3af' }}>-</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* 추가된 종목 목록 */}
                  {(() => {
                    const manualAdded = detectedStocks.filter(s => s.detectedCondition === '수동추가')
                    return (
                      <div style={{ marginTop: '6px' }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '11px',
                          fontWeight: 600,
                          marginBottom: '4px',
                          color: theme === 'dark' ? '#d1d5db' : '#374151'
                        }}>
                          <span>추가된 종목 ({manualAdded.length}개)</span>
                          {manualAdded.length > 0 && (
                            <button
                              onClick={() => {
                                setDetectedStocks(prev => prev.filter(s => s.detectedCondition !== '수동추가'))
                                setManualSelectedCodes(new Set())
                                addLog('수동 추가 종목 전체 해제', 'info')
                              }}
                              style={{
                                padding: '1px 8px',
                                fontSize: '10px',
                                color: 'white',
                                backgroundColor: theme === 'dark' ? '#4b5563' : '#6b7280',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer'
                              }}
                            >
                              전체 해제
                            </button>
                          )}
                        </div>
                        {manualAdded.length === 0 ? (
                          <div style={{ fontSize: '10px', color: theme === 'dark' ? '#6b7280' : '#9ca3af', padding: '2px 0' }}>
                            추가된 종목이 없습니다
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                            {manualAdded.map((s) => (
                              <span
                                key={s.code}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  padding: '2px 6px',
                                  fontSize: '11px',
                                  borderRadius: '12px',
                                  border: theme === 'dark' ? '1px solid #92400e' : '1px solid #fbbf24',
                                  backgroundColor: theme === 'dark' ? '#78350f' : '#fef3c7',
                                  color: theme === 'dark' ? '#fde68a' : '#92400e'
                                }}
                              >
                                {s.name}
                                <button
                                  onClick={() => handleManualRemove(s.code, s.name)}
                                  title="선택 해제"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'inherit',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    lineHeight: 1,
                                    padding: 0,
                                    fontWeight: 'bold'
                                  }}
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })()}
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
                  <div>✓ 조건식에 없는 종목은 "종목 직접 추가"로 넣을 수 있습니다</div>
                </div>
                </div>
              </div>

              {/* 사용자수식 */}
              <div className="at-span2" style={{ 
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
                
                {/* 매수/매도 조건 — PC에서는 2열 */}
                <div className="at-formula-grid">
                {/* 매수조건 체크박스 */}
                <div style={{ marginBottom: '0' }}>
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
                  </div>
                </div>

                {/* 매도조건 체크박스 */}
                <div style={{ marginBottom: '0' }}>
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
              </div>
              

              {/* PC: 아래 카드들은 다단(masonry) 배치, 모바일은 세로 1열 */}
              <div className="at-conditions-cards">
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

              {/* 종목별 매수가격 설정 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '8px',
                borderRadius: '8px',
                marginTop: '8px'
              }}>
                <div style={{ 
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '6px',
                  gap: '6px'
                }}>
                  <input
                    type="checkbox"
                    checked={buyPriceSettings.종목별매수가격설정실행}
                    onChange={(e) => setBuyPriceSettings({
                      ...buyPriceSettings,
                      종목별매수가격설정실행: e.target.checked
                    })}
                    style={{
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ 
                    backgroundImage: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    color: 'white', 
                    padding: '3px 6px', 
                    fontSize: '12px', 
                    fontWeight: 'bold',
                    borderRadius: '6px',
                    flex: 1
                  }}>
                    종목별 매수가격 설정
                  </div>
                </div>
                
                {buyPriceSettings.종목별매수가격설정실행 && (
                  <div style={{ marginTop: '8px' }}>
                    {/* 매수가격 옵션 선택 */}
                    <div style={{ marginBottom: '8px' }}>
                      <div style={{ 
                        fontSize: '11px', 
                        marginBottom: '4px',
                        color: theme === 'dark' ? '#d1d5db' : '#374151',
                        fontWeight: '500'
                      }}>
                        매수가격 옵션
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          onClick={() => setBuyPriceSettings({
                            ...buyPriceSettings,
                            매수가격옵션: '시장가'
                          })}
                          style={{
                            flex: 1,
                            padding: '4px 8px',
                            backgroundColor: buyPriceSettings.매수가격옵션 === '시장가'
                              ? '#3b82f6'
                              : (theme === 'dark' ? '#374151' : '#e5e7eb'),
                            color: buyPriceSettings.매수가격옵션 === '시장가'
                              ? 'white'
                              : (theme === 'dark' ? '#d1d5db' : '#374151'),
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: buyPriceSettings.매수가격옵션 === '시장가' ? 'bold' : 'normal',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                        >
                          시장가
                        </button>
                        <button
                          onClick={() => setBuyPriceSettings({
                            ...buyPriceSettings,
                            매수가격옵션: '지정가'
                          })}
                          style={{
                            flex: 1,
                            padding: '4px 8px',
                            backgroundColor: buyPriceSettings.매수가격옵션 === '지정가'
                              ? '#3b82f6'
                              : (theme === 'dark' ? '#374151' : '#e5e7eb'),
                            color: buyPriceSettings.매수가격옵션 === '지정가'
                              ? 'white'
                              : (theme === 'dark' ? '#d1d5db' : '#374151'),
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: buyPriceSettings.매수가격옵션 === '지정가' ? 'bold' : 'normal',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                        >
                          지정가
                        </button>
                      </div>
                    </div>

                    {/* 매수호가 입력 (지정가일 때만 표시) */}
                    {buyPriceSettings.매수가격옵션 === '지정가' && (
                      <div>
                        <div style={{ 
                          fontSize: '11px', 
                          marginBottom: '4px',
                          color: theme === 'dark' ? '#d1d5db' : '#374151',
                          fontWeight: '500'
                        }}>
                          매수호가 (-10 ~ 0 ~ +10)
                        </div>
                        <input
                          type="number"
                          min="-10"
                          max="10"
                          value={buyPriceSettings.매수호가}
                          onChange={(e) => {
                            const value = parseInt(e.target.value) || 0
                            if (value >= -10 && value <= 10) {
                              setBuyPriceSettings({
                                ...buyPriceSettings,
                                매수호가: value
                              })
                            }
                          }}
                          onBlur={(e) => {
                            const value = parseInt(e.target.value) || 0
                            let clampedValue = value
                            if (value < -10) clampedValue = -10
                            if (value > 10) clampedValue = 10
                            setBuyPriceSettings({
                              ...buyPriceSettings,
                              매수호가: clampedValue
                            })
                          }}
                          style={{ 
                            width: '100%', 
                            padding: '4px 8px', 
                            border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                            backgroundColor: theme === 'dark' ? '#374151' : 'white',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                            textAlign: 'center', 
                            fontSize: '11px',
                            borderRadius: '6px'
                          }}
                        />
                        <div style={{ 
                          fontSize: '9px', 
                          color: theme === 'dark' ? '#9ca3af' : '#999', 
                          marginTop: '4px',
                          textAlign: 'center'
                        }}>
                          현재: {buyPriceSettings.매수호가} (범위: -10 ~ +10)
                        </div>
                      </div>
                    )}
                  </div>
                )}
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
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', fontSize: '11px', marginBottom: '6px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                  <span>시작:</span>
                  <Hms h={startHour} m={startMinute} onH={setStartHour} onM={setStartMinute} theme={theme} />
                  <span style={{ marginLeft: '4px' }}>~ 종료:</span>
                  <Hms h={endHour} m={endMinute} s={endSecond} onH={setEndHour} onM={setEndMinute} onS={setEndSecond} theme={theme} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', marginBottom: '4px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                  <input
                    type="checkbox"
                    checked={dropSellTime}
                    onChange={(e) => setDropSellTime(e.target.checked)}
                    style={{ width: '16px', height: '16px', borderRadius: '3px' }}
                  />
                  목표시간 도달시 보유종목 전량매도
                </label>
                <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                  <Hms h={dropSellStartHour} m={dropSellStartMinute} s={dropSellEndSecond} onH={setDropSellStartHour} onM={setDropSellStartMinute} onS={setDropSellEndSecond} theme={theme} disabled={!dropSellTime} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', marginBottom: '4px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                  <input
                    type="checkbox"
                    checked={pauseBuyEnabled}
                    onChange={(e) => setPauseBuyEnabled(e.target.checked)}
                    style={{ width: '16px', height: '16px', borderRadius: '3px' }}
                  />
                  시간대정지 (매수만 중단, 매도는 계속)
                </label>
                <div style={{ marginLeft: '22px', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  <Hms h={pauseStartHour} m={pauseStartMinute} onH={setPauseStartHour} onM={setPauseStartMinute} theme={theme} disabled={!pauseBuyEnabled} />
                  <span style={{ fontSize: '11px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>~</span>
                  <Hms h={pauseEndHour} m={pauseEndMinute} onH={setPauseEndHour} onM={setPauseEndMinute} theme={theme} disabled={!pauseBuyEnabled} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                    <input
                      type="checkbox"
                      checked={buyStopped}
                      onChange={(e) => { setBuyStopped(e.target.checked); addLog(e.target.checked ? '즉시 매수정지 적용 (매도는 계속)' : '즉시 매수정지 해제', 'warning') }}
                      style={{ width: '16px', height: '16px', borderRadius: '3px' }}
                    />
                    즉시 매수정지 (매도는 계속)
                  </label>
                  <button
                    onClick={() => { setBuyStopped(false); addLog('매수 재개', 'success') }}
                    disabled={!buyStopped}
                    style={{
                      padding: '3px 10px',
                      backgroundColor: buyStopped ? '#16a34a' : (theme === 'dark' ? '#4b5563' : '#d1d5db'),
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: buyStopped ? 'pointer' : 'not-allowed',
                      fontSize: '11px',
                      fontWeight: 600
                    }}
                  >
                    매수 재개
                  </button>
                </div>
                <div style={{ fontSize: '11px', color: canBuy ? '#22c55e' : (theme === 'dark' ? '#fbbf24' : '#b45309') }}>
                  매수상태: {canBuy ? '진행중' : `중단 (${buyBlockReason})`}
                  {pauseBuyEnabled ? ` · 시간대정지 ${pad2(pauseStartHour)}:${pad2(pauseStartMinute)}~${pad2(pauseEndHour)}:${pad2(pauseEndMinute)}` : ''}
                  {dropSellTime ? ` · 전량매도 ${pad2(dropSellStartHour)}:${pad2(dropSellStartMinute)}:${pad2(dropSellEndSecond)}` : ''}
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
                    }}>실행</span>
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
                  <div style={{ marginLeft: '24px', marginTop: '4px', fontSize: '10px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>
                    {profitType === 'limit'
                      ? '✓ 지정가 매도: 현재가로 주문합니다. 상한가처럼 매도 호가가 얇은 종목도 체결됩니다.'
                      : '⚠ 시장가 매도: 유동성이 낮으면 체결되지 않고 미체결로 남아 물량이 잠깁니다.'}
                  </div>
                </div>
                <div style={{ fontSize: '12px' }}>
                  <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="checkbox"
                        checked={stopLossEnabled}
                        onChange={(e) => setStopLossEnabled(e.target.checked)}
                        style={{ borderRadius: '3px' }}
                      />
                      <span style={{
                        background: theme === 'dark' 
                          ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                          : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}>손절 기준손실률: </span>
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={stopLossRate}
                      onChange={(e) => setStopLossRate(Number(e.target.value))}
                      disabled={!stopLossEnabled}
                      style={{ 
                        width: '60px', 
                        padding: '2px 4px', 
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999',
                        backgroundColor: stopLossEnabled ? (theme === 'dark' ? '#374151' : 'white') : (theme === 'dark' ? '#1f2937' : '#f3f4f6'),
                        color: stopLossEnabled ? (theme === 'dark' ? '#f3f4f6' : '#111827') : (theme === 'dark' ? '#6b7280' : '#9ca3af'),
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
                    }}> % 이하일때 시장가 매도</span>
                  </div>
                  {stopLossEnabled && (
                    <div style={{ 
                      marginLeft: '24px', 
                      marginBottom: '8px', 
                      padding: '8px', 
                      backgroundColor: theme === 'dark' ? '#1f2937' : '#fef3c7',
                      borderRadius: '8px',
                      fontSize: '11px'
                    }}>
                      <span style={{ color: theme === 'dark' ? '#fbbf24' : '#92400e' }}>
                        ⚠️ 손절 활성화: 수익률이 {stopLossRate}% 이하가 되면 자동으로 시장가 매도됩니다.
                      </span>
                    </div>
                  )}
                  <div style={{ marginTop: '12px', marginBottom: '8px' }}>
                    <span style={{
                      background: theme === 'dark' 
                        ? 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)'
                        : 'linear-gradient(135deg, #111827 0%, #374151 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      color: theme === 'dark' ? '#f3f4f6' : '#111827'
                    }}>기타 매도 기준손실률: </span>
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
                      />                      <span style={{
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

              {/* 단계별 익절 설정 */}
              <div style={{ 
                border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #999', 
                backgroundColor: theme === 'dark' ? '#1f2937' : 'white', 
                padding: '12px',
                borderRadius: '8px',
                opacity: stepProfit.사용 ? 1 : 0.75
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <h4 style={{ 
                    fontSize: '13px', 
                    fontWeight: 'bold', 
                    margin: 0, 
                    borderBottom: theme === 'dark' ? '1px solid #4b5563' : '1px solid #ddd', 
                    paddingBottom: '8px',
                    flex: 1,
                    backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text'
                  }}>단계별 익절 설정</h4>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                    <input
                      type="checkbox"
                      checked={stepProfit.사용}
                      onChange={(e) => setStepProfit(prev => ({ ...prev, 사용: e.target.checked }))}
                      style={{ width: '16px', height: '16px', borderRadius: '3px' }}
                    />
                    사용
                  </label>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: theme === 'dark' ? '#f3f4f6' : '#111827' }}>
                  {([
                    ['익절1', '1차(10%)'],
                    ['익절2', '2차(40%)'],
                    ['익절3', '3차(60%)'],
                    ['익절4', '4차(잔량)'],
                    ['손절', '손절'],
                  ] as const).map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span>{label}</span>
                      <Num
                        value={stepProfit[key]}
                        step={0.1}
                        min={-100}
                        max={1000}
                        theme={theme}
                        width="52px"
                        disabled={!stepProfit.사용}
                        onChange={(v) => setStepProfit(prev => ({ ...prev, [key]: v }))}
                      />
                      <span>%</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: '10px', marginTop: '6px', color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>
                  단계 도달시 보유수량의 10% → 40% → 60% → 잔량 순으로 분할 매도합니다. (손절은 전량)
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
            <div className="at-strategies-grid">
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
                            // 관리자 API는 서버에서 토큰을 검증한다
                            'x-admin-token': adminCode.trim(),
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

