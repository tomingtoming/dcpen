import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * ライブラリビルド（npmパッケージ `dcpen` 用）。
 * XRiftアイテムのビルド（vite.config.ts / Module Federation）とは別系統。
 * 依存は全てexternal＝実行時はワールド側のバンドル/共有スコープに乗る。
 */
export default defineConfig({
  publicDir: false,
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
      include: ['src/lib.ts', 'src/pen'],
      outDir: 'lib',
    }),
  ],
  build: {
    outDir: 'lib',
    lib: {
      entry: path.resolve(__dirname, 'src/lib.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/, /^three($|\/)/, /^@react-three\//, /^@xrift\//],
    },
  },
})
