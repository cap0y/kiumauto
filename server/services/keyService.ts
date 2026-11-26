/**
 * 키 발급 및 관리 서비스 (PostgreSQL 저장)
 *
 * 저장소 이력:
 *   1) data/license-keys.json — 파일 덮어쓰기 (다중 프로세스 공유 불가)
 *   2) data/license-keys.db   — node:sqlite (로컬 다중 프로세스 공유)
 *   3) PostgreSQL (현재)       — 여러 서버 인스턴스에서도 같은 데이터를 본다
 *
 * DATABASE_URL이 없으면 SQLite로 폴백해 로컬 개발이 막히지 않게 한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

export interface LicenseKey {
  key: string // 발급된 키 값
  issuedAt: string // 발급일시 (ISO 8601)
  expiresAt: string // 만료일시 (ISO 8601)
  validDays: number // 유효기간 (일)
  issuedBy: string // 발급자
  description?: string // 설명
  isActive: boolean // 활성화 여부
  usedCount: number // 사용 횟수
  lastUsedAt?: string // 마지막 사용일시
}

interface CheckResult {
  valid: boolean
  licenseKey?: LicenseKey
  message?: string
}

/** 두 저장소가 공통으로 구현해야 하는 동작 */
interface KeyStore {
  init(): Promise<void>
  insert(key: LicenseKey): Promise<void>
  findByKey(key: string): Promise<LicenseKey | null>
  markUsed(key: string, at: string): Promise<void>
  listAll(): Promise<LicenseKey[]>
  setActive(key: string, isActive: boolean): Promise<boolean>
  remove(key: string): Promise<boolean>
  removeExpired(nowIso: string): Promise<number>
  describe(): string
}

// ───────────────────────────── PostgreSQL ─────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS license_keys (
    key         TEXT PRIMARY KEY,
    issued_at   TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    valid_days  INTEGER NOT NULL,
    issued_by   TEXT NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    used_count  INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ
  )
`

class PostgresKeyStore implements KeyStore {
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
    // 유휴 커넥션 오류로 프로세스가 죽지 않게 한다
    this.pool.on('error', (error: any) => {
      console.error('[키 저장소] PostgreSQL 커넥션 오류:', error.message)
    })

    await this.pool.query(CREATE_TABLE_SQL)
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS idx_license_expires ON license_keys(expires_at)'
    )
  }

  private toKey(row: any): LicenseKey {
    return {
      key: row.key,
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      validDays: Number(row.valid_days),
      issuedBy: row.issued_by,
      description: row.description ?? undefined,
      isActive: Boolean(row.is_active),
      usedCount: Number(row.used_count),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
    }
  }

  async insert(key: LicenseKey): Promise<void> {
    await this.pool.query(
      `INSERT INTO license_keys
       (key, issued_at, expires_at, valid_days, issued_by, description, is_active, used_count, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 0, NULL)`,
      [key.key, key.issuedAt, key.expiresAt, key.validDays, key.issuedBy, key.description ?? null]
    )
  }

  async findByKey(key: string): Promise<LicenseKey | null> {
    const result = await this.pool.query('SELECT * FROM license_keys WHERE key = $1', [key])
    return result.rows.length > 0 ? this.toKey(result.rows[0]) : null
  }

  async markUsed(key: string, at: string): Promise<void> {
    await this.pool.query(
      'UPDATE license_keys SET used_count = used_count + 1, last_used_at = $1 WHERE key = $2',
      [at, key]
    )
  }

  async listAll(): Promise<LicenseKey[]> {
    const result = await this.pool.query('SELECT * FROM license_keys ORDER BY issued_at DESC')
    return result.rows.map((row: any) => this.toKey(row))
  }

  async setActive(key: string, isActive: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE license_keys SET is_active = $1 WHERE key = $2', [
      isActive,
      key,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async remove(key: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM license_keys WHERE key = $1', [key])
    return (result.rowCount ?? 0) > 0
  }

  async removeExpired(nowIso: string): Promise<number> {
    const result = await this.pool.query('DELETE FROM license_keys WHERE expires_at < $1', [nowIso])
    return result.rowCount ?? 0
  }

  describe(): string {
    const host = (() => {
      try {
        return new URL(this.connectionString).host
      } catch {
        return 'unknown'
      }
    })()
    return `PostgreSQL (${host})`
  }
}

// ───────────────────────────── SQLite (폴백) ─────────────────────────────

class SqliteKeyStore implements KeyStore {
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
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS license_keys (
        key TEXT PRIMARY KEY,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        valid_days INTEGER NOT NULL,
        issued_by TEXT NOT NULL,
        description TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_license_expires ON license_keys(expires_at)')
  }

  private toKey(row: any): LicenseKey {
    return {
      key: row.key,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      validDays: Number(row.valid_days),
      issuedBy: row.issued_by,
      description: row.description ?? undefined,
      isActive: Number(row.is_active) === 1,
      usedCount: Number(row.used_count),
      lastUsedAt: row.last_used_at ?? undefined,
    }
  }

  async insert(key: LicenseKey): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO license_keys
         (key, issued_at, expires_at, valid_days, issued_by, description, is_active, used_count, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL)`
      )
      .run(
        key.key,
        key.issuedAt,
        key.expiresAt,
        key.validDays,
        key.issuedBy,
        key.description ?? null
      )
  }

  async findByKey(key: string): Promise<LicenseKey | null> {
    const row = this.db.prepare('SELECT * FROM license_keys WHERE key = ?').get(key)
    return row ? this.toKey(row) : null
  }

  async markUsed(key: string, at: string): Promise<void> {
    this.db
      .prepare('UPDATE license_keys SET used_count = used_count + 1, last_used_at = ? WHERE key = ?')
      .run(at, key)
  }

  async listAll(): Promise<LicenseKey[]> {
    const rows = this.db.prepare('SELECT * FROM license_keys ORDER BY issued_at DESC').all()
    return rows.map((row: any) => this.toKey(row))
  }

  async setActive(key: string, isActive: boolean): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE license_keys SET is_active = ? WHERE key = ?')
      .run(isActive ? 1 : 0, key)
    return Number(result?.changes) > 0
  }

  async remove(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM license_keys WHERE key = ?').run(key)
    return Number(result?.changes) > 0
  }

  async removeExpired(nowIso: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM license_keys WHERE expires_at < ?').run(nowIso)
    return Number(result?.changes) || 0
  }

  describe(): string {
    return `SQLite (${this.dbPath})`
  }
}

// ───────────────────────────── 서비스 ─────────────────────────────

class KeyService {
  private static instance: KeyService
  private store: KeyStore | null = null
  private initPromise: Promise<void> | null = null
  private ready = false

  private constructor() {}

  public static getInstance(): KeyService {
    if (!KeyService.instance) {
      KeyService.instance = new KeyService()
    }
    return KeyService.instance
  }

  /** 저장소 초기화 (최초 호출 시 1회) */
  public async initialize(): Promise<void> {
    if (this.ready) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      const databaseUrl = String(process.env.DATABASE_URL || '').trim()
      const isProduction = process.env.NODE_ENV === 'production'

      // 운영 환경에서 DATABASE_URL 미설정은 치명적이다.
      // 배포마다 빈 SQLite로 시작해 발급한 라이선스 키가 전부 사라진다.
      if (isProduction && !databaseUrl) {
        console.error(
          '[키 저장소] ⚠️ 운영 환경인데 DATABASE_URL이 없습니다. ' +
          'Railway Variables에 DATABASE_URL을 등록하지 않으면 ' +
          '배포할 때마다 라이선스 키가 초기화됩니다.'
        )
      }

      if (databaseUrl) {
        const store = new PostgresKeyStore(databaseUrl)
        try {
          await store.init()
          this.store = store
          console.log(`[키 저장소] ${store.describe()} 사용`)
        } catch (error: any) {
          console.error('[키 저장소] PostgreSQL 연결 실패:', error.message)
          if (isProduction) {
            console.error(
              '[키 저장소] ⚠️ 운영 환경에서 DB 연결 실패. DATABASE_URL 값을 확인하세요. ' +
              '(SQLite로 임시 동작하지만 재배포 시 키가 사라집니다)'
            )
          }
        }
      }

      if (!this.store) {
        const dbPath = path.join(process.cwd(), 'data', 'license-keys.db')
        const store = new SqliteKeyStore(dbPath)
        await store.init()
        this.store = store
        console.log(`[키 저장소] ${store.describe()} 사용 (DATABASE_URL 없음)`)
      }

      await this.migrateLegacySqlite()
      this.ready = true
    })()

    return this.initPromise
  }

  /**
   * 로컬 SQLite에 남아 있는 키를 PostgreSQL로 한 번 이전한다.
   * (Neon으로 옮기면서 기존 발급 키가 사라지지 않게)
   */
  private async migrateLegacySqlite(): Promise<void> {
    const store = this.requireStore()
    const dbPath = path.join(process.cwd(), 'data', 'license-keys.db')
    if (!(store instanceof PostgresKeyStore)) return

    const existing = await store.listAll().catch(() => [])
    if (existing.length > 0) return
    if (!fs.existsSync(dbPath)) return

    try {
      const legacy = new SqliteKeyStore(dbPath)
      await legacy.init()
      const rows = await legacy.listAll()
      if (rows.length === 0) return

      for (const row of rows) {
        await store.insert(row).catch(() => undefined)
      }
      console.log(`[키 저장소] SQLite → PostgreSQL 이전 시도 (${rows.length}개)`)
    } catch (error: any) {
      console.error('[키 저장소] SQLite 이전 실패:', error.message)
    }
  }

  private requireStore(): KeyStore {
    if (!this.store) throw new Error('키 저장소가 초기화되지 않았습니다 (initialize 미호출)')
    return this.store
  }

  private generateKey(): string {
    return crypto.randomBytes(16).toString('hex').toUpperCase()
  }

  /** 새로운 키 발급 (관리자용) */
  public async issueKey(
    validDays: number,
    issuedBy: string = 'admin',
    description?: string
  ): Promise<LicenseKey> {
    await this.initialize()
    const store = this.requireStore()

    const now = new Date()
    const expiresAt = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000)

    // 중복 시 재시도
    for (let attempt = 0; attempt < 5; attempt++) {
      const licenseKey: LicenseKey = {
        key: this.generateKey(),
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        validDays,
        issuedBy,
        description,
        isActive: true,
        usedCount: 0,
      }
      try {
        await store.insert(licenseKey)
        return licenseKey
      } catch (error: any) {
        // PRIMARY KEY 충돌만 재시도, 그 외는 즉시 실패
        if (!/duplicate key|UNIQUE/i.test(error.message)) throw error
      }
    }
    throw new Error('키 생성 실패: 중복이 반복됩니다')
  }

  /**
   * 키 유효성만 확인한다 (사용 횟수 증가 없음).
   * API 인증 미들웨어처럼 요청마다 호출되는 경로에서 쓴다.
   */
  public async checkKey(key: string): Promise<CheckResult> {
    await this.initialize()
    const trimmed = String(key ?? '').trim()
    if (!trimmed) return { valid: false, message: '유효하지 않은 키입니다' }

    const licenseKey = await this.requireStore().findByKey(trimmed)
    if (!licenseKey) return { valid: false, message: '유효하지 않은 키입니다' }
    if (!licenseKey.isActive) return { valid: false, message: '비활성화된 키입니다' }
    if (new Date() > new Date(licenseKey.expiresAt)) {
      return { valid: false, message: '만료된 키입니다' }
    }
    return { valid: true, licenseKey }
  }

  /** 키 검증 + 사용 횟수 증가 (로그인 시점 1회) */
  public async validateKey(key: string): Promise<CheckResult> {
    const result = await this.checkKey(key)
    if (!result.valid || !result.licenseKey) return result

    const nowIso = new Date().toISOString()
    await this.requireStore().markUsed(result.licenseKey.key, nowIso)
    result.licenseKey.usedCount += 1
    result.licenseKey.lastUsedAt = nowIso
    return result
  }

  /** 키 정보 조회 */
  public async getKeyInfo(
    key: string
  ): Promise<{ success: boolean; info?: Partial<LicenseKey>; message?: string }> {
    await this.initialize()
    const licenseKey = await this.requireStore().findByKey(String(key ?? '').trim())
    if (!licenseKey) return { success: false, message: '키를 찾을 수 없습니다' }
    return { success: true, info: { ...licenseKey } }
  }

  /** 모든 키 목록 (최신 발급 순) */
  public async getAllKeys(): Promise<LicenseKey[]> {
    await this.initialize()
    return this.requireStore().listAll()
  }

  /** 키 활성화/비활성화 */
  public async toggleKey(key: string, isActive: boolean): Promise<boolean> {
    await this.initialize()
    return this.requireStore().setActive(key, isActive)
  }

  /** 키 삭제 */
  public async deleteKey(key: string): Promise<boolean> {
    await this.initialize()
    return this.requireStore().remove(key)
  }

  /** 만료된 키 정리 */
  public async cleanupExpiredKeys(): Promise<number> {
    await this.initialize()
    return this.requireStore().removeExpired(new Date().toISOString())
  }

  /** 사용 중인 저장소 설명 (진단용) */
  public describeStore(): string {
    return this.store ? this.store.describe() : '초기화 전'
  }
}

export default KeyService.getInstance()
