/**
 * 세션별 사용자 상태 저장 (오늘 실현손익, 체결 주문 내역 등)
 *
 * 이전에는 localStorage에만 저장해서 브라우저/도메인마다 값이 달랐다.
 * (로컬에서 매도한 실적이 Railway 도메인에서는 0으로 보였다)
 * 이제 라이선스 키 단위로 서버에 저장해 어느 기기에서 접속해도 같은 값이 보인다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

interface StateStore {
  init(): Promise<void>
  get(userKey: string, name: string): Promise<any | null>
  set(userKey: string, name: string, value: any): Promise<void>
  remove(userKey: string): Promise<void>
  describe(): string
}

// ───────────────────────────── PostgreSQL ─────────────────────────────

class PostgresStateStore implements StateStore {
  private pool: any = null
  private connectionString: string

  constructor(connectionString: string) {
    this.connectionString = connectionString
  }

  async init(): Promise<void> {
    const { Pool } = nodeRequire('pg')
    this.pool = new Pool({
      connectionString: this.connectionString,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
    this.pool.on('error', (error: any) => {
      console.error('[상태 저장소] PostgreSQL 커넥션 오류:', error.message)
    })
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_state (
        user_key   TEXT NOT NULL,
        name       TEXT NOT NULL,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_key, name)
      )
    `)
  }

  async get(userKey: string, name: string): Promise<any | null> {
    const result = await this.pool.query(
      'SELECT value FROM user_state WHERE user_key = $1 AND name = $2',
      [userKey, name]
    )
    return result.rows.length > 0 ? result.rows[0].value : null
  }

  async set(userKey: string, name: string, value: any): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_state (user_key, name, value, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_key, name)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [userKey, name, JSON.stringify(value)]
    )
  }

  async remove(userKey: string): Promise<void> {
    await this.pool.query('DELETE FROM user_state WHERE user_key = $1', [userKey])
  }

  describe(): string {
    return 'PostgreSQL user_state'
  }
}

// ───────────────────────────── SQLite (폴백) ─────────────────────────────

class SqliteStateStore implements StateStore {
  private db: any = null
  private dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const { DatabaseSync } = nodeRequire('node:sqlite')
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_state (
        user_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_key, name)
      )
    `)
  }

  async get(userKey: string, name: string): Promise<any | null> {
    const row = this.db
      .prepare('SELECT value FROM user_state WHERE user_key = ? AND name = ?')
      .get(userKey, name)
    if (!row) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }

  async set(userKey: string, name: string, value: any): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_state (user_key, name, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_key, name)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(userKey, name, JSON.stringify(value), new Date().toISOString())
  }

  async remove(userKey: string): Promise<void> {
    this.db.prepare('DELETE FROM user_state WHERE user_key = ?').run(userKey)
  }

  describe(): string {
    return `SQLite user_state (${this.dbPath})`
  }
}

// ───────────────────────────── 서비스 ─────────────────────────────

class UserStateService {
  private static instance: UserStateService
  private store: StateStore | null = null
  private initPromise: Promise<void> | null = null
  private ready = false

  private constructor() {}

  static getInstance(): UserStateService {
    if (!UserStateService.instance) {
      UserStateService.instance = new UserStateService()
    }
    return UserStateService.instance
  }

  async initialize(): Promise<void> {
    if (this.ready) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      const databaseUrl = String(process.env.DATABASE_URL || '').trim()
      const isProduction = process.env.NODE_ENV === 'production'

      // 운영 환경에서 DATABASE_URL이 없으면 경고를 크게 남긴다.
      // (Railway에 환경변수를 등록하지 않으면 매 배포마다 빈 SQLite로 시작해
      //  사용자 상태가 사라진다 — "실현손익이 0원"의 실제 원인이었다)
      if (isProduction && !databaseUrl) {
        console.error(
          '[상태 저장소] ⚠️ 운영 환경인데 DATABASE_URL이 없습니다. ' +
          'Railway Variables에 DATABASE_URL을 등록하지 않으면 ' +
          '배포할 때마다 사용자 데이터(실현손익 등)가 초기화됩니다.'
        )
      }

      if (databaseUrl) {
        const store = new PostgresStateStore(databaseUrl)
        try {
          await store.init()
          this.store = store
        } catch (error: any) {
          console.error('[상태 저장소] PostgreSQL 연결 실패:', error.message)
          if (isProduction) {
            // 운영에서는 로컬 파일로 떨어져도 데이터가 유지되지 않으므로 명시적으로 알린다
            console.error(
              '[상태 저장소] ⚠️ 운영 환경에서 DB 연결에 실패했습니다. ' +
              'DATABASE_URL 값을 확인하세요. (SQLite로 임시 동작하지만 데이터는 유지되지 않습니다)'
            )
          }
        }
      }
      if (!this.store) {
        const store = new SqliteStateStore(path.join(process.cwd(), 'data', 'license-keys.db'))
        await store.init()
        this.store = store
      }
      console.log(`[상태 저장소] ${this.store.describe()} 사용`)
      this.ready = true
    })()

    return this.initPromise
  }

  private requireStore(): StateStore {
    if (!this.store) throw new Error('상태 저장소가 초기화되지 않았습니다')
    return this.store
  }

  async get(userKey: string, name: string): Promise<any | null> {
    await this.initialize()
    return this.requireStore().get(userKey, name)
  }

  async set(userKey: string, name: string, value: any): Promise<void> {
    await this.initialize()
    return this.requireStore().set(userKey, name, value)
  }

  async remove(userKey: string): Promise<void> {
    await this.initialize()
    return this.requireStore().remove(userKey)
  }

  /** 사용 중인 저장소 설명 (진단용) */
  describeStore(): string {
    return this.store ? this.store.describe() : '초기화 전'
  }
}

export default UserStateService.getInstance()
