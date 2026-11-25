// 주문 내역 병합 셀프체크: npx tsx script/selfcheck-order-merge.ts
import assert from 'assert'

interface Order {
  id: number
  stockCode: string
  stockName: string
  type: 'buy' | 'sell' | 'cancel'
  status: string
  quantity: number
  price: number
  time: string
}

// '오전 9:15:15' 형태의 시각을 초 단위로 변환 (정렬/최신 비교용)
const parseClockSeconds = (time: string): number => {
  const text = String(time || '')
  const m = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return NaN
  let hour = parseInt(m[1], 10)
  const minute = parseInt(m[2], 10)
  const second = m[3] ? parseInt(m[3], 10) : 0
  if (text.includes('오후') && hour < 12) hour += 12
  if (text.includes('오전') && hour === 12) hour = 0
  return hour * 3600 + minute * 60 + second
}

/** AutoTrading.tsx 의 buildDisplayOrders 와 동일 규칙 */
function buildDisplayOrders(logs: Order[]) {
  const filtered = logs.filter(
    (o) => o.type !== 'cancel' && o.status !== '취소' && o.status !== '부분체결'
  )
  const groups = new Map<string, Order & { count: number; quantity: number; latestTime: string }>()
  for (const o of filtered) {
    const key = `${o.stockCode}_${o.type}`
    const cur = groups.get(key)
    if (!cur) {
      groups.set(key, { ...o, count: 1, quantity: o.quantity, latestTime: o.time })
      continue
    }
    const prevSec = parseClockSeconds(cur.latestTime)
    const nextSec = parseClockSeconds(o.time)
    const isNewer = Number.isFinite(nextSec) && (!Number.isFinite(prevSec) || nextSec >= prevSec)
    groups.set(key, {
      ...(isNewer ? o : cur),
      count: cur.count + 1,
      quantity: cur.quantity + o.quantity,
      latestTime: isNewer ? o.time : cur.latestTime,
    })
  }
  return Array.from(groups.values()).sort(
    (a, b) => parseClockSeconds(b.latestTime) - parseClockSeconds(a.latestTime)
  )
}

const mk = (o: Partial<Order> & { id: number; stockCode: string; type: 'buy' | 'sell' }): Order => ({
  stockName: 'X', status: '체결', quantity: 1, price: 1000, time: '오전 9:00:00', ...o,
})

// 1. 같은 종목 매도 3건 → 1행, 수량 합산
{
  const rows = buildDisplayOrders([
    mk({ id: 1, stockCode: '004540', type: 'sell', quantity: 2, time: '오전 9:15:15' }),
    mk({ id: 2, stockCode: '004540', type: 'sell', quantity: 3, time: '오전 9:16:20' }),
    mk({ id: 3, stockCode: '004540', type: 'sell', quantity: 5, time: '오전 9:17:30' }),
  ])
  assert.equal(rows.length, 1, '중복 종목은 1행으로 병합')
  assert.equal(rows[0].quantity, 10, '수량은 합산')
  assert.equal(rows[0].count, 3)
  assert.equal(rows[0].latestTime, '오전 9:17:30', '가장 최근 시간 유지')
}

// 2. 같은 종목이라도 매수/매도는 별개 행
{
  const rows = buildDisplayOrders([
    mk({ id: 1, stockCode: '005930', type: 'buy' }),
    mk({ id: 2, stockCode: '005930', type: 'sell' }),
  ])
  assert.equal(rows.length, 2, '매수/매도는 구분')
}

// 3. 취소·부분체결 제외
{
  const rows = buildDisplayOrders([
    mk({ id: 1, stockCode: 'A', type: 'buy' }),
    mk({ id: 2, stockCode: 'B', type: 'buy', status: '취소' }),
    mk({ id: 3, stockCode: 'C', type: 'buy', status: '부분체결' }),
    mk({ id: 4, stockCode: 'D', type: 'cancel' }),
  ])
  assert.deepEqual(rows.map((r) => r.stockCode), ['A'])
}

// 4. 서로 다른 종목은 각각 유지
{
  const rows = buildDisplayOrders([
    mk({ id: 1, stockCode: 'A', type: 'buy' }),
    mk({ id: 2, stockCode: 'B', type: 'buy' }),
  ])
  assert.equal(rows.length, 2)
}

console.log('OK: 주문 내역 병합 셀프체크 통과')
