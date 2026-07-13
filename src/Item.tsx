import { useItem, usePlacementState } from '@xrift/world-components'
import { DcPen } from './pen/DcPen'
import type { DcPenDebugApi } from './pen/DcPen'
import { PEN_COLORS, RAINBOW } from './pen/types'

/**
 * らくがきペン（アイテム版）＝QvPen準拠のペンラックをどのワールドにも持ち込める形にしたもの。
 * 本体実装は pen/Rack.tsx（ワールド埋め込み版「航海日誌」v18からの移植）。
 */

export type PenDebugApi = DcPenDebugApi

export interface ItemProps {
  position?: [number, number, number]
  scale?: number
  debugApi?: (api: PenDebugApi) => void
}

export const Item = (props: ItemProps) => {
  // 「ここに置く」の位置決め中は、Interactable・同期フック・ポータルを持たない張りぼてを出す
  const { mode } = usePlacementState()
  if (mode === 'preview') {
    return <RackPreview position={props.position} scale={props.scale} />
  }
  return <PlacedRack {...props} />
}

const PlacedRack = ({ position = [0, 0, 0], scale = 1, debugApi }: ItemProps) => {
  const { id } = useItem()
  return (
    <group position={position} scale={scale}>
      <DcPen syncId={`xpen:${id}`} debugApi={debugApi} />
    </group>
  )
}

const PEN_COUNT = PEN_COLORS.length
const penX = (i: number) => (i - (PEN_COUNT - 1) / 2) * 0.17

/** 設置プレビュー用の見た目だけのペンラック（コライダー・インタラクション・同期なし） */
const RackPreview = ({ position = [0, 0, 0], scale = 1 }: Pick<ItemProps, 'position' | 'scale'>) => (
  <group position={position} scale={scale}>
    {PEN_COLORS.map((c, i) => (
      <group key={c} position={[penX(i), 1.05, 0]}>
        {/* 吊り鉛筆の簡易ゴースト（軸のみ） */}
        <mesh position={[0, 0.19, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.29, 6]} />
          <meshStandardMaterial
            color={c === RAINBOW ? '#ffffff' : c}
            transparent
            opacity={0.6}
          />
        </mesh>
        <mesh position={[0, 0.02, 0]}>
          <coneGeometry args={[0.013, 0.034, 6]} />
          <meshStandardMaterial color="#d8bb90" transparent opacity={0.6} />
        </mesh>
      </group>
    ))}
    {/* 消しゴムと左パネルの気配 */}
    {[0, 1, 2].map((i) => (
      <mesh key={`e-${i}`} position={[penX(PEN_COUNT - 1) + 0.32 + i * 0.13, 1.15, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.07, 6]} />
        <meshStandardMaterial color="#666a75" transparent opacity={0.6} />
      </mesh>
    ))}
    {[1.45, 1.2, 0.95].map((y) => (
      <mesh key={`b-${y}`} position={[penX(0) - 0.35, y, 0]}>
        <boxGeometry args={[0.12, 0.08, 0.03]} />
        <meshStandardMaterial color="#555a66" transparent opacity={0.6} />
      </mesh>
    ))}
  </group>
)
