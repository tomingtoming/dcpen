import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import federation from '@originjs/vite-plugin-federation'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // LAN内の別PCからhttpsでdevプレビューするための設定（build成果物には影響しない）
  server: {
    host: true,
    allowedHosts: true,
  },
  plugins: [
    // DCPEN_HTTP=1 でhttpsを外す（ヘッドレス自動テスト用。localhostのhttpはsecure contextなのでWebXR可）
    ...(process.env.DCPEN_HTTP ? [] : [basicSsl()]),
    react(),
    dts({
      insertTypesEntry: true,
    }),
    federation({
      name: 'xrift_xrift_pen',
      filename: 'remoteEntry.js',
      exposes: {
        './Item': './src/index.tsx',
      },
      // requiredVersion はすべて '*'（spinwardワールドの動作実績に合わせる）。
      // 本番ホストの共有スコープは three@0.176.0・@xrift/world-components@0.1.0(内部版番号) を提供しており、
      // テンプレ既定の '^0.183.1' / '^0.41.0' だと不満足→ローカルフォールバックへ落ちるが、
      // __federation_shared_*.js はアップロード時に既定ignoreで除外されるため404→ロード失敗する。
      shared: {
        react: {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom/client': {
          singleton: true,
        },
        'react/jsx-runtime': {
          singleton: true,
          requiredVersion: '*',
        },
        three: {
          singleton: true,
          requiredVersion: '*',
        },
        'three/addons/loaders/DRACOLoader.js': {
          singleton: true,
        },
        '@react-three/fiber': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/rapier': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/drei': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@pmndrs/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@xrift/world-components': {
          singleton: true,
          requiredVersion: '*',
        },
      },
    }),
  ],
  build: {
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
    assetsDir: '',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  define: {
    global: 'globalThis',
  },
})
