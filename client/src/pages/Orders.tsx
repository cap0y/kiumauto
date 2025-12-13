import React, { useState } from 'react'
import { kiwoomApi, OrderRequest } from '../api/kiwoom'
import { useKiwoomStore } from '../store/useKiwoomStore'
import toast from 'react-hot-toast'

const Orders = () => {
  const { connected } = useKiwoomStore()
  const [orderModalOpen, setOrderModalOpen] = useState(false)
  const [order, setOrder] = useState<OrderRequest>({
    code: '',
    quantity: 0,
    price: 0,
    order_type: 'buy',
    order_option: '00', // 00: 지정가, 01: 시장가
  })

  const handlePlaceOrder = async () => {
    if (!order.code || order.quantity <= 0) {
      toast.error('종목코드와 수량을 입력해주세요')
      return
    }

    try {
      await kiwoomApi.placeOrder(order)
      toast.success('주문이 전송되었습니다')
      setOrderModalOpen(false)
      setOrder({
        code: '',
        quantity: 0,
        price: 0,
        order_type: 'buy',
        order_option: '00',
      })
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '주문 전송 실패')
    }
  }

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
        <h2 className="text-2xl font-bold">주문 내역</h2>
        <button
          onClick={() => setOrderModalOpen(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          주문하기
        </button>
      </div>

      {/* 주문 모달 */}
      {orderModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold mb-4">주문하기</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">종목코드</label>
                <input
                  type="text"
                  value={order.code}
                  onChange={(e) => setOrder({ ...order, code: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="예: 005930"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">주문유형</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOrder({ ...order, order_type: 'buy' })}
                    className={`flex-1 px-4 py-2 rounded-lg ${
                      order.order_type === 'buy'
                        ? 'bg-red-600 text-white'
                        : 'bg-gray-100'
                    }`}
                  >
                    매수
                  </button>
                  <button
                    onClick={() => setOrder({ ...order, order_type: 'sell' })}
                    className={`flex-1 px-4 py-2 rounded-lg ${
                      order.order_type === 'sell'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100'
                    }`}
                  >
                    매도
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">주문옵션</label>
                <select
                  value={order.order_option}
                  onChange={(e) => setOrder({ ...order, order_option: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="00">지정가</option>
                  <option value="01">시장가</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">수량</label>
                <input
                  type="number"
                  value={order.quantity || ''}
                  onChange={(e) =>
                    setOrder({ ...order, quantity: parseInt(e.target.value) || 0 })
                  }
                  className="w-full px-3 py-2 border rounded-lg"
                  min="1"
                />
              </div>
              {order.order_option === '00' && (
                <div>
                  <label className="block text-sm font-medium mb-1">가격</label>
                  <input
                    type="number"
                    value={order.price || ''}
                    onChange={(e) =>
                      setOrder({ ...order, price: parseInt(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 border rounded-lg"
                    min="0"
                  />
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handlePlaceOrder}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  주문 전송
                </button>
                <button
                  onClick={() => setOrderModalOpen(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 rounded-lg hover:bg-gray-300"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500 text-center py-8">
          주문 내역 기능은 키움증권 API의 주문 조회 엔드포인트 구현 후 표시됩니다
        </p>
      </div>
    </div>
  )
}

export default Orders

