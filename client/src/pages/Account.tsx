import React from 'react'
import { useQuery } from 'react-query'
import { kiwoomApi } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'

const Account = () => {
  const { connected } = useKiwoomStore()

  const { data: accountInfo, isLoading: accountLoading } = useQuery(
    'account',
    () => kiwoomApi.getAccounts(),
    {
      enabled: connected,
      refetchInterval: 5000,
    }
  )

  const { data: balance = [], isLoading: balanceLoading } = useQuery(
    'balance',
    () => kiwoomApi.getBalance(),
    {
      enabled: connected,
      refetchInterval: 5000,
    }
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
      <h2 className="text-2xl font-bold">계좌 정보</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 계좌 정보 카드 */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">계좌 현황</h3>
          {accountLoading ? (
            <p className="text-gray-500">로딩 중...</p>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">예수금</span>
                <span className="font-medium">
                  {accountInfo?.deposit?.toLocaleString() || '-'}원
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">주문가능금액</span>
                <span className="font-medium">
                  {accountInfo?.available?.toLocaleString() || '-'}원
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">총 평가금액</span>
                <span className="font-medium">
                  {accountInfo?.total?.toLocaleString() || '-'}원
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 보유 종목 요약 */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">보유 종목 요약</h3>
          {balanceLoading ? (
            <p className="text-gray-500">로딩 중...</p>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">보유 종목 수</span>
                <span className="font-medium">{balance.length}개</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">총 보유 수량</span>
                <span className="font-medium">
                  {balance.reduce((sum: number, stock: any) => sum + (stock.quantity || 0), 0).toLocaleString()}주
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 보유 종목 상세 */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">보유 종목 상세</h3>
        {balanceLoading ? (
          <p className="text-gray-500">로딩 중...</p>
        ) : balance.length === 0 ? (
          <p className="text-gray-500 text-center py-8">보유 종목이 없습니다</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">종목코드</th>
                  <th className="text-left p-2">종목명</th>
                  <th className="text-right p-2">보유수량</th>
                  <th className="text-right p-2">평균단가</th>
                  <th className="text-right p-2">현재가</th>
                  <th className="text-right p-2">평가금액</th>
                  <th className="text-right p-2">평가손익</th>
                  <th className="text-right p-2">수익률</th>
                </tr>
              </thead>
              <tbody>
                {balance.map((stock: any) => (
                  <tr key={stock.code} className="border-b hover:bg-gray-50">
                    <td className="p-2">{stock.code}</td>
                    <td className="p-2">{stock.name || '-'}</td>
                    <td className="p-2 text-right">{stock.quantity?.toLocaleString() || '-'}주</td>
                    <td className="p-2 text-right">
                      {stock.avgPrice?.toLocaleString() || '-'}원
                    </td>
                    <td className="p-2 text-right">
                      {stock.currentPrice?.toLocaleString() || '-'}원
                    </td>
                    <td className="p-2 text-right">
                      {stock.evaluation?.toLocaleString() || '-'}원
                    </td>
                    <td
                      className={`p-2 text-right ${
                        stock.profit > 0 ? 'text-red-600' : stock.profit < 0 ? 'text-blue-600' : ''
                      }`}
                    >
                      {stock.profit ? `${stock.profit > 0 ? '+' : ''}${stock.profit.toLocaleString()}원` : '-'}
                    </td>
                    <td
                      className={`p-2 text-right ${
                        stock.profitRate > 0
                          ? 'text-red-600'
                          : stock.profitRate < 0
                          ? 'text-blue-600'
                          : ''
                      }`}
                    >
                      {stock.profitRate
                        ? `${stock.profitRate > 0 ? '+' : ''}${stock.profitRate.toFixed(2)}%`
                        : '-'}
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

export default Account

