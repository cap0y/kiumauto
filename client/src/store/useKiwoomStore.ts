import { create } from 'zustand'
import { kiwoomApi, KiwoomConfig } from '../api/kiwoom'

interface KiwoomState {
  connected: boolean
  connecting: boolean
  config: KiwoomConfig | null
  connect: (config: KiwoomConfig) => Promise<void>
  disconnect: () => void
  checkStatus: () => Promise<void>
}

export const useKiwoomStore = create<KiwoomState>((set) => ({
  connected: false,
  connecting: false,
  config: null,

  connect: async (config: KiwoomConfig) => {
    set({ connecting: true })
    try {
      await kiwoomApi.connect(config)
      set({ connected: true, config, connecting: false })
    } catch (error) {
      set({ connecting: false })
      throw error
    }
  },

  disconnect: () => {
    set({ connected: false, config: null })
  },

  checkStatus: async () => {
    try {
      const status = await kiwoomApi.getStatus()
      set({ connected: status.connected })
    } catch (error) {
      set({ connected: false })
    }
  },
}))

