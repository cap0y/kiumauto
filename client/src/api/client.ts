import axios, { InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'

// Vite 프록시를 사용하므로 상대 경로 사용
// 개발 환경: /api로 시작하는 요청은 자동으로 http://localhost:8000으로 프록시됨
// 프로덕션: 환경 변수로 설정된 API URL 사용
const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || '/api'

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
})

// 요청 인터셉터
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    return config
  },
  (error: AxiosError) => {
    return Promise.reject(error)
  }
)

// 응답 인터셉터
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    // 응답에 에러가 포함되어 있지만 200 상태 코드인 경우 처리
    // 경고 메시지가 있는 경우에도 정상 응답으로 처리 (에러는 onSuccess에서 처리)
    return response
  },
  (error: AxiosError<{ detail?: string; message?: string; error?: string }>) => {
    // 400, 500 등의 실제 HTTP 에러만 여기서 처리
    if (error.response) {
      const message = error.response.data?.error || error.response.data?.detail || error.response.data?.message || '오류가 발생했습니다'
      console.error('API Error:', message)
    }
    return Promise.reject(error)
  }
)

export default apiClient

