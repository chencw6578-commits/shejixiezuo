import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发服务器允许通过公网隧道（pinggy 等）预览：
//  - allowedHosts: true 放开 Host 校验，否则公网域名会被 403 拦截
//  - HMR 走 wss:443，浏览器经隧道才能连上热更新 websocket
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true,
    hmr: { protocol: 'wss', clientPort: 443 },
    proxy: {
      '/api': 'http://localhost:4000',
      '/storage': 'http://localhost:4000',
    },
  },
});
