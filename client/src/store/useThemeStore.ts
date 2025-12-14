import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
}

/**
 * 테마 전환을 위한 Zustand Store
 * localStorage에 테마 설정을 저장하여 새로고침 후에도 유지
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark' as Theme,
      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === 'dark' ? 'light' : 'dark',
        })),
      setTheme: (theme: Theme) => set({ theme }),
    }),
    {
      name: 'theme-storage',
    }
  )
)


