import React, { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from 'react-query'
import { kiwoomApi } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'
import { useThemeStore } from '../store/useThemeStore'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

const Chart = () => {
  const { code } = useParams<{ code: string }>()
  const { connected } = useKiwoomStore()
  const { theme } = useThemeStore()
  const [period, setPeriod] = useState('min')

  const { data: candles = [], isLoading, error } = useQuery(
    ['candle', code, period],
    () => kiwoomApi.getCandle(code!, period),
    {
      enabled: connected && !!code,
      refetchInterval: 10000,
      retry: false,
    }
  )

  // 현재가 정보 조회 (차트 데이터가 없을 때 대체용)
  const { data: currentPrice } = useQuery(
    ['stockPrice', code],
    () => kiwoomApi.getStockPrice(code!),
    {
      enabled: connected && !!code && (!candles || candles.length === 0),
      retry: false,
    }
  )

  const chartData = candles.map((candle: any) => ({
    time: candle.일자 || candle.time || candle.date || '',
    open: parseFloat(candle.시가 || candle.open || '0') || 0,
    high: parseFloat(candle.고가 || candle.high || '0') || 0,
    low: parseFloat(candle.저가 || candle.low || '0') || 0,
    close: parseFloat(candle.종가 || candle.close || '0') || 0,
    volume: parseFloat(candle.거래량 || candle.volume || '0') || 0,
  })).filter((item: any) => item.time && (item.open > 0 || item.high > 0 || item.low > 0 || item.close > 0))

  if (!connected) {
    return (
      <div className="text-center py-12">
        <p className={theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}>키움증권 API에 연결해주세요</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className={`text-2xl font-bold ${theme === 'dark' ? 'text-gray-100' : 'text-gray-900'}`}>차트 - {code}</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setPeriod('tick')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              period === 'tick' 
                ? 'bg-blue-600 text-white' 
                : theme === 'dark' 
                  ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            틱
          </button>
          <button
            onClick={() => setPeriod('min')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              period === 'min' 
                ? 'bg-blue-600 text-white' 
                : theme === 'dark' 
                  ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            분봉
          </button>
          <button
            onClick={() => setPeriod('day')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              period === 'day' 
                ? 'bg-blue-600 text-white' 
                : theme === 'dark' 
                  ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            일봉
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className={`text-center py-12 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>로딩 중...</div>
      ) : chartData.length === 0 ? (
        // 차트 데이터가 없을 때 현재가 정보로 대체 차트 생성
        (() => {
          if (currentPrice && currentPrice.price && currentPrice.price > 0) {
            const now = new Date()
            const year = now.getFullYear()
            const month = String(now.getMonth() + 1).padStart(2, '0')
            const day = String(now.getDate()).padStart(2, '0')
            const hours = String(now.getHours()).padStart(2, '0')
            const minutes = String(now.getMinutes()).padStart(2, '0')
            
            const dateStr = period === 'day' 
              ? `${year}${month}${day}` 
              : `${year}${month}${day}${hours}${minutes}`
            
            const price = currentPrice.price
            const changePercent = currentPrice.changePercent || 0
            const changeRange = changePercent !== 0 
              ? Math.abs(price * (changePercent / 100))
              : price * 0.01
            const estimatedHigh = price + changeRange
            const estimatedLow = price - changeRange
            
            const fallbackChartData = [{
              time: dateStr,
              open: price,
              high: estimatedHigh,
              low: estimatedLow,
              close: price,
              volume: currentPrice.volume || 0,
            }]
            
            return (
              <div className={`${theme === 'dark' ? 'bg-gray-800' : 'bg-white'} rounded-lg shadow p-6`}>
                <ResponsiveContainer width="100%" height={500}>
                  <LineChart data={fallbackChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={theme === 'dark' ? '#4b5563' : '#e5e7eb'} />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                      tickFormatter={(value) => {
                        if (period === 'day' && value.length >= 8) {
                          return value.substring(4, 8)
                        }
                        if (value.length >= 12) {
                          return value.substring(8, 12)
                        }
                        return value
                      }}
                    />
                    <YAxis 
                      domain={['auto', 'auto']}
                      tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                      tickFormatter={(value) => value.toLocaleString()}
                    />
                    <Tooltip 
                      contentStyle={{
                        backgroundColor: theme === 'dark' ? '#374151' : '#ffffff',
                        border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                        borderRadius: '8px',
                        color: theme === 'dark' ? '#f3f4f6' : '#111827'
                      }}
                      labelStyle={{ color: theme === 'dark' ? '#f3f4f6' : '#111827' }}
                      formatter={(value: any) => value.toLocaleString()}
                      labelFormatter={(label) => `시간: ${label}`}
                    />
                    <Line
                      type="monotone"
                      dataKey="close"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={true}
                      name="종가"
                    />
                    <Line
                      type="monotone"
                      dataKey="high"
                      stroke="#22c55e"
                      strokeWidth={1}
                      dot={true}
                      strokeDasharray="2 2"
                      name="고가"
                    />
                    <Line
                      type="monotone"
                      dataKey="low"
                      stroke="#ef4444"
                      strokeWidth={1}
                      dot={true}
                      strokeDasharray="2 2"
                      name="저가"
                    />
                  </LineChart>
                </ResponsiveContainer>
                <div className={`text-center mt-4 text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  * 현재가 정보를 기반으로 표시된 차트입니다
                </div>
              </div>
            )
          }
          
          const errorMessage = error 
            ? ((error as any).response?.data?.error || '차트 데이터를 불러올 수 없습니다')
            : '차트 데이터가 없습니다'
          
          return (
            <div className="text-center py-12">
              <p className={theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}>{errorMessage}</p>
            </div>
          )
        })()
      ) : (
        <div className={`${theme === 'dark' ? 'bg-gray-800' : 'bg-white'} rounded-lg shadow p-6`}>
          <ResponsiveContainer width="100%" height={500}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme === 'dark' ? '#4b5563' : '#e5e7eb'} />
              <XAxis 
                dataKey="time" 
                tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                tickFormatter={(value) => {
                  if (period === 'day' && value.length >= 8) {
                    return value.substring(4, 8) // YYYYMMDD -> MMDD
                  }
                  if (value.length >= 12) {
                    return value.substring(8, 12) // YYYYMMDDHHMM -> HHMM
                  }
                  return value
                }}
              />
              <YAxis 
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: theme === 'dark' ? '#d1d5db' : '#374151' }}
                tickFormatter={(value) => value.toLocaleString()}
              />
              <Tooltip 
                contentStyle={{
                  backgroundColor: theme === 'dark' ? '#374151' : '#ffffff',
                  border: theme === 'dark' ? '1px solid #4b5563' : '1px solid #d1d5db',
                  borderRadius: '8px',
                  color: theme === 'dark' ? '#f3f4f6' : '#111827'
                }}
                labelStyle={{ color: theme === 'dark' ? '#f3f4f6' : '#111827' }}
                formatter={(value: any) => value.toLocaleString()}
                labelFormatter={(label) => `시간: ${label}`}
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={chartData.length <= 5}
                name="종가"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

export default Chart

