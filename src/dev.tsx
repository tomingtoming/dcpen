/**
 * 開発環境用エントリーポイント
 *
 * DevEnvironment（WASD移動・クロスヘア・Interactableクリック・movement注入）の上で
 * アイテムを単体プレビューする。本番ビルドには含まれない。
 */

import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { RigidBody } from '@react-three/rapier'
import {
  DevEnvironment,
  ItemProvider,
  PlacementStateProvider,
  XRiftProvider,
  useUsers,
} from '@xrift/world-components'
import { Item } from './Item'

/** `?preview` を付けて開くと設置プレビュー（張りぼて）モードを確認できる */
const placementMode = new URLSearchParams(window.location.search).has('preview')
  ? ('preview' as const)
  : ('placed' as const)

/**
 * `?xr` を付けて開くとWebXRエミュレータ(iwer)を注入する自動テストモード。
 * playwright等から `window.__xrdevice`（頭・コントローラの姿勢/ボタン操作）と
 * `window.__gl`/`window.__scene` を使ってVR動作（掴む/回す/描く）を検証できる。
 * 本番ビルドの読み込みには乗らない（動的import＝?xr時のみ取得）。
 */
const xrTest = import.meta.env.DEV && new URLSearchParams(window.location.search).has('xr')
if (xrTest) {
  // import.meta.env.DEV ガードで本番ビルドからは完全に消える
  // （iwerはstorageを触るためXRiftのセキュリティ検査に掛かる。devサーバ専用）
  const { XRDevice, metaQuest3 } = await import('iwer')
  const xrdevice = new XRDevice(metaQuest3)
  // ブラウザ素のnavigator.xrがあると既定では遠慮するので、上書きを強制する
  xrdevice.installRuntime({ forceInstall: true })
  ;(window as unknown as Record<string, unknown>).__xrdevice = xrdevice
}

/** XRテスト用: R3F内部（renderer/scene/camera）を窓へ晒す */
const XrTestProbe = () => {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__gl = gl
    w.__scene = scene
    w.__camera = camera
    w.__THREE = THREE
  }, [gl, scene, camera])
  return null
}

/**
 * XRiftProvider は UsersProvider を内包していて、素で被せると
 * DevEnvironment が注入した movement 実装を空実装で影に隠してしまう。
 * ここで useUsers() の値を吸い上げて渡し直すことで両立させる。
 */
const XRiftDevBridge = ({ children }: { children: ReactNode }) => {
  const users = useUsers()
  // XRテストモード: 本番ホストは VR中 getLocalMovement().isInVR を立てるが、
  // DevEnvironment の movement 実装は isInVR を持たないため、ここで補う
  const impl = useMemo(() => {
    if (!xrTest) return users
    return {
      ...users,
      getLocalMovement: () => ({ ...users.getLocalMovement(), isInVR: true }),
    }
  }, [users])
  return (
    <XRiftProvider baseUrl="/" usersImplementation={impl}>
      {children}
    </XRiftProvider>
  )
}

const App = () => (
  <DevEnvironment camera={{ position: [0, 1.3, 3.4] }} spawnPosition={[0, 1, 3.4]}>
    {/* 自動テストはXR/デスクトップ両モードでsceneを検分する（devビルド専用ファイル） */}
    <XrTestProbe />
    <XRiftDevBridge>
      <ItemProvider id="dev-pen-item">
        <PlacementStateProvider mode={placementMode}>
          <Item
            position={[0, 0, 0]}
            debugApi={(api) => {
              ;(window as unknown as Record<string, unknown>).__xpen = api
            }}
          />
        </PlacementStateProvider>
      </ItemProvider>
    </XRiftDevBridge>

    {/* 地面 */}
    <RigidBody type="fixed" colliders="cuboid">
      <mesh receiveShadow position={[0, -0.05, 0]}>
        <boxGeometry args={[30, 0.1, 30]} />
        <meshStandardMaterial color="#4a4f5a" />
      </mesh>
    </RigidBody>
    <gridHelper args={[30, 30, '#777777', '#333333']} position={[0, 0.01, 0]} />

    <ambientLight intensity={0.5} />
    <directionalLight position={[5, 8, 3]} intensity={1.2} castShadow />
  </DevEnvironment>
)

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(<App />)
