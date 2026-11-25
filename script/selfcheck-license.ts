import keyService from '../server/services/keyService'

/**
 * 라이선스 키 발급/검증 점검
 * 주의: keyService는 data/license-keys.json에 실제로 기록한다.
 *       점검 후 반드시 삭제해 운영 데이터를 오염시키지 않는다.
 */
const TEST_DESC = '__SELFCHECK_KEY__'
let issuedKey: string | null = null

const failures: string[] = []
const check = (name: string, actual: any, expected: any) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${name}: 기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`)
  }
}

// 이전 실행 잔여물 제거 (설명으로 찾아서 지운다 — 키 값은 매번 랜덤)
const cleanup = () => {
  keyService.getAllKeys()
    .filter((k) => k.description === TEST_DESC)
    .forEach((k) => keyService.deleteKey(k.key))
  if (issuedKey) keyService.deleteKey(issuedKey)
}

cleanup()

try {
  // 1. 키는 서버가 생성한다 (사용자가 값을 지정할 수 없다)
  const issued = keyService.issueKey(60, 'admin', TEST_DESC)
  issuedKey = issued.key
  check('키 자동 생성 (32자리)', issued.key.length, 32)
  check('발급 키 검증 성공', keyService.validateKey(issued.key).valid, true)

  // 2. 앞뒤 공백이 있어도 검증 성공 (사용자 입력 여유)
  check('공백 포함 검증', keyService.validateKey(`  ${issued.key}  `).valid, true)

  // 3. 없는 키는 실패
  check('없는 키 검증 실패', keyService.validateKey('a@@@12345').valid, false)

  // 4. 비활성화하면 실패
  keyService.toggleKey(issued.key, false)
  check('비활성 키 검증 실패', keyService.validateKey(issued.key).valid, false)
} finally {
  cleanup()
}

check('점검 후 데이터 정리', keyService.getAllKeys().some((k) => k.description === TEST_DESC), false)

if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건`)
  failures.forEach((f) => console.error(' -', f))
  process.exit(1)
}
console.log('라이선스 키 발급/검증 점검 통과')

