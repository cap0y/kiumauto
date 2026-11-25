// 차트 당일 필터/실시간 반영 셀프체크: npx tsx script/selfcheck-chart-today.ts
// 증상 1: 1분봉인데 전날·전전날 봉까지 그려져 봉이 뭉개짐 (키움 1분봉은 900건=3일치)
// 증상 2: 차트가 실시간으로 갱신되지 않음 (선택 시점 스냅샷만 사용)
import assert from 'assert'

interface Candle { time: string; open: number; high: number; low: number; close: number; volume: number }

/** AutoTrading.tsx 의 당일 필터 + 정렬 규칙 */
function buildChartData(raw: any[], todayKey: string, period: string): Candle[] {
  const all = raw
    .map((c) => ({
      time: String(c.일자 ?? c.time ?? ''),
      open: Number(c.시가 ?? c.open ?? 0),
      high: Number(c.고가 ?? c.high ?? 0),
      low: Number(c.저가 ?? c.low ?? 0),
      close: Number(c.종가 ?? c.close ?? 0),
      volume: Number(c.거래량 ?? c.volume ?? 0),
    }))
    .filter((c) => c.time && !(c.open === 0 && c.high === 0 && c.low === 0 && c.close === 0))

  const today = period === 'day' ? all : all.filter((c) => c.time.startsWith(todayKey))
  return (today.length > 0 ? today : all).slice().sort((a, b) => a.time.localeCompare(b.time))
}

/** 현재 분 봉이 없으면 실시간 가격으로 새 봉 생성 */
function applyLiveTick(data: Candle[], livePrice: number, nowKey: string, todayKey: string): Candle[] {
  if (data.length === 0 || !(livePrice > 0)) return data
  const last = data[data.length - 1]
  if (String(last.time).slice(0, 8) === todayKey) {
    last.close = livePrice
    if (livePrice > last.high) last.high = livePrice
    if (livePrice < last.low) last.low = livePrice
  }
  if (data.some((c) => c.time === nowKey)) return data
  if (String(last.time).slice(0, 8) !== todayKey) return data
  data.push({ time: nowKey, open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0 })
  return data
}

const todayKey = '20261125'

// 1. 3일치 데이터 → 당일만 남는다
{
  const raw = [
    { 일자: '20261125100200', 시가: 7340, 고가: 7450, 저가: 7300, 종가: 7320, 거래량: 40125 },
    { 일자: '20261125100100', 시가: 7120, 고가: 7240, 저가: 7120, 종가: 7180, 거래량: 33496 },
    { 일자: '20261124153000', 시가: 6900, 고가: 6950, 저가: 6880, 종가: 6900, 거래량: 1000 },
    { 일자: '20261123143400', 시가: 6330, 고가: 6350, 저가: 6300, 종가: 6330, 거래량: 2117 },
  ]
  const out = buildChartData(raw, todayKey, 'min')
  assert.equal(out.length, 2, '전날/전전날 봉은 제외')
  assert.deepEqual(out.map((c) => c.time), ['20261125100100', '20261125100200'], '과거→최신 순 정렬')
}

// 2. 당일 데이터가 없으면(장 시작 전) 원본 유지 → 빈 차트 방지
{
  const raw = [{ 일자: '20261124153000', 시가: 6900, 고가: 6950, 저가: 6880, 종가: 6900, 거래량: 1000 }]
  const out = buildChartData(raw, todayKey, 'min')
  assert.equal(out.length, 1, '당일 봉이 없으면 마지막 거래일 표시')
}

// 3. 일봉은 날짜 필터를 하지 않는다
{
  const raw = [
    { 일자: '20261125', 시가: 7000, 고가: 7450, 저가: 6990, 종가: 7320, 거래량: 1 },
    { 일자: '20261124', 시가: 6900, 고가: 6950, 저가: 6880, 종가: 6900, 거래량: 1 },
  ]
  const out = buildChartData(raw, todayKey, 'day')
  assert.equal(out.length, 2, '일봉은 여러 날짜 유지')
}

// 4. 실시간 틱 → 마지막 봉의 종가/고가/저가 갱신
{
  const data = buildChartData(
    [{ 일자: '20261125100200', 시가: 7340, 고가: 7350, 저가: 7300, 종가: 7320, 거래량: 100 }],
    todayKey, 'min'
  )
  applyLiveTick(data, 7400, '20261125100300', todayKey)
  assert.equal(data[data.length - 1].close, 7400, '종가가 실시간 가격으로 갱신')
  assert.equal(data[data.length - 1].high, 7400, '고가 갱신')
  assert.equal(data.length, 2, '새 분봉 추가')
  assert.equal(data[1].time, '20261125100300')
}

// 5. 이미 현재 분봉이 있으면 중복 생성하지 않는다
{
  const data = buildChartData(
    [{ 일자: '20261125100300', 시가: 7340, 고가: 7350, 저가: 7300, 종가: 7320, 거래량: 100 }],
    todayKey, 'min'
  )
  applyLiveTick(data, 7390, '20261125100300', todayKey)
  assert.equal(data.length, 1, '같은 분봉 중복 추가 없음')
  assert.equal(data[0].close, 7390)
}

// 6. 하락 시 저가 갱신
{
  const data = buildChartData(
    [{ 일자: '20261125100200', 시가: 7340, 고가: 7350, 저가: 7300, 종가: 7320, 거래량: 100 }],
    todayKey, 'min'
  )
  applyLiveTick(data, 7200, '20261125100200', todayKey)
  assert.equal(data[0].low, 7200)
}

console.log('OK: 차트 당일 필터/실시간 반영 셀프체크 통과')
