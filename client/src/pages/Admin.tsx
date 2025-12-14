/**
 * 관리자용 키 발급 페이지
 * 관리자가 키를 발급하고 관리할 수 있는 페이지
 */
import React, { useState, useEffect } from 'react'
import { useThemeStore } from '../store/useThemeStore'

interface LicenseKey {
  key: string
  issuedAt: string
  expiresAt: string
  validDays: number
  issuedBy: string
  description?: string
  isActive: boolean
  usedCount: number
  lastUsedAt?: string
}

const Admin = () => {
  const { theme } = useThemeStore()
  const [appkey, setAppkey] = useState('')
  const [secretkey, setSecretkey] = useState('')
  const [validDays, setValidDays] = useState(60)
  const [issuedBy, setIssuedBy] = useState('admin')
  const [description, setDescription] = useState('')
  const [isIssuing, setIsIssuing] = useState(false)
  const [issuedKey, setIssuedKey] = useState<string | null>(null)
  const [keys, setKeys] = useState<LicenseKey[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // 키 목록 로드
  const loadKeys = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/admin/keys')
      const data = await response.json()
      if (data.success) {
        setKeys(data.keys || [])
      }
    } catch (error) {
      console.error('키 목록 로드 오류:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadKeys()
  }, [])

  // 키 발급
  const handleIssueKey = async () => {
    if (validDays < 1 || validDays > 365) {
      alert('유효기간은 1일 이상 365일 이하여야 합니다')
      return
    }

    setIsIssuing(true)
    try {
      const response = await fetch('/api/admin/keys/issue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          validDays,
          issuedBy,
          description: description || undefined
        })
      })

      const data = await response.json()

      if (data.success) {
        setIssuedKey(data.key)
        setDescription('')
        loadKeys() // 목록 새로고침
        alert(`키가 발급되었습니다!\n키: ${data.key}\n만료일: ${new Date(data.expiresAt).toLocaleDateString()}`)
      } else {
        alert(`키 발급 실패: ${data.message}`)
      }
    } catch (error: any) {
      alert(`키 발급 오류: ${error.message}`)
    } finally {
      setIsIssuing(false)
    }
  }

  // 키 활성화/비활성화
  const handleToggleKey = async (key: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`/api/admin/keys/${key}/toggle`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isActive: !currentStatus
        })
      })

      const data = await response.json()

      if (data.success) {
        loadKeys()
      } else {
        alert(`키 상태 변경 실패: ${data.message}`)
      }
    } catch (error: any) {
      alert(`키 상태 변경 오류: ${error.message}`)
    }
  }

  // 키 삭제
  const handleDeleteKey = async (key: string) => {
    if (!confirm('정말 이 키를 삭제하시겠습니까?')) {
      return
    }

    try {
      const response = await fetch(`/api/admin/keys/${key}`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (data.success) {
        loadKeys()
        alert('키가 삭제되었습니다')
      } else {
        alert(`키 삭제 실패: ${data.message}`)
      }
    } catch (error: any) {
      alert(`키 삭제 오류: ${error.message}`)
    }
  }

  return (
    <div className={`p-6 max-w-[1200px] mx-auto min-h-screen ${
      theme === 'dark' ? 'bg-gradient-dark text-dark-text' : 'bg-gray-50 text-gray-900'
    }`}>
      <h1 className={`text-2xl font-bold mb-6 ${
        theme === 'dark' ? 'text-gradient' : 'text-gray-900'
      }`}>
        관리자 - 키 발급 관리
      </h1>

      {/* 키 발급 폼 */}
      <div style={{ 
        border: '1px solid #d1d5db', 
        borderRadius: '8px', 
        padding: '24px', 
        marginBottom: '24px',
        backgroundColor: 'white'
      }}>
        <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '16px' }}>
          새 키 발급
        </h2>

        <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#eff6ff', borderRadius: '4px' }}>
          <p style={{ fontSize: '12px', color: '#1e40af', lineHeight: '1.5', margin: 0 }}>
            💡 라이선스 키는 App Key/Secret Key와 무관한 독립적인 키입니다.<br />
            사용자는 라이선스 키와 함께 자신의 키움증권 App Key/Secret Key를 입력하여 로그인합니다.
          </p>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
            유효기간 (일) *
          </label>
          <input
            type="number"
            value={validDays}
            onChange={(e) => setValidDays(parseInt(e.target.value) || 60)}
            min={1}
            max={365}
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              fontSize: '14px'
            }}
          />
          <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
            {validDays}일 후 만료 ({new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toLocaleDateString()})
          </div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
            발급자
          </label>
          <input
            type="text"
            value={issuedBy}
            onChange={(e) => setIssuedBy(e.target.value)}
            placeholder="admin"
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              fontSize: '14px'
            }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
            설명 (선택사항)
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="키 설명"
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              fontSize: '14px'
            }}
          />
        </div>

        <button
          onClick={handleIssueKey}
          disabled={isIssuing}
          className={`px-6 py-3 rounded-full font-semibold text-sm flex items-center gap-2 transition-all duration-300 ${
            isIssuing
              ? 'bg-gray-500 cursor-not-allowed opacity-50'
              : 'btn-gradient-primary'
          }`}
        >
          {isIssuing ? (
            <>
              <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-gradient font-bold">발급 중...</span>
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span className="text-gradient font-bold">키 발급</span>
            </>
          )}
        </button>
      </div>

      {/* 발급된 키 목록 */}
      <div style={{ 
        border: '1px solid #d1d5db', 
        borderRadius: '8px', 
        padding: '24px',
        backgroundColor: 'white'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold' }}>
            발급된 키 목록 ({keys.length}개)
          </h2>
          <button
            onClick={loadKeys}
            disabled={isLoading}
            style={{
              padding: '6px 12px',
              backgroundColor: '#6b7280',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '12px'
            }}
          >
            {isLoading ? '로딩 중...' : '새로고침'}
          </button>
        </div>

        {keys.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280' }}>
            발급된 키가 없습니다
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>키</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>발급일</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600' }}>만료일</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>유효기간</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>발급자</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>사용횟수</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>상태</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: 600 }}>작업</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const expiresAt = new Date(key.expiresAt)
                  const now = new Date()
                  const isExpired = now > expiresAt
                  const remainingDays = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

                  return (
                    <tr key={key.key} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '12px', fontSize: '12px', fontFamily: 'monospace' }}>
                        {key.key}
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        {new Date(key.issuedAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px', color: isExpired ? '#dc2626' : '#059669' }}>
                        {expiresAt.toLocaleDateString()}
                        {!isExpired && remainingDays > 0 && (
                          <div style={{ fontSize: '10px', color: '#6b7280' }}>
                            ({remainingDays}일 남음)
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        {key.validDays}일
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        {key.issuedBy}
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        {key.usedCount}
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 500,
                          backgroundColor: key.isActive && !isExpired ? '#d1fae5' : '#fee2e2',
                          color: key.isActive && !isExpired ? '#065f46' : '#991b1b'
                        }}>
                          {isExpired ? '만료' : key.isActive ? '활성' : '비활성'}
                        </span>
                      </td>
                      <td style={{ padding: '12px', fontSize: '12px' }}>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            onClick={() => handleToggleKey(key.key, key.isActive)}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: key.isActive ? '#fbbf24' : '#22c55e',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '11px'
                            }}
                          >
                            {key.isActive ? '비활성화' : '활성화'}
                          </button>
                          <button
                            onClick={() => handleDeleteKey(key.key)}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: '#ef4444',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '11px'
                            }}
                          >
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default Admin

