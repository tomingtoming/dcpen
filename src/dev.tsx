/**
 * 開発環境用エントリーポイント
 *
 * DevEnvironment（WASD移動・クロスヘア・Interactableクリック・movement注入）の上で
 * アイテムを単体プレビューする。本番ビルドには含まれない。
 */

import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { RigidBody } from '@react-three/rapier'
import { DevEnvironment, ItemProvider, XRiftProvider, useUsers } from '@xrift/world-components'
import { Item } from './Item'

/**
 * XRiftProvider は UsersProvider を内包していて、素で被せると
 * DevEnvironment が注入した movement 実装を空実装で影に隠してしまう。
 * ここで useUsers() の値を吸い上げて渡し直すことで両立させる。
 */
const XRiftDevBridge = ({ children }: { children: ReactNode }) => {
  const users = useUsers()
  return (
    <XRiftProvider baseUrl="/" usersImplementation={users}>
      {children}
    </XRiftProvider>
  )
}

const App = () => (
  <DevEnvironment camera={{ position: [0, 1.6, 2.5] }} spawnPosition={[0, 1, 2.5]}>
    <XRiftDevBridge>
      <ItemProvider id="dev-pen-item">
        <Item
          position={[0, 0, 0]}
          debugApi={(api) => {
            ;(window as unknown as Record<string, unknown>).__xpen = api
          }}
        />
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
