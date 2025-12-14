import React, { ReactNode, useEffect } from 'react'
import { useThemeStore } from '../store/useThemeStore'
import PWAInstaller from './PWAInstallButton'

interface LayoutProps {
  children: ReactNode
}

/**
 * 데스크톱 GUI 레이아웃
 * MainFrame.cs 스타일의 전체 화면 레이아웃
 * 테마 전환 기능 포함
 */
const Layout = ({ children }: LayoutProps) => {
  const { theme, toggleTheme } = useThemeStore()

  // 테마 변경 시 HTML 클래스 업데이트
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])

  return (
    <div className="w-screen h-screen overflow-hidden dark">
      {children}
      <PWAInstaller />
    </div>
  )
}

export default Layout
