// localStorage as JSON, which can be missing or throw (private windows, blocked site data).
export const store = {
  get: <T>(key: string, fallback: T): T => {
    try {
      const value = localStorage.getItem(key)
      return value === null ? fallback : (JSON.parse(value) as T)
    } catch {
      return fallback
    }
  },
  set: (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}

// The panel library reads and writes the layout itself; this keeps it from throwing where storage is blocked.
export const layoutStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}
