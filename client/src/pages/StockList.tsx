import React, { useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { kiwoomApi } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'

const StockList = () => {
  const { connected } = useKiwoomStore()
  const [market, setMarket] = useState('0')
  const [searchTerm, setSearchTerm] = useState('')

  const { data: stocks = [], isLoading } = useQuery(
    ['stocks', market],
    () => kiwoomApi.getStocks(market),
    {
      enabled: connected,
      refetchInterval: 10000,
    }
  )

  const filteredStocks = stocks.filter((stock: any) =>
    stock.name?.includes(searchTerm) || stock.code?.includes(searchTerm)
  )

  if (!connected) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">키움증권 API에 연결해주세요</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">종목 조회</h2>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex gap-4 mb-4">
          <button
            onClick={() => setMarket('0')}
            className={`px-4 py-2 rounded-lg ${
              market === '0' ? 'bg-blue-600 text-white' : 'bg-gray-100'
            }`}
          >
            코스피
          </button>
          <button
            onClick={() => setMarket('10')}
            className={`px-4 py-2 rounded-lg ${
              market === '10' ? 'bg-blue-600 text-white' : 'bg-gray-100'
            }`}
          >
            코스닥
          </button>
        </div>

        <input
          type="text"
          placeholder="종목명 또는 코드 검색..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 border rounded-lg mb-4"
        />

        {isLoading ? (
          <div className="text-center py-12">로딩 중...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">종목코드</th>
                  <th className="text-left p-2">종목명</th>
                  <th className="text-right p-2">현재가</th>
                  <th className="text-right p-2">등락률</th>
                  <th className="text-right p-2">거래량</th>
                  <th className="text-center p-2">작업</th>
                </tr>
              </thead>
              <tbody>
                {filteredStocks.map((stock: any) => (
                  <tr key={stock.code} className="border-b hover:bg-gray-50">
                    <td className="p-2">{stock.code}</td>
                    <td className="p-2">{stock.name || '-'}</td>
                    <td className="p-2 text-right">
                      {stock.price?.toLocaleString() || '-'}
                    </td>
                    <td
                      className={`p-2 text-right ${
                        stock.changePercent > 0
                          ? 'text-red-600'
                          : stock.changePercent < 0
                          ? 'text-blue-600'
                          : ''
                      }`}
                    >
                      {stock.changePercent
                        ? `${stock.changePercent > 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%`
                        : '-'}
                    </td>
                    <td className="p-2 text-right">
                      {stock.volume?.toLocaleString() || '-'}
                    </td>
                    <td className="p-2 text-center">
                      <Link
                        to={`/chart/${stock.code}`}
                        className="text-blue-600 hover:underline"
                      >
                        차트보기
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default StockList

