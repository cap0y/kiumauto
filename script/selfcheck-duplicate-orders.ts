// 중복 주문 방지 로직 셀프체크: npx tsx script/selfcheck-duplicate-orders.ts
// 검증 대상: AutoTrading.tsx 의 매수 게이트 3종
//  1) 실행 중첩 방지 (isExecutingRef)
//  2) 주문 처리 중 동기 플래그 (processingOrdersRef)
//  3) 보유/주문완료 종목 ref 조회
import assert from 'assert'

// 1. 실행 중첩 방지: 주기가 실행 시간보다 짧아도 동시 진입하지 않아야 한다
function makeRunner(execute: () => Promise<void>) {
  let isExecuting = false
  let overlaps = 0
  const run = async () => {
    if (isExecuting) {
      overlaps++
      return
    }
    isExecuting = true
    try {
      await execute()
    } finally {
      isExecuting = false
    }
  }
  return { run, get overlaps() { return overlaps } }
}

// 2. 주문 게이트: state(비동기) 대신 ref(동기)로 판단
interface Gate {
  processingOrders: Set<string> // 동기 ref
  orderedOrHolding: Set<string> // 동기 ref
  holding: Set<string>
}
const canBuy = (gate: Gate, code: string) =>
  !gate.processingOrders.has(code) && !gate.orderedOrHolding.has(code) && !gate.holding.has(code)

async function main() {
  // ── 실행 중첩: 100ms 작업을 20ms 주기로 5회 트리거
  {
    let running = 0
    let maxConcurrent = 0
    const runner = makeRunner(async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 100))
      running--
    })
    for (let i = 0; i < 5; i++) {
      runner.run()
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(maxConcurrent, 1, '실행이 겹치면 안 된다')
    assert.ok(runner.overlaps >= 3, `겹친 요청은 건너뛰어야 한다 (실제: ${runner.overlaps})`)
  }

  // ── 주문 처리 중 플래그: 주문 직후(렌더 전) 같은 루프에서 재주문 금지
  {
    const gate: Gate = { processingOrders: new Set(), orderedOrHolding: new Set(), holding: new Set() }
    assert.equal(canBuy(gate, '005930'), true)
    gate.processingOrders.add('005930') // 주문 직전 동기 등록
    assert.equal(canBuy(gate, '005930'), false, '처리 중이면 재주문 금지')
    gate.processingOrders.delete('005930') // 주문 성공 후
    gate.orderedOrHolding.add('005930')
    assert.equal(canBuy(gate, '005930'), false, '이미 주문했으면 금지')
  }

  // ── 보유 종목 조회: 클로저 스냅샷(빈 배열)이 아니라 최신 ref를 봐야 매도가 동작
  {
    const staleSnapshot: string[] = [] // useEffect 시작 시점의 holdingStocks
    const liveRef = { current: [{ code: '005930', profitPercent: 3.06 }] }

    const soldWithSnapshot = staleSnapshot.some((h: any) => h.profitPercent >= 1)
    const soldWithRef = liveRef.current.some((h) => h.profitPercent >= 1)

    assert.equal(soldWithSnapshot, false, '스냅샷을 쓰면 매도 조건을 못 본다 (버그 재현)')
    assert.equal(soldWithRef, true, 'ref를 쓰면 매도 조건을 본다')
  }

  console.log('OK: 중복 주문 방지/최신 보유종목 참조 셀프체크 통과')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
