/**
 * 키 발급 및 관리 서비스
 * 관리자가 발급한 키를 관리하고 사용자의 키 검증을 처리합니다.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

interface LicenseKey {
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

interface KeyStore {
  keys: LicenseKey[]
}

class KeyService {
  private static instance: KeyService
  private keysFilePath: string
  private keys: Map<string, LicenseKey> = new Map()

  private constructor() {
    // 키 저장 파일 경로 설정
    const dataDir = path.join(process.cwd(), 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    this.keysFilePath = path.join(dataDir, 'license-keys.json')
    this.loadKeys()
  }

  public static getInstance(): KeyService {
    if (!KeyService.instance) {
      KeyService.instance = new KeyService()
    }
    return KeyService.instance
  }

  /**
   * 키 저장소에서 키 목록 로드
   */
  private loadKeys(): void {
    try {
      if (fs.existsSync(this.keysFilePath)) {
        const fileContent = fs.readFileSync(this.keysFilePath, 'utf-8')
        const keyStore: KeyStore = JSON.parse(fileContent)
        this.keys.clear()
        keyStore.keys.forEach(key => {
          this.keys.set(key.key, key)
        })
      } else {
        // 파일이 없으면 빈 저장소 생성
        this.saveKeys()
      }
    } catch (error) {
      console.error('키 로드 오류:', error)
      this.keys.clear()
    }
  }

  /**
   * 키 저장소에 키 목록 저장
   */
  private saveKeys(): void {
    try {
      const keyStore: KeyStore = {
        keys: Array.from(this.keys.values())
      }
      fs.writeFileSync(this.keysFilePath, JSON.stringify(keyStore, null, 2), 'utf-8')
    } catch (error) {
      console.error('키 저장 오류:', error)
    }
  }

  /**
   * 새로운 키 발급 (관리자용)
   */
  public issueKey(
    validDays: number,
    issuedBy: string = 'admin',
    description?: string
  ): LicenseKey {
    // 고유한 키 생성 (32자리 랜덤 문자열)
    const key = this.generateKey()
    
    const now = new Date()
    const expiresAt = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000)

    const licenseKey: LicenseKey = {
      key,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      validDays,
      issuedBy,
      description,
      isActive: true,
      usedCount: 0
    }

    this.keys.set(key, licenseKey)
    this.saveKeys()

    return licenseKey
  }

  /**
   * 고유한 키 생성
   */
  private generateKey(): string {
    let key: string
    do {
      // 32자리 랜덤 문자열 생성 (대문자, 숫자)
      key = crypto.randomBytes(16).toString('hex').toUpperCase()
    } while (this.keys.has(key)) // 중복 체크

    return key
  }

  /**
   * 키 검증 및 정보 반환
   */
  public validateKey(key: string): { valid: boolean; licenseKey?: LicenseKey; message?: string } {
    const licenseKey = this.keys.get(key)

    if (!licenseKey) {
      return { valid: false, message: '유효하지 않은 키입니다' }
    }

    if (!licenseKey.isActive) {
      return { valid: false, message: '비활성화된 키입니다' }
    }

    const now = new Date()
    const expiresAt = new Date(licenseKey.expiresAt)

    if (now > expiresAt) {
      return { valid: false, message: '만료된 키입니다' }
    }

    // 사용 횟수 증가 및 마지막 사용일시 업데이트
    licenseKey.usedCount++
    licenseKey.lastUsedAt = now.toISOString()
    this.saveKeys()

    return { valid: true, licenseKey }
  }

  /**
   * 키 정보 조회 (키 값 없이)
   */
  public getKeyInfo(key: string): { success: boolean; info?: Partial<LicenseKey>; message?: string } {
    const licenseKey = this.keys.get(key)

    if (!licenseKey) {
      return { success: false, message: '키를 찾을 수 없습니다' }
    }

    // 민감한 정보 제외하고 반환
    const info: Partial<LicenseKey> = {
      key: licenseKey.key,
      issuedAt: licenseKey.issuedAt,
      expiresAt: licenseKey.expiresAt,
      validDays: licenseKey.validDays,
      issuedBy: licenseKey.issuedBy,
      description: licenseKey.description,
      isActive: licenseKey.isActive,
      usedCount: licenseKey.usedCount,
      lastUsedAt: licenseKey.lastUsedAt
    }

    return { success: true, info }
  }

  /**
   * 모든 키 목록 조회 (관리자용)
   */
  public getAllKeys(): LicenseKey[] {
    return Array.from(this.keys.values())
  }

  /**
   * 키 활성화/비활성화
   */
  public toggleKey(key: string, isActive: boolean): boolean {
    const licenseKey = this.keys.get(key)
    if (!licenseKey) {
      return false
    }

    licenseKey.isActive = isActive
    this.saveKeys()
    return true
  }

  /**
   * 키 삭제
   */
  public deleteKey(key: string): boolean {
    if (this.keys.delete(key)) {
      this.saveKeys()
      return true
    }
    return false
  }

  /**
   * 만료된 키 정리
   */
  public cleanupExpiredKeys(): number {
    const now = new Date()
    let cleanedCount = 0

    this.keys.forEach((licenseKey, key) => {
      const expiresAt = new Date(licenseKey.expiresAt)
      if (now > expiresAt) {
        this.keys.delete(key)
        cleanedCount++
      }
    })

    if (cleanedCount > 0) {
      this.saveKeys()
    }

    return cleanedCount
  }
}

export default KeyService.getInstance()

