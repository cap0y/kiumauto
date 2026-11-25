// 실시간 등록(누적) 로직 셀프체크: npx tsx script/selfcheck-realtime.ts
// 검증 대상: kiwoomService.registerRealTimeStocks 의 등록 계획
// (서버/네트워크 없이 순수 계산만 확인한다)
import assert from 'assert'

interface RegCall { items: string[]; types: string[]; grpNo: string; refresh: string }

/** kiwoomService.registerRealTimeStocks 와 동일한 계획 계산 */
function planRegistrations(registered: Set<string>, codes: string[], MAX_TOTAL = 200, MAX_ITEMS_PER_GROUP = 100) {
  codes.filter(Boolean).forEach((code) => registered.add(code))
  const all = Array.from(registered)
  while (all.length > MAX_TOTAL) registered.delete(all.shift()!)

  const calls: RegCall[] = []
  for (let i = 0; i < all.length; i += MAX_ITEMS_PER_GROUP) {
    const groupCodes = all.slice(i, i + MAX_ITEMS_PER_GROUP)
    calls.push({
      items: groupCodes,
      types: ['0B'],
      grpNo: String(Math.floor(i / MAX_ITEMS_PER_GROUP) + 1),
      refresh: i === 0 ? '0' : '1',
    })
  }
  return { calls, all }
}

// 1. 1차 등록: 초기화(refresh='0') 한 번
{
  const reg = new Set<string>()
  const { calls } = planRegistrations(reg, ['005930', '000660'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].items, ['005930', '000660'])
  assert.equal(calls[0].refresh, '0') // 첫 등록은 초기화
}

// 2. 핵심 버그 재현/방지: 2차 등록에도 '이전 종목이 포함'돼야 한다
//    (이전 코드는 신규 종목만 보내고 refresh='0'을 써서 기존 시세가 끊겼다)
{
  const reg = new Set<string>()
  planRegistrations(reg, ['005930', '000660'])
  const { calls } = planRegistrations(reg, ['035720'])
  const sent = calls.flatMap(c => c.items)
  assert.deepEqual(sent, ['005930', '000660', '035720'])
}

// 3. 100종목 초과 시 그룹 분할 + 첫 그룹만 '0'
{
  const reg = new Set<string>()
  const codes = Array.from({ length: 150 }, (_, i) => String(i).padStart(6, '0'))
  const { calls } = planRegistrations(reg, codes)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].items.length, 100)
  assert.equal(calls[1].items.length, 50)
  assert.deepEqual(calls.map(c => c.refresh), ['0', '1'])
  assert.deepEqual(calls.map(c => c.grpNo), ['1', '2'])
}

// 4. 200종목 한도: 오래된 종목부터 제거
{
  const reg = new Set<string>()
  const first = Array.from({ length: 200 }, (_, i) => 'A' + String(i).padStart(5, '0'))
  planRegistrations(reg, first)
  const { all } = planRegistrations(reg, ['NEW001', 'NEW002'])
  assert.equal(all.length, 200)
  assert.equal(all.includes('A00000'), false) // 가장 오래된 것 제거
  assert.equal(all.includes('NEW002'), true)
}

// 5. 중복 코드는 한 번만 등록
{
  const reg = new Set<string>()
  const { calls } = planRegistrations(reg, ['005930', '005930', ''])
  assert.deepEqual(calls[0].items, ['005930'])
}

console.log('OK: 실시간 등록(누적/분할/한도) 로직 셀프체크 통과')
