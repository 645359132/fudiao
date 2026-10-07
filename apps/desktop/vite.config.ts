import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri 开发时连接固定端口；构建产物供 src-tauri 打包。
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // WebView2 基于 Chromium，按其版本设定构建目标。
  build: { target: 'chrome120', outDir: 'dist' },
});
