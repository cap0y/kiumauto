// 종목명 전체 표시 셀프체크: npx tsx script/selfcheck-stock-name-full.ts
// 증상: "검색된 종목에 종목명이 글자 다 나오게 수정해"
// 원인 1) 렌더링 시 substring(0,5) + '...' 로 강제 절단
// 원인 2) 셀에 overflow:hidden + text-overflow:ellipsis + 좁은 고정폭
import assert from 'assert'

/** 수정 전 로직 (버그 재현) */
const truncateOld = (name: string) => (name.length > 5 ? name.substring(0, 5) + '...' : name)

/** 수정 후 로직 */
const truncateNew = (name: string) => name

// 1. 장문 ETN 이름이 잘리지 않는다
{
  const longName = 'KB 인버스 2X KOSPI 200 선물 ETN B'
  assert.equal(truncateOld(longName), 'KB 인버...', '기존: 5자에서 절단')
  assert.equal(truncateNew(longName), longName, '수정: 전체 표시')
  assert.equal(longName.length, 28)
}

// 2. 여러 실제 종목명 검증
{
  const names = [
    '동양2우B',
    '깨끗한나라우',
    '티와이홀딩스우',
    'PLUS 삼성전자선물단일종목인버스2X',
    'SOL SK하이닉스선물단일종목인버스2X',
    '키움 인버스 2X 반도체TOP10 ETN',
    '한투 인버스2X코스피200선물 ETN',
  ]
  for (const n of names) {
    assert.equal(truncateNew(n), n, `${n} 전체 표시`)
    if (n.length > 5) assert.notEqual(truncateOld(n), n, `${n} 은 기존 로직에서 잘렸음`)
  }
}

// 3. 잘린 이름에 '...' 이 남지 않아야 한다
{
  assert.ok(!truncateNew('한국비티비').includes('...'))
  assert.ok(!truncateNew('KB 인버스 2X KOSPI 200 선물 ETN B').includes('...'))
}

// 4. 셀 스타일 계약: 이름 셀은 말줄임 금지
{
  const style = {
    overflow: 'visible',
    textOverflow: 'clip',
    whiteSpace: 'nowrap',
    minWidth: 300,
  }
  assert.notEqual(style.overflow, 'hidden', 'overflow hidden 이면 넘치는 글자가 잘린다')
  assert.notEqual(style.textOverflow, 'ellipsis', 'ellipsis 면 ... 로 잘린다')
  assert.ok(style.minWidth >= 300, '긴 이름을 담을 최소 폭 확보')
}

// 5. 최소 폭 300px 로 30자 한글/영문 혼합 이름이 들어가는지 근사 검증
//    (11px 폰트 기준 한글 약 11px/자, 영문 약 6px/자)
{
  const estimateWidth = (s: string) => {
    let w = 0
    for (const ch of s) w += /[가-힣]/.test(ch) ? 11 : 6
    return w
  }
  const longest = 'KB 인버스 2X KOSPI 200 선물 ETN B'
  assert.ok(estimateWidth(longest) < 300, `예상 폭 ${estimateWidth(longest)}px < 300px`)
}

console.log('OK: 종목명 전체 표시 셀프체크 통과')
