/**
 * git 히스토리에 노출된 라이선스 키를 비활성화한다.
 * 실행: node script/revoke-leaked-keys.cjs
 *
 * 저장소가 public이면 과거 커밋에서 키를 그대로 읽을 수 있으므로
 * 노출된 키는 즉시 무효화해야 한다. (삭제보다 비활성화가 감사 추적에 낫다)
 */
const fs = require('node:fs')
const path = require('node:path')

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnv()

/** git 히스토리에서 확인된 노출 키 (script/revoke-leaked-keys.cjs 기준) */
const LEAKED_KEYS = [
  'CCDECA5F39810A68B5BEC6005FC159DB',
  'B2FA331040937CA10DE64784112B68AB',
  '0E411E94F5E1073BF0D7133DB32F7B94',
  '698E106C2DC8B04904F4809EA21EFBFE',
  'EB842534DCEC493A92491A6A150C81BD',
]

const { Client } = require('pg')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL이 없습니다 (.env 확인)')
    process.exit(1)
  }

  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  })
  await client.connect()

  const found = []
  const missing = []

  for (const key of LEAKED_KEYS) {
    const result = await client.query(
      'SELECT key, issued_by, is_active, expires_at FROM license_keys WHERE key = $1',
      [key]
    )
    if (result.rows.length === 0) {
      missing.push(key)
      continue
    }
    const row = result.rows[0]
    if (row.is_active) {
      await client.query('UPDATE license_keys SET is_active = FALSE WHERE key = $1', [key])
      found.push({ key, was: 'active → 비활성화' })
    } else {
      found.push({ key, was: '이미 비활성' })
    }
  }

  console.log('=== 노출 키 처리 결과 ===')
  found.forEach((f) => console.log(`  ${f.key.slice(0, 8)}... : ${f.was}`))
  if (missing.length > 0) {
    console.log('=== DB에 없는 키 (이미 삭제됨) ===')
    missing.forEach((k) => console.log(`  ${k.slice(0, 8)}...`))
  }

  // 남은 활성 키 확인
  const remaining = await client.query(
    'SELECT count(*)::int AS n FROM license_keys WHERE is_active = TRUE'
  )
  console.log(`\n활성 키: ${remaining.rows[0].n}개`)

  const stillExposed = await client.query(
    `SELECT count(*)::int AS n FROM license_keys
     WHERE is_active = TRUE AND key = ANY($1::text[])`,
    [LEAKED_KEYS]
  )
  console.log(`노출 키 중 활성: ${stillExposed.rows[0].n}개 (0이어야 정상)`)

  await client.end()

  if (stillExposed.rows[0].n > 0) {
    console.error('\n실패: 노출 키가 아직 활성입니다')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('처리 실패:', error.message)
  process.exit(1)
})
