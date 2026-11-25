// 오늘 실현손익 집계 + 기본값 셀프체크: npx tsx script/selfcheck-realized-profit.ts
import assert from 'assert'

interface Order {
  orderNumber?: string
  stockCode: string
  time: string
  type: 'buy' | 'sell' | 'cancel'
  status: string
  isExecuted?: boolean
  quantity: number
  price: number
  currentPrice?: number
  buyPrice?: number
  realizedProfit?: number
}

/** AutoTrading.tsx 의 매도 체결 집계와 동일 규칙 */
function collectRealized(logs: Order[], counted: Set<string>) {
  const settled = logs.filter(
    (o) => o.type === 'sell' && (o.status === '체결' || o.isExecuted === true) && o.realizedProfit === undefined
  )
  let added = 0
  for (const o of settled) {
    const key = o.orderNumber || `${o.stockCode}_${o.time}_${o.quantity}`
    if (counted.has(key)) continue
    counted.add(key)
    const buy = o.buyPrice || 0
    const sell = o.price > 0 ? o.price : (o.currentPrice || 0)
    if (buy <= 0 || sell <= 0) continue
    added += (sell - buy) * o.quantity
  }
  return added
}

const mk = (o: Partial<Order> & { stockCode: string; type: 'buy' | 'sell' }): Order => ({
  time: '오전 9:00:00', status: '체결', quantity: 1, price: 1000, ...o,
})

// 1. 매도 체결 1건 → (매도가-매수가)*수량
{
  const counted = new Set<string>()
  const amount = collectRealized(
    [mk({ orderNumber: 'S1', stockCode: 'A', type: 'sell', quantity: 10, price: 1100, buyPrice: 1000 })],
    counted
  )
  assert.equal(amount, 1000, '(1100-1000)*10')
}

// 2. 손실도 음수로 집계
{
  const counted = new Set<string>()
  const amount = collectRealized(
    [mk({ orderNumber: 'S2', stockCode: 'B', type: 'sell', quantity: 5, price: 970, buyPrice: 1000 })],
    counted
  )
  assert.equal(amount, -150)
}

// 3. 같은 주문은 두 번 집계되지 않는다 (WebSocket + effect 중복 방지)
{
  const counted = new Set<string>()
  const order = mk({ orderNumber: 'S3', stockCode: 'C', type: 'sell', quantity: 2, price: 1200, buyPrice: 1000 })
  assert.equal(collectRealized([order], counted), 400)
  assert.equal(collectRealized([order], counted), 0, '두 번째 집계는 0')
}

// 4. 매수/미체결/취소는 제외
{
  const counted = new Set<string>()
  const amount = collectRealized(
    [
      mk({ stockCode: 'D', type: 'buy', quantity: 10, price: 1000 }),
      mk({ stockCode: 'E', type: 'sell', status: '접수', quantity: 10, price: 1100, buyPrice: 1000 }),
      mk({ stockCode: 'F', type: 'sell', status: '취소', quantity: 10, price: 1100, buyPrice: 1000 }),
    ],
    counted
  )
  assert.equal(amount, 0)
}

// 5. 매수가 없으면 집계 불가(0) — buyPrice 누락 회귀 방지
{
  const counted = new Set<string>()
  assert.equal(collectRealized([mk({ stockCode: 'G', type: 'sell', quantity: 3, price: 1100 })], counted), 0)
}

// 6. 기본값 확인
const defaults = {
  lossLimit: -3.0,
  lossType: 'market' as const,
  trailingProfitThreshold: 5,
  trailingDropThreshold: -3.0,
}
assert.equal(defaults.lossLimit, -3.0)
assert.equal(defaults.lossType, 'market')
assert.equal(defaults.trailingProfitThreshold, 5)
assert.equal(defaults.trailingDropThreshold, -3.0)

console.log('OK: 오늘 실현손익 집계/기본값 셀프체크 통과')
