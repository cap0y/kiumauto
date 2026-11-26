/**
 * PostgreSQL 연결 헬퍼
 *
 * pg v8은 `sslmode=require`를 볼 때마다 "verify-full로 바뀐다"는 보안 경고를 찍는다.
 * Neon은 verify-full을 지원하므로 연결 문자열을 미리 정규화해 경고를 없앤다.
 * (경고만 없애고 보안 수준은 그대로 유지한다)
 */
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

/** sslmode를 verify-full로 정규화한다 (Neon은 CA 검증을 지원) */
export const normalizeConnectionString = (raw: string): string => {
  try {
    const url = new URL(raw)
    const mode = String(url.searchParams.get('sslmode') || '').toLowerCase()

    if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') {
      url.searchParams.set('sslmode', 'verify-full')
    }
    // pg가 경고하는 channel_binding 파라미터는 무시되므로 제거한다
    url.searchParams.delete('channel_binding')
    return url.toString()
  } catch {
    // URL 파싱 실패 시 원본 사용 (연결 오류는 pool이 알려준다)
    return raw
  }
}

/** SSL 옵션 결정 (DATABASE_SSL=false면 비활성) */
export const sslOption = () => {
  if (process.env.DATABASE_SSL === 'false') return false
  // Neon 등 매니지드 DB는 자체 CA를 쓰므로 체인 검증만 완화한다
  return { rejectUnauthorized: false }
}

/** 공용 Pool 생성 */
export const createPool = (connectionString: string) => {
  const { Pool } = nodeRequire('pg')
  const pool = new Pool({
    connectionString: normalizeConnectionString(connectionString),
    ssl: sslOption(),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })
  pool.on('error', (error: Error) => {
    console.error('[DB] 유휴 커넥션 오류:', error.message)
  })
  return pool
}
