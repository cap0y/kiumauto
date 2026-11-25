/**
 * DB 연결 점검 (Neon PostgreSQL)
 * 실행: node script/selfcheck-db.cjs
 *
 * .env의 DATABASE_URL로 접속해 테이블 상태를 확인한다.
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
  const version = await client.query('select version()')
  console.log('연결 OK:', String(version.rows[0].version).split(',')[0])

  const tables = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`
  )
  const names = tables.rows.map((r) => r.table_name)
  console.log('public 테이블:', names.length ? names.join(', ') : '없음')

  if (names.includes('license_keys')) {
    const count = await client.query('select count(*)::int as n from license_keys')
    const active = await client.query('select count(*)::int as n from license_keys where is_active = true')
    console.log(`license_keys: 총 ${count.rows[0].n}개, 활성 ${active.rows[0].n}개`)
  }

  await client.end()
}

main().catch((error) => {
  console.error('DB 점검 실패:', error.message)
  process.exit(1)
})
