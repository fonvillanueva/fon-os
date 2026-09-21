import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}', 'supabase/**/*.test.mjs'],
    // The Supabase tests boot a real Postgres (PGlite/WASM) per case.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
