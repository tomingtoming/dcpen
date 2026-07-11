import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import federation from '@originjs/vite-plugin-federation'

export default defineConfig({
  plugins: [
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
      shared: {
        react: {
          singleton: true,
          requiredVersion: '^19.0.0',
          strictVersion: false,
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^19.0.0',
          strictVersion: false,
        },
        'react-dom/client': {
          singleton: true,
          strictVersion: false,
        },
        'react/jsx-runtime': {
          singleton: true,
          requiredVersion: '^19.0.0',
          strictVersion: false,
        },
        three: {
          singleton: true,
          requiredVersion: '^0.183.1',
          strictVersion: false,
        },
        'three/addons/loaders/DRACOLoader.js': {
          singleton: true,
          version: '0.0.0',
        },
        '@react-three/fiber': {
          singleton: true,
          requiredVersion: '^9.3.0',
          strictVersion: false,
        },
        '@react-three/rapier': {
          singleton: true,
          requiredVersion: '^2.1.0',
          strictVersion: false,
        },
        '@react-three/drei': {
          singleton: true,
          requiredVersion: '^10.7.3',
          strictVersion: false,
        },
        '@react-three/uikit': {
          singleton: true,
          requiredVersion: '^1.0.0',
          strictVersion: false,
        },
        '@pmndrs/uikit': {
          singleton: true,
          requiredVersion: '^1.0.0',
          strictVersion: false,
        },
        '@xrift/world-components': {
          singleton: true,
          requiredVersion: '^0.41.0',
          strictVersion: false,
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
