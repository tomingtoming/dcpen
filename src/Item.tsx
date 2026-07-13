import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { RigidBody } from '@react-three/rapier'
import { Group, Matrix4, Quaternion, Vector3 } from 'three'
import type { WebGLRenderer } from 'three'
import {
  Interactable,
  useInstanceEvent,
  useInstanceState,
  useItem,
  usePlacementState,
  useUsers,
} from '@xrift/world-components'
import { desktopHandApprox, handToWorld, handWorldQuaternion } from './pen/math'
import { StrokeStore } from './pen/store'
import {
  DESKTOP_DRAW_DISTANCE,
  MAX_POINTS_PER_STROKE,
  MIN_SEGMENT,
  PEN_COLORS,
  SEG_BATCH_POINTS,
  roundMm,
} from './pen/types'
import type { EndEvent, SegEvent, Stroke, UndoEvent } from './pen/types'

/** dev環境の自動テスト用フック。本番ビルドでは渡されない（dev.tsxのみが使う） */
export interface PenDebugApi {
  undo: () => void
  clear: () => void
  setColor: (c: string) => void
  strokeCount: () => number
  strokeColors: () => string[]
}

export interface ItemProps {
  position?: [number, number, number]
  scale?: number
  debugApi?: (api: PenDebugApi) => void
}

/** user-left イベントのペイロード形が非公開なので防御的に取り出す */
function extractUserId(d: unknown): string | null {
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    for (const k of ['id', 'socketId', 'userId']) {
      const v = o[k]
      if (typeof v === 'string') return v
    }
  }
  return null
}

/** フラット配列→drei Line用タプル列。未着バッチの穴はスキップ */
function toTuples(pts: number[]): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const x = pts[i]
    const y = pts[i + 1]
    const z = pts[i + 2]
    if (x === undefined || y === undefined || z === undefined) continue
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue
    out.push([x, y, z])
  }
  return out
}

interface ActiveStroke {
  sid: string
  color: string
  /** 書き込み済み点数 */
  count: number
  /** 送信済み点数 */
  sent: number
}

const _tipQ = new Quaternion()
const _dir = new Vector3()
const _camPos = new Vector3()
const _penPos = new Vector3()
const _viewOffset = new Vector3()
const _lookM = new Matrix4()
const _mHead = new Matrix4()
const _mGrip = new Matrix4()
const _mRig = new Matrix4()
const _mOut = new Matrix4()
const _gripFwd = new Vector3()

/**
 * ローカルVRの右手grip姿勢をWebXRのXRFrameから直接取る。
 * 同期データ(vrTracking)のアバター相対→ワールド推定変換は本番で当てにならない
 * （実測: 持った瞬間ペンがあらぬ座標へ飛んで見えなくなる）ため、
 * 自分の手はレンダラの一次情報から求める。
 * 座標系: gripはXR参照空間 → rig = headWorld × headLocal⁻¹ で世界系へ持ち上げる
 */
function localXrGripWorld(gl: WebGLRenderer, outPos: Vector3, outQuat: Quaternion): boolean {
  const xr = gl.xr
  if (!xr.isPresenting) return false
  const session = xr.getSession()
  if (!session) return false
  const frame = xr.getFrame()
  const refSpace = xr.getReferenceSpace()
  if (!frame || !refSpace) return false
  const viewerPose = frame.getViewerPose(refSpace)
  if (!viewerPose) return false
  let src: XRInputSource | null = null
  for (const s of session.inputSources) {
    if (s.handedness === 'right' && (s.gripSpace || s.targetRaySpace)) {
      src = s
      break
    }
  }
  if (!src) return false
  const space = src.gripSpace ?? src.targetRaySpace
  const pose = frame.getPose(space, refSpace)
  if (!pose) return false
  _mHead.fromArray(Array.from(viewerPose.transform.matrix))
  _mGrip.fromArray(Array.from(pose.transform.matrix))
  // three側のXRカメラのmatrixWorldは頭のワールド姿勢（rig合成済み）
  const headWorld = xr.getCamera().matrixWorld
  _mRig.copy(headWorld).multiply(_mHead.invert())
  _mOut.copy(_mRig).multiply(_mGrip)
  outPos.setFromMatrixPosition(_mOut)
  outQuat.setFromRotationMatrix(_mOut)
  return true
}

export const Item = (props: ItemProps) => {
  // 「ここに置く」の位置決め中（preview）は、物理コライダー・Interactable・
  // ポータル・同期フックを一切持たない張りぼてを出す。実体はここで生やすと
  // 設置レイキャストや確定クリックを自分自身で妨害してしまう
  const { mode } = usePlacementState()
  if (mode === 'preview') {
    return <PenPreview position={props.position} scale={props.scale} />
  }
  return <PenLive {...props} />
}

/** 設置プレビュー用の見た目だけのスタンド（コライダー・インタラクションなし） */
const PenPreview = ({ position = [0, 0, 0], scale = 1 }: Pick<ItemProps, 'position' | 'scale'>) => (
  <group position={position} scale={scale}>
    <mesh position={[0, 0.45, 0]}>
      <cylinderGeometry args={[0.32, 0.4, 0.9, 24]} />
      <meshStandardMaterial color="#3a3f4a" metalness={0.5} roughness={0.4} transparent opacity={0.8} />
    </mesh>
    <group position={[0, 1.05, 0]} rotation={[Math.PI / 2.4, 0, 0]}>
      <PenMesh color={PEN_COLORS[5]} />
    </group>
    {PEN_COLORS.map((c, i) => {
      const angle = (i / PEN_COLORS.length) * Math.PI * 2
      return (
        <mesh key={c} position={[Math.sin(angle) * 0.26, 0.93, Math.cos(angle) * 0.26]}>
          <boxGeometry args={[0.07, 0.05, 0.07]} />
          <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.35} />
        </mesh>
      )
    })}
  </group>
)

const PenLive = ({ position = [0, 0, 0], scale = 1, debugApi }: ItemProps) => {
  const { id } = useItem()
  const { localUser, getMovement, getLocalMovement, getAvatarHeight } = useUsers()
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)

  const myId = localUser?.id ?? 'dev-local'
  const myIdRef = useRef(myId)
  myIdRef.current = myId

  // ---- 同期状態 ----
  const [holder, setHolder] = useInstanceState<string | null>(`xpen:${id}:holder`, null)
  const [persisted, setPersisted] = useInstanceState<Stroke[]>(`xpen:${id}:strokes`, [])
  const iAmHolder = holder !== null && holder === myId
  const holderRef = useRef<string | null>(null)
  holderRef.current = holder
  const iAmHolderRef = useRef(false)
  iAmHolderRef.current = iAmHolder

  // ---- ローカル状態 ----
  const storeRef = useRef<StrokeStore | null>(null)
  if (!storeRef.current) storeRef.current = new StrokeStore()
  const store = storeRef.current
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick((n) => n + 1), [])

  const [color, setColor] = useState<string>(PEN_COLORS[5])
  const colorRef = useRef(color)
  colorRef.current = color

  const drawingRef = useRef(false)
  const activeRef = useRef<ActiveStroke | null>(null)
  const seqRef = useRef(0)
  const undoStack = useRef<string[]>([])
  const tip = useRef(new Vector3())
  const lastPt = useRef(new Vector3())
  // クリック（Interactable操作）と描画を両立させるための遅延開始アンカー
  const pressAnchor = useRef(new Vector3())
  const pressAnchorValid = useRef(false)
  const heldPenRef = useRef<Group>(null)
  // holder自己修復の監視: 持ち主のmovementが取れなくなった時刻
  const holderLostAt = useRef<number | null>(null)

  // late join: instance stateに残っている完成ストロークを取り込む
  useEffect(() => {
    if (Array.isArray(persisted) && persisted.length > 0) {
      store.merge(persisted)
      bump()
    }
  }, [persisted, store, bump])

  // ---- インスタンスイベント（自エコー前提・冪等） ----
  const emitSeg = useInstanceEvent<SegEvent>(`xpen:${id}:seg`, (d) => {
    store.applySegment(d.sid, d.color, d.off, d.pts)
    bump()
  })
  const emitEnd = useInstanceEvent<EndEvent>(`xpen:${id}:end`, (d) => {
    store.markFinished(d.sid)
    bump()
  })
  const emitUndo = useInstanceEvent<UndoEvent>(`xpen:${id}:undo`, (d) => {
    store.remove(d.sid)
    bump()
  })
  const emitClear = useInstanceEvent<Record<string, never>>(`xpen:${id}:clear`, () => {
    store.clear()
    bump()
  })
  useInstanceEvent<unknown>('user-left', (d) => {
    const gone = extractUserId(d)
    if (gone !== null && gone === holderRef.current) {
      setHolder(null)
    }
  })

  const persistFinished = useCallback(() => {
    setPersisted(store.finishedStrokes())
  }, [setPersisted, store])

  // ---- ストローク終了 ----
  const endActiveStroke = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    activeRef.current = null
    const s = store.get(a.sid)
    if (!s || a.count < 2) {
      // 1点だけの空振りは捨てる（未送信なのでローカル掃除だけでよい）
      store.remove(a.sid)
      bump()
      return
    }
    if (a.sent < a.count) {
      emitSeg({ sid: a.sid, color: a.color, off: a.sent, pts: s.pts.slice(a.sent * 3, a.count * 3) })
    }
    emitEnd({ sid: a.sid })
    store.markFinished(a.sid)
    undoStack.current.push(a.sid)
    persistFinished()
    bump()
  }, [store, emitSeg, emitEnd, persistFinished, bump])

  const doUndo = useCallback(() => {
    const sid = undoStack.current.pop()
    if (!sid) return
    store.remove(sid)
    emitUndo({ sid })
    persistFinished()
    bump()
  }, [store, emitUndo, persistFinished, bump])

  const clearAll = useCallback(() => {
    store.clear()
    emitClear({})
    setPersisted([])
    undoStack.current = []
    bump()
  }, [store, emitClear, setPersisted, bump])

  // dev環境のテスト用フック（本番ではdebugApi未指定なのでno-op）
  useEffect(() => {
    debugApi?.({
      undo: doUndo,
      clear: clearAll,
      setColor,
      strokeCount: () => store.all().length,
      strokeColors: () => store.all().map((s) => s.color),
    })
  }, [debugApi, doUndo, clearAll, store])

  // ---- 持つ/置く ----
  const toggleHold = useCallback(() => {
    const h = holderRef.current
    if (h === null) {
      setHolder(myIdRef.current)
    } else if (h === myIdRef.current) {
      drawingRef.current = false
      endActiveStroke()
      setHolder(null)
    }
  }, [setHolder, endActiveStroke])

  // ---- 入力（VR:トリガー / PC:マウス長押し） ----
  // 注意: キーボードは使えない。プレイヤー移動系がwindowのkeydown/keyupを
  // capture+stopImmediatePropagationで独占するため、ワールド/アイテム側には届かない。
  useEffect(() => {
    const startDraw = () => {
      if (iAmHolderRef.current) drawingRef.current = true
    }
    const stopDraw = () => {
      drawingRef.current = false
    }
    const tryUndo = () => {
      if (iAmHolderRef.current) doUndo()
    }

    // PC: 左ボタン長押しで描く。クリック（Interactable操作）と両立させるため、
    // ストローク開始は「押下中に一定距離動いてから」（useFrame側で遅延開始）
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) startDraw()
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 0) stopDraw()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)

    const onSelectStart = (e: XRInputSourceEvent) => {
      if (e.inputSource.handedness === 'right') startDraw()
    }
    const onSelectEnd = (e: XRInputSourceEvent) => {
      if (e.inputSource.handedness === 'right') stopDraw()
    }
    const onSqueezeStart = (e: XRInputSourceEvent) => {
      if (e.inputSource.handedness === 'right') tryUndo()
    }

    let boundSession: XRSession | null = null
    const bindSession = () => {
      const session = gl.xr.getSession()
      if (!session || session === boundSession) return
      boundSession = session
      session.addEventListener('selectstart', onSelectStart)
      session.addEventListener('selectend', onSelectEnd)
      session.addEventListener('squeezestart', onSqueezeStart)
    }
    const unbindSession = () => {
      if (!boundSession) return
      boundSession.removeEventListener('selectstart', onSelectStart)
      boundSession.removeEventListener('selectend', onSelectEnd)
      boundSession.removeEventListener('squeezestart', onSqueezeStart)
      boundSession = null
      drawingRef.current = false
    }
    gl.xr.addEventListener('sessionstart', bindSession)
    gl.xr.addEventListener('sessionend', unbindSession)
    bindSession()

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      gl.xr.removeEventListener('sessionstart', bindSession)
      gl.xr.removeEventListener('sessionend', unbindSession)
      unbindSession()
    }
  }, [gl, doUndo])

  // ---- 毎フレーム: ペン先計算・点打ち・ペン表示姿勢 ----
  useFrame(({ camera, clock }) => {
    const pen = heldPenRef.current
    const h = holderRef.current

    if (h === null) {
      if (pen) pen.visible = false
      if (activeRef.current) endActiveStroke()
      holderLostAt.current = null
      return
    }

    // ペン先のワールド座標を求める（ペン表示位置 _penPos は原則ペン先＝tip）
    let hasPose = false
    _penPos.copy(tip.current)
    if (h === myIdRef.current) {
      const mv = getLocalMovement()
      if (mv.isInVR && localXrGripWorld(gl, _penPos, _tipQ)) {
        // 自分のVRの手はXRFrameのgrip姿勢が一次情報。ペン先はgripのすこし前方(-Z)
        _gripFwd.set(0, 0, -0.08).applyQuaternion(_tipQ)
        tip.current.copy(_penPos).add(_gripFwd)
        _penPos.copy(tip.current)
        if (pen) pen.quaternion.copy(_tipQ)
        hasPose = true
      } else if (mv.isInVR && mv.vrTracking) {
        hasPose = handToWorld(mv, 'right', tip.current)
        _penPos.copy(tip.current)
        if (pen && handWorldQuaternion(mv, 'right', _tipQ)) pen.quaternion.copy(_tipQ)
      } else {
        // デスクトップ: インクは照準先に出しつつ、ペン本体はFPSの構えで
        // 画面右下に置き、ペン先(-Z)を描画点へ向ける＝「持ってる」見た目
        camera.getWorldPosition(_camPos)
        camera.getWorldDirection(_dir)
        tip.current.copy(_camPos).addScaledVector(_dir, DESKTOP_DRAW_DISTANCE)
        _viewOffset.set(0.17, -0.11, -0.4).applyQuaternion(camera.quaternion)
        _penPos.copy(_camPos).add(_viewOffset)
        if (pen) {
          _lookM.lookAt(_penPos, tip.current, camera.up)
          pen.quaternion.setFromRotationMatrix(_lookM)
        }
        hasPose = true
      }
    } else {
      const mv = getMovement(h)
      if (mv) {
        holderLostAt.current = null
        if (mv.isInVR && mv.vrTracking) {
          hasPose = handToWorld(mv, 'right', tip.current)
          _penPos.copy(tip.current)
          if (pen && handWorldQuaternion(mv, 'right', _tipQ)) pen.quaternion.copy(_tipQ)
        } else {
          const eye = getAvatarHeight?.(h)?.eyeHeight ?? 1.3
          desktopHandApprox(mv, eye, tip.current)
          _penPos.copy(tip.current)
          hasPose = true
        }
      } else {
        // 持ち主の姿が取れない＝退出後にholderが解放されず取り残された疑い。
        // user-leftのペイロード形に依存しない自己修復: 5秒続いたらスタンドへ戻す
        const now = clock.elapsedTime
        if (holderLostAt.current === null) {
          holderLostAt.current = now
        } else if (now - holderLostAt.current > 5) {
          holderLostAt.current = null
          setHolder(null)
        }
      }
    }

    if (pen) {
      pen.visible = hasPose
      if (hasPose) pen.position.copy(_penPos)
    }

    // 自分が描いている間だけ点を打つ
    if (h !== myIdRef.current || !hasPose) return
    if (drawingRef.current) {
      let a = activeRef.current
      if (!a) {
        // 遅延開始: 押しただけでは描かず、押下中に一定距離動いたら
        // アンカー点を始点にストロークを起こす（クリック操作との両立）
        if (!pressAnchorValid.current) {
          pressAnchor.current.copy(tip.current)
          pressAnchorValid.current = true
          return
        }
        if (tip.current.distanceTo(pressAnchor.current) < MIN_SEGMENT * 1.5) return
        seqRef.current += 1
        a = {
          sid: `${myIdRef.current}:${Date.now().toString(36)}:${seqRef.current}`,
          color: colorRef.current,
          count: 0,
          sent: 0,
        }
        activeRef.current = a
        store.applySegment(a.sid, a.color, 0, [
          roundMm(pressAnchor.current.x),
          roundMm(pressAnchor.current.y),
          roundMm(pressAnchor.current.z),
        ])
        a.count = 1
        lastPt.current.copy(pressAnchor.current)
        // fallthrough: このフレームの現在位置も続けて打つ
      }
      if (a.count >= MAX_POINTS_PER_STROKE) {
        endActiveStroke()
        return
      }
      if (tip.current.distanceTo(lastPt.current) < MIN_SEGMENT) return
      lastPt.current.copy(tip.current)
      store.applySegment(a.sid, a.color, a.count, [
        roundMm(tip.current.x),
        roundMm(tip.current.y),
        roundMm(tip.current.z),
      ])
      a.count += 1
      if (a.count - a.sent >= SEG_BATCH_POINTS) {
        const s = store.get(a.sid)
        if (s) {
          emitSeg({ sid: a.sid, color: a.color, off: a.sent, pts: s.pts.slice(a.sent * 3, a.count * 3) })
          a.sent = a.count
        }
      }
      bump()
    } else {
      pressAnchorValid.current = false
      if (activeRef.current) endActiveStroke()
    }
  })

  // ---- 見た目 ----
  const standText =
    holder === null
      ? 'ペンを持つ（VR:トリガー / PC:左ボタン長押しで描く）'
      : iAmHolder
        ? 'ペンを置く'
        : 'だれかが使用中'
  const strokes = store.all()

  const paletteChips = useMemo(
    () =>
      PEN_COLORS.map((c, i) => {
        const angle = (i / PEN_COLORS.length) * Math.PI * 2
        return { c, x: Math.sin(angle) * 0.26, z: Math.cos(angle) * 0.26 }
      }),
    [],
  )

  return (
    <group position={position} scale={scale}>
      {/* 台座 */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.32, 0.4, 0.9, 24]} />
          <meshStandardMaterial color="#3a3f4a" metalness={0.5} roughness={0.4} />
        </mesh>
      </RigidBody>

      {/* 台座＝持つ/置くのインタラクション */}
      <Interactable
        id={`xpen-${id}-stand`}
        onInteract={toggleHold}
        interactionText={standText}
        enabled={holder === null || iAmHolder}
      >
        {/* スタンド上のペン（誰も持っていないときだけ見える） */}
        <group position={[0, 1.05, 0]} visible={holder === null}>
          <FloatingPen color={color} />
        </group>
        {/* ペン携行中も置く操作ができるよう、台座上面に不可視の当たり */}
        <mesh position={[0, 0.91, 0]} visible={false}>
          <cylinderGeometry args={[0.3, 0.3, 0.04, 16]} />
          <meshStandardMaterial />
        </mesh>
      </Interactable>

      {/* カラーパレット（台座上面の縁） */}
      {paletteChips.map(({ c, x, z }, i) => (
        <Interactable
          key={c}
          id={`xpen-${id}-color-${i}`}
          onInteract={() => setColor(c)}
          interactionText="インクの色を変える"
        >
          <mesh position={[x, 0.93, z]} castShadow>
            <boxGeometry args={[0.07, 0.05, 0.07]} />
            <meshStandardMaterial
              color={c}
              emissive={c}
              emissiveIntensity={color === c ? 1.2 : 0.35}
            />
          </mesh>
        </Interactable>
      ))}

      {/* 1本戻すボタン */}
      <Interactable
        id={`xpen-${id}-undo`}
        onInteract={doUndo}
        interactionText="1本戻す（自分の線）"
      >
        <mesh position={[-0.14, 0.62, 0.34]} castShadow>
          <boxGeometry args={[0.1, 0.1, 0.05]} />
          <meshStandardMaterial color="#e8b500" emissive="#e8b500" emissiveIntensity={0.5} />
        </mesh>
      </Interactable>

      {/* 全消しボタン */}
      <Interactable id={`xpen-${id}-clear`} onInteract={clearAll} interactionText="ぜんぶ消す">
        <mesh position={[0.14, 0.62, 0.34]} castShadow>
          <boxGeometry args={[0.1, 0.1, 0.05]} />
          <meshStandardMaterial color="#b3001b" emissive="#b3001b" emissiveIntensity={0.5} />
        </mesh>
      </Interactable>

      {/* ストロークと手元ペンはワールド座標なのでシーン直下に描く */}
      {createPortal(
        <group>
          {strokes.map((s) => {
            const pts = toTuples(s.pts)
            if (pts.length < 2) return null
            return <Line key={s.sid} points={pts} color={s.color} lineWidth={4} />
          })}
          <group ref={heldPenRef} visible={false}>
            <HeldPen color={iAmHolder ? color : '#dddddd'} />
          </group>
        </group>,
        scene,
      )}
    </group>
  )
}

/** スタンドに浮かぶ展示状態のペン */
const FloatingPen = ({ color }: { color: string }) => {
  const ref = useRef<Group>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    ref.current.rotation.y = clock.elapsedTime * 0.8
    ref.current.position.y = Math.sin(clock.elapsedTime * 1.5) * 0.02
  })
  return (
    <group ref={ref} rotation={[Math.PI / 2.4, 0, 0]}>
      <PenMesh color={color} />
    </group>
  )
}

/** 手元用ペン（原点＝ペン先） */
const HeldPen = ({ color }: { color: string }) => <PenMesh color={color} />

/** ペンの造形。原点がペン先、+Z方向へ軸が伸びる */
const PenMesh = ({ color }: { color: string }) => (
  <group>
    {/* ペン先（発光） */}
    <mesh position={[0, 0, 0.01]} rotation={[-Math.PI / 2, 0, 0]}>
      <coneGeometry args={[0.006, 0.02, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} />
    </mesh>
    {/* 軸 */}
    <mesh position={[0, 0, 0.09]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.009, 0.009, 0.14, 12]} />
      <meshStandardMaterial color="#f5f5f5" metalness={0.1} roughness={0.35} />
    </mesh>
    {/* 尾栓 */}
    <mesh position={[0, 0, 0.165]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.01, 0.01, 0.012, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.8} />
    </mesh>
  </group>
)
