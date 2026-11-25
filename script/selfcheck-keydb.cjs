/**
 * 자체 점검: SQLite 키 저장소가 다중 프로세스에서 공유되는지 확인
 * 실행: node script/selfcheck-keydb.cjs
 *
 * 이전 JSON 저장소는 프로세스마다 파일 사본을 메모리에 들고 있어
 * 한 프로세스가 발급한 키가 다른 프로세스에서 보이지 않았다.
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const dbPath = path.join(process.cwd(), 'data', 'license-keys.db')
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? ': ' + detail : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const dbA = new DatabaseSync(dbPath)
const dbB = new DatabaseSync(dbPath)
for (const db of [dbA, dbB]) {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
}

const tag = `SELFCHECK_${Date.now()}`
const now = new Date()
const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000)

// 1. A가 삽입 → B가 조회
dbA
  .prepare(
    `INSERT INTO license_keys
     (key, issued_at, expires_at, valid_days, issued_by, description, is_active, used_count, last_used_at)
     VALUES (?, ?, ?, 1, ?, ?, 1, 0, NULL)`
  )
  .run(tag, now.toISOString(), expires.toISOString(), 'selfcheck', 'multi-process test')

const seenByB = dbB.prepare('SELECT COUNT(*) AS n FROM license_keys WHERE key = ?').get(tag)
check('프로세스 B가 A의 삽입을 즉시 조회', Number(seenByB.n) === 1, `count=${seenByB.n}`)

// 2. B가 갱신 → A가 조회
dbB.prepare('UPDATE license_keys SET used_count = used_count + 1 WHERE key = ?').run(tag)
const seenByA = dbA.prepare('SELECT used_count FROM license_keys WHERE key = ?').get(tag)
check('프로세스 A가 B의 갱신을 즉시 조회', Number(seenByA.used_count) === 1, `used_count=${seenByA.used_count}`)

// 3. A가 삭제 → B 목록에서 사라짐
dbA.prepare('DELETE FROM license_keys WHERE key = ?').run(tag)
const goneForB = dbB.prepare('SELECT COUNT(*) AS n FROM license_keys WHERE key = ?').get(tag)
check('프로세스 B에서도 삭제 반영', Number(goneForB.n) === 0, `count=${goneForB.n}`)

// 4. WAL 모드인지 (동시 읽기/쓰기 허용)
const journal = dbA.prepare('PRAGMA journal_mode').get()
check('WAL 모드 활성', String(journal.journal_mode).toLowerCase() === 'wal', String(journal.journal_mode))

dbA.close()
dbB.close()

if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n모든 점검 통과')
