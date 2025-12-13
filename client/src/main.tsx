import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './index.css'
import { useThemeStore } from './store/useThemeStore'

// Service Worker는 VitePWA 플러그인이 자동으로 등록합니다
// 수동 등록은 제거하여 충돌 방지

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// 테마 초기화 컴포넌트
const ThemeInitializer = () => {
  const { theme } = useThemeStore()
  
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])
  
  // 초기 마운트 시 테마 적용
  useEffect(() => {
    const root = document.documentElement
    const savedTheme = localStorage.getItem('theme-storage')
    if (savedTheme) {
      try {
        const parsed = JSON.parse(savedTheme)
        if (parsed.state?.theme === 'dark') {
          root.classList.add('dark')
        } else {
          root.classList.remove('dark')
        }
      } catch (e) {
        root.classList.add('dark')
      }
    } else {
      root.classList.add('dark')
    }
  }, [])
  
  return null
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeInitializer />
      <App />
      <Toaster 
        position="top-right"
        toastOptions={{
          className: 'dark:bg-dark-surface dark:text-dark-text dark:border-dark-border',
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>,
)

