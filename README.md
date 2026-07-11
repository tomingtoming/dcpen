# XRift Item Template

React Three Fiber で 3D アイテムを作成するための XRift アイテムテンプレートです。

## セットアップ

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
```

## Shared 依存関係

このテンプレートは [Module Federation](https://module-federation.io/) を使用しており、以下の依存関係はホストアプリケーション（xrift-frontend）と共有されます。アイテムのバンドルにはインライン化されず、shared チャンクとして分離されます。

| パッケージ | バージョン |
| --- | --- |
| `react` | ^19.0.0 |
| `react-dom` | ^19.0.0 |
| `react/jsx-runtime` | - |
| `three` | ^0.183.1 |
| `three/addons` | ^0.183.1 |
| `@react-three/fiber` | ^9.3.0 |
| `@react-three/rapier` | ^2.1.0 |
| `@react-three/drei` | ^10.7.3 |
| `@react-three/uikit` | ^1.0.0 |
| `@pmndrs/uikit` | ^1.0.0 |
| `@xrift/world-components` | ^0.41.0 |

### `three/addons` について

`three/addons` は shared 依存として利用可能です。`DRACOLoader` や `GLTFLoader` など Three.js のアドオンモジュールを使用する場合は、`three/addons/*` からインポートしてください。

```tsx
// OK: shared チャンクとして分離される
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
```

これにより、アドオンモジュールがアイテムチャンクにインライン化されることを防ぎます。インライン化された場合、`@xrift/code-security` によって `new Worker()` などが critical 違反として検出される問題が発生します。
