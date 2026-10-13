import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  // o electron-vite não minifica o renderer por padrão: o JS ia pro app com ~2,2 MB legível
  renderer: { plugins: [react()], build: { minify: true } }
})
