/**
 * 테스트로 발급한 라이선스 키를 정리한다.
 * 실행: node script/cleanup-test-keys.cjs
 *
 * 실제 사용자 키는 건드리지 않는다 (발급자 이름으로만 판별).
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

/** 개발 중 테스트로 키를 발급할 때 쓴 issuedBy 값들 */
const TEST_ISSUERS = [
  'pg-test',
  'cookie-test',
  'db-test',
  'ghost1',
  'ghost2',
  'dupA',
  'dupB',
  'test',
  'test1',
  'test2',
  'procA',
  'selfcheck',
  'atomic-test',
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

  const before = await client.query('SELECT count(*)::int AS n FROM license_keys')
  const targets = await client.query(
    'SELECT key, issued_by FROM license_keys WHERE issued_by = ANY($1::text[])',
    [TEST_ISSUERS]
  )

  console.log(`정리 전: ${before.rows[0].n}개`)
  console.log(`삭제 대상(테스트 발급): ${targets.rows.length}개`)
  targets.rows.slice(0, 10).forEach((r) => console.log(`  ${r.key.slice(0, 8)}... ${r.issued_by}`))
  if (targets.rows.length > 10) console.log(`  ... 외 ${targets.rows.length - 10}개`)

  const deleted = await client.query(
    'DELETE FROM license_keys WHERE issued_by = ANY($1::text[])',
    [TEST_ISSUERS]
  )

  const after = await client.query('SELECT count(*)::int AS n FROM license_keys')
  const active = await client.query(
    'SELECT count(*)::int AS n FROM license_keys WHERE is_active = TRUE'
  )

  // 남은 키의 발급자 분포 (실사용 확인용)
  const byIssuer = await client.query(
    `SELECT issued_by, count(*)::int AS n FROM license_keys
     GROUP BY issued_by ORDER BY n DESC`
  )

  console.log(`\n삭제됨: ${deleted.rowCount}개`)
  console.log(`정리 후: ${after.rows[0].n}개 (활성 ${active.rows[0].n}개)`)
  console.log('발급자별:')
  byIssuer.rows.forEach((r) => console.log(`  ${r.issued_by}: ${r.n}개`))

  await client.end()
}

main().catch((error) => {
  console.error('정리 실패:', error.message)
  process.exit(1)
})
