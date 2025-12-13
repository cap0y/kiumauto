import React, { useEffect, useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { kiwoomApi } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'
import toast from 'react-hot-toast'

const Dashboard = () => {
  const { connected, checkStatus } = useKiwoomStore()
  const [connectionModalOpen, setConnectionModalOpen] = useState(false)
  const [config, setConfig] = useState({
    host: 'https://openapi.kiwoom.com',
    appkey: '',
    secretkey: '',
  })

  const { data: accountInfo } = useQuery(
    'account',
    () => kiwoomApi.getAccounts(),
    {
      enabled: connected,
      refetchInterval: 5000,
    }
  )

  const { data: balance } = useQuery(
    'balance',
    () => kiwoomApi.getBalance(),
    {
      enabled: connected,
      refetchInterval: 5000,
    }
  )

  useEffect(() => {
    if (!connected) {
      checkStatus()
    }
  }, [connected, checkStatus])

  const handleConnect = async () => {
    try {
      const { connect } = useKiwoomStore.getState()
      await connect(config)
      setConnectionModalOpen(false)
      toast.success('키움증권 API 연결 성공')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '연결 실패')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">대시보드</h2>
        {!connected && (
          <button
            onClick={() => setConnectionModalOpen(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            키움증권 연결
          </button>
        )}
      </div>

      {/* 연결 모달 */}
      {connectionModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold mb-4">키움증권 API 연결</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Host</label>
                <input
                  type="text"
                  value={config.host}
                  onChange={(e) => setConfig({ ...config, host: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">App Key</label>
                <input
                  type="text"
                  value={config.appkey}
                  onChange={(e) => setConfig({ ...config, appkey: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Secret Key</label>
                <input
                  type="password"
                  value={config.secretkey}
                  onChange={(e) => setConfig({ ...config, secretkey: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleConnect}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  연결
                </button>
                <button
                  onClick={() => setConnectionModalOpen(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 rounded-lg hover:bg-gray-300"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {connected ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* 계좌 정보 카드 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">계좌 정보</h3>
            {accountInfo ? (
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">예수금</span>
                  <span className="font-medium">
                    {accountInfo.deposit?.toLocaleString() || '-'}원
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">보유종목</span>
                  <span className="font-medium">{balance?.length || 0}개</span>
                </div>
              </div>
            ) : (
              <p className="text-gray-500">로딩 중...</p>
            )}
          </div>

          {/* 보유 종목 카드 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">보유 종목</h3>
            {balance && balance.length > 0 ? (
              <div className="space-y-2">
                {balance.slice(0, 5).map((stock: any) => (
                  <div key={stock.code} className="flex justify-between">
                    <span>{stock.name || stock.code}</span>
                    <span>{stock.quantity}주</span>
                  </div>
                ))}
                {balance.length > 5 && (
                  <Link to="/account" className="text-blue-600 text-sm">
                    더보기 →
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-gray-500">보유 종목이 없습니다</p>
            )}
          </div>

          {/* 빠른 링크 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold mb-4">빠른 링크</h3>
            <div className="space-y-2">
              <Link
                to="/auto-trading"
                className="block px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 font-medium"
              >
                🤖 자동매매 시작
              </Link>
              <Link
                to="/stocks"
                className="block px-4 py-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100"
              >
                종목 조회
              </Link>
              <Link
                to="/settings"
                className="block px-4 py-2 bg-green-50 text-green-600 rounded-lg hover:bg-green-100"
              >
                매매 설정
              </Link>
              <Link
                to="/orders"
                className="block px-4 py-2 bg-purple-50 text-purple-600 rounded-lg hover:bg-purple-100"
              >
                주문 내역
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-500 text-lg mb-4">
            키움증권 API에 연결하여 시작하세요
          </p>
          <button
            onClick={() => setConnectionModalOpen(true)}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            연결하기
          </button>
        </div>
      )}
    </div>
  )
}

export default Dashboard

