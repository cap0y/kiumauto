/**
 * 사용자(라이선스 키)별 KiwoomService 인스턴스 저장소
 *
 * 기존에는 KiwoomService가 싱글톤이라 A가 연결하면 B가 덮어써서
 * A의 주문이 B 계좌로 나가는 사고가 가능했다.
 * 이제 라이선스 키마다 독립 인스턴스를 유지한다.
 */
import { KiwoomService } from './kiwoomService'

interface Entry {
  service: KiwoomService
  lastUsedAt: number
}

/** 마지막 사용 후 이 시간이 지나면 인스턴스를 정리한다 (토큰/소켓 누수 방지) */
const IDLE_TTL_MS = 6 * 60 * 60 * 1000 // 6시간

class KiwoomServiceRegistry {
  private static instance: KiwoomServiceRegistry
  private entries: Map<string, Entry> = new Map()
  private sweepTimer: NodeJS.Timeout | null = null
  private onCreate: ((key: string, service: KiwoomService) => void) | null = null
  private onRemove: ((key: string) => void) | null = null

  private constructor() {
    this.startSweep()
  }

  /** 세션 생성 시 실행할 훅 (실시간 스트림·자동취소 연결) */
  setOnCreate(hook: (key: string, service: KiwoomService) => void): void {
    this.onCreate = hook
  }

  static getInstance(): KiwoomServiceRegistry {
    if (!KiwoomServiceRegistry.instance) {
      KiwoomServiceRegistry.instance = new KiwoomServiceRegistry()
    }
    return KiwoomServiceRegistry.instance
  }

  /** 라이선스 키에 묶인 서비스 인스턴스를 반환한다 (없으면 생성) */
  get(userKey: string): KiwoomService {
    const key = String(userKey || '').trim()
    if (!key) throw new Error('사용자 식별자(라이선스 키)가 없습니다')

    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return existing.service
    }

    const service = new KiwoomService()
    this.entries.set(key, { service, lastUsedAt: Date.now() })
    console.log(`[세션] 새 KiwoomService 생성 (활성 세션 ${this.entries.size}개)`)
    // 실시간 스트림·자동취소를 이 세션에만 연결한다
    if (this.onCreate) {
      try {
        this.onCreate(key, service)
      } catch (error: any) {
        console.error('[세션] 초기화 훅 실패:', error.message)
      }
    }
    return service
  }

  /** 연결 해제 후 인스턴스를 제거한다 */
  remove(userKey: string): void {
    const key = String(userKey || '').trim()
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    entry.service.disconnect().catch(() => undefined)
    if (this.onRemove) {
      try {
        this.onRemove(key)
      } catch {
        // 정리 실패는 무시
      }
    }
    console.log(`[세션] 세션 제거 (남은 세션 ${this.entries.size}개)`)
  }

  /** 세션 제거 시 실행할 훅 (타이머 정리) */
  setOnRemove(hook: (key: string) => void): void {
    this.onRemove = hook
  }

  /**
   * 이미 같은 키움 계정(host+appkey)으로 연결된 다른 세션을 찾는다.
   * 키움은 계정당 WebSocket 1연결만 허용하므로 두 세션이 같은 계정을 쓰면
   * 시세가 서로 끊긴다. 연결 전에 확인해 사용자에게 알린다.
   */
  findDuplicate(identity: string, exceptKey: string): string | null {
    if (!identity) return null
    for (const [key, entry] of this.entries) {
      if (key === exceptKey) continue
      if (entry.service.identity() === identity) return key
    }
    return null
  }

  size(): number {
    return this.entries.size
  }

  /** 오래 사용하지 않은 세션 정리 */
  private startSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.entries) {
        if (now - entry.lastUsedAt > IDLE_TTL_MS) {
          this.entries.delete(key)
          entry.service.disconnect().catch(() => undefined)
          console.log(`[세션] 유휴 세션 정리: ${key.slice(0, 8)}...`)
        }
      }
    }, 10 * 60 * 1000)
    // 타이머가 프로세스를 붙잡지 않게 한다
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
  }
}

export const kiwoomRegistry = KiwoomServiceRegistry.getInstance()
