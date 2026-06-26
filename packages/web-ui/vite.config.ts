import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`v${process.env.npm_package_version || '0.1.0'}-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`),
  },
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/mcp': 'http://localhost:3000',
      '/metrics': 'http://localhost:3000',
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/vue') || id.includes('node_modules/@vue') || id.includes('node_modules/pinia') || id.includes('node_modules/vue-router')) {
            return 'vue-vendor'
          }
          if (id.includes('node_modules/element-plus') || id.includes('node_modules/@element-plus')) {
            return 'element-plus'
          }
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts'
          }
          if (id.includes('node_modules/@antv/g6') || id.includes('node_modules/@antv/g')) {
            return 'antv-g6'
          }
        },
      },
    },
  },
})
