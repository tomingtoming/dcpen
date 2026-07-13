import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { Line, Text } from '@react-three/drei'
import { CatmullRomCurve3, Color, Euler, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three'
import type { WebGLRenderer } from 'three'
import {
  Interactable,
  useInstanceEvent,
  useInstanceState,
  useUsers,
} from '@xrift/world-components'
import { desktopHandApprox, handToWorld, handWorldQuaternion } from './math'
import { StrokeStore } from './store'
import {
  DESKTOP_DRAW_DISTANCE,
  MAX_POINTS_PER_STROKE,
  MIN_SEGMENT,
  PEN_COLORS,
  RAINBOW,
  SEG_BATCH_POINTS,
  SMOOTH_DIV,
  roundMm,
} from './types'
import type { EndEvent, SegEvent, Stroke, UndoEvent } from './types'

/**
 * ペンラック — QvPen準拠の空間らくがきペン（アイテム版）。
 * Spinward/toming工房の「航海日誌」(ワールド埋め込み版v18)からの移植。
 * アイテム版の差分＝①同期キーは設置ごとの `syncId`（`xpen:<itemId>`）で名前空間分離
 * ②設置は任意の位置・向きなので、ラック定位置のワールド姿勢は不可視アンカーの実測で取る。
 *
 * 本家QvPen(BOOTH 1555789 / github.com/ureishi/QvPen)の実装を読んで仕様を合わせている:
 * - 鉛筆型の色ペン14本＋虹ペンが空中のラックに並ぶ。各ペンの上=Respawn・下=その色のClear
 * - VR: **左右どちらの手でも**グリップ(握る)で掴む。**片手1本＝両手で2本同時持ち可**。
 *   掴んだ瞬間の相対姿勢のまま手にくっつく（縦持ち・横持ち自由＝VRC Pickup相当）。
 *   グリップを離すとその場の空中に浮いて留まる
 * - 持ち手のトリガーで描く。**トリガー2回(0.2秒以内)で消しゴムモード**＝ペン先が球になり、
 *   触れた部分だけ削る**部分消し**（線は残り部分に分割される。本家に無い独自拡張）
 * - 消しゴム3個: 掴んでトリガーを押しながら線に当てると**その線1本を消す**
 *   （本家ソース実測: 消しゴムはink IDごと消す＝線1本単位。こちらが本家準拠）
 * - 左パネル: Undo(自分の線) / Clear All / All Reset(ぜんぶ片づける)。ボタンはラベル常時表示
 * - デスクトップ: クリックで持つ/戻す・左長押しで描く（キーボードは本体が独占するため使えない）
 * 線はインスタンスが生きている限り残る（ラック自体は「置いた人」の退出で消える＝アイテムの宿命）。
 */

const COLOR_NAMES = [
  '黒',
  '赤',
  'オレンジ',
  '黄',
  '黄緑',
  '緑',
  'エメラルド',
  'シアン',
  '水色',
  '青',
  '紫',
  'マゼンタ',
  'ピンク',
  '白',
  '虹',
]

/** 消しゴム（QvPenは3個） */
const ERASER_COLORS = ['#8e4a5b', '#3f8f6a', '#3f6ba0']

/** グリップで掴める距離（手からペンまで・メートル） */
const GRAB_RADIUS = 0.45
/** 消しゴム(オブジェクト)の有効半径＝線1本単位で消す（QvPenのSphereCollider相当） */
const ERASE_RADIUS = 0.07
/** ペン先消しゴムモードの半径＝**部分消し**（触れた点だけ削って線を分割する） */
const PARTIAL_ERASE_RADIUS = 0.04
/** トリガー/クリックのダブルクリック判定（QvPen: clickTimeInterval = 0.2s） */
const DOUBLE_CLICK_MS = 200

type Hand = 'left' | 'right'

/** dev環境の自動テスト用フック。本番では渡されない */
export interface DcPenDebugApi {
  undo: () => void
  clear: () => void
  strokeCount: () => number
  strokeColors: () => string[]
}

export interface DcPenProps {
  /** 設置位置 */
  position?: [number, number, number]
  /** Y回転（ラック正面は+Z） */
  rotationY?: number
  /** 同期キーの名前空間。1ワールド/1インスタンスに複数置くときは変えること */
  syncId?: string
  debugApi?: (api: DcPenDebugApi) => void
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

/** 持ち主情報。手も同期し、リモート表示でどちらの手に付けるかを決める */
interface HolderInfo {
  id: string
  hand: Hand
}

/** 旧形式(文字列)や欠損に耐える正規化 */
function normHolder(v: unknown): HolderInfo | null {
  if (!v) return null
  if (typeof v === 'string') return { id: v, hand: 'right' }
  const o = v as { id?: unknown; hand?: unknown }
  if (typeof o.id === 'string') return { id: o.id, hand: o.hand === 'left' ? 'left' : 'right' }
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

const _rainbowC = new Color()
/**
 * 虹の色相の進み（描画頂点1つあたり）。旧実装は15mm間隔の点ごとに0.02＝約1.33周/m。
 * 補間後の頂点間隔は MIN_SEGMENT/SMOOTH_DIV なので、同じ「周/m」になるよう換算する
 */
const RAINBOW_HUE_STEP = 0.02 * (MIN_SEGMENT / 0.015 / SMOOTH_DIV)
/** 虹ペンの線: 点列に沿って色相が巡る頂点色 */
function rainbowVertexColors(n: number): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    _rainbowC.setHSL((i * RAINBOW_HUE_STEP) % 1, 1, 0.6)
    out.push([_rainbowC.r, _rainbowC.g, _rainbowC.b])
  }
  return out
}

/**
 * 描画専用の平滑化＝同期点列(MIN_SEGMENT間隔)をCatmull-Romで通過補間して細分する。
 * 同期・保存・消しゴム判定はすべて元の点列のまま＝見た目だけ滑らか（帯域ゼロ増）。
 * centripetal型は不等間隔の手書き点でループ/オーバーシュートを起こさない定番。
 * キャッシュは点数が変わったときだけ再計算（描画中ストロークは伸びるたび、完了線は1回きり）
 */
const _smoothCache = new Map<string, { n: number; pts: [number, number, number][] }>()
function smoothPoints(key: string, raw: [number, number, number][]): [number, number, number][] {
  if (raw.length < 3) return raw
  const hit = _smoothCache.get(key)
  if (hit && hit.n === raw.length) return hit.pts
  const curve = new CatmullRomCurve3(
    raw.map((p) => new Vector3(p[0], p[1], p[2])),
    false,
    'centripetal',
  )
  const pts = curve
    .getPoints((raw.length - 1) * SMOOTH_DIV)
    .map((v) => [v.x, v.y, v.z] as [number, number, number])
  _smoothCache.set(key, { n: raw.length, pts })
  return pts
}
/** 消えたストロークのキャッシュを間引く（合計線数の2倍を超えたら現存分だけ残す） */
function pruneSmoothCache(liveKeys: Set<string>) {
  if (_smoothCache.size <= liveKeys.size * 2 + 16) return
  for (const k of _smoothCache.keys()) {
    if (!liveKeys.has(k)) _smoothCache.delete(k)
  }
}

interface ActiveStroke {
  sid: string
  color: string
  count: number
  sent: number
}

/** 空中に置かれたペンの姿勢（instance stateで同期） */
interface PenPose {
  p: [number, number, number]
  q: [number, number, number, number]
}

/** ラック全体で共有する描画入力の状態（手ごと。子スロットは持ち手の分だけ読む） */
type DrawInput = Record<Hand, { down: boolean; seq: number }>

interface HandHold {
  slot: number
  /** グリップで掴んだ（＝グリップを離すとその場に置く）か */
  viaGrip: boolean
}

/** 自分の両手の持ち物（片手1本＝両手で2本まで） */
type MyHolds = Record<Hand, HandHold | null>
/** 消しゴムモードは手ごとに独立（両手持ち時に片方だけ消しゴムにできる） */
type EraserModes = Record<Hand, boolean>

/** 親がスロットを横断操作するためのAPI（近接掴み・片づけ・持ち替え） */
interface SlotApi {
  isFree: () => boolean
  penWorldPos: (out: Vector3) => void
  grab: (viaGrip: boolean, hand: Hand, handPos?: Vector3, handQuat?: Quaternion) => void
  dropHere: () => void
  putAway: () => void
}

// ---- 使い回しの一時オブジェクト ----
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
const _mScale = new Vector3()
const _handP = new Vector3()
const _handQ = new Quaternion()
const _invQ = new Quaternion()
const _grabPos = new Vector3()
const _grabQ = new Quaternion()
const _slotPos = new Vector3()
const _erasePt = new Vector3()
/** ラックに吊られた鉛筆の姿勢（ペン先下向き） */
const HANG_Q = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0))

/**
 * ローカルVRの手のgrip姿勢をWebXRのXRFrameから直接取る。
 * 同期データ(vrTracking)のアバター相対→ワールド推定変換は本番で当てにならない
 * （実測: ペンがあらぬ座標へ飛ぶ）ため、自分の手はレンダラの一次情報から求める。
 * 座標系: gripはXR参照空間 → rig = headWorld × headLocal⁻¹ で世界系へ持ち上げる。
 * 注意: XRift本番はXRオリジン(カメラリグ)をアバター身長比でscaleしているため、rigに
 * 一様スケールが混入する。setFromRotationMatrixは無スケール前提で回転が歪む
 * （位置は正しいので気づきにくい＝実測「握った手の回転にペンの向きが正しく追従しない」）。
 * decomposeでスケールを除いた単位quaternionを取ること。
 */
function localXrGripWorld(gl: WebGLRenderer, hand: Hand, outPos: Vector3, outQuat: Quaternion): boolean {
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
    if (s.handedness === hand && (s.gripSpace || s.targetRaySpace)) {
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
  _mOut.decompose(outPos, outQuat, _mScale)
  return true
}

const PEN_COUNT = PEN_COLORS.length
const SLOT_COUNT = PEN_COUNT + ERASER_COLORS.length

export const DcPen = ({ position = [0, 0, 0], rotationY = 0, syncId = 'dcpen', debugApi }: DcPenProps) => {
  const SYNC_ID = syncId
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)

  // ---- 共有ストローク状態 ----
  const storeRef = useRef<StrokeStore | null>(null)
  if (!storeRef.current) storeRef.current = new StrokeStore()
  const store = storeRef.current
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick((n) => n + 1), [])

  const [persisted, setPersisted] = useInstanceState<Stroke[]>(`${SYNC_ID}:strokes`, [])
  useEffect(() => {
    if (Array.isArray(persisted) && persisted.length > 0) {
      store.merge(persisted)
      bump()
    }
  }, [persisted, store, bump])

  const emitSeg = useInstanceEvent<SegEvent>(`${SYNC_ID}:seg`, (d) => {
    store.applySegment(d.sid, d.color, d.off, d.pts)
    bump()
  })
  const emitEnd = useInstanceEvent<EndEvent>(`${SYNC_ID}:end`, (d) => {
    store.markFinished(d.sid)
    bump()
  })
  const emitUndo = useInstanceEvent<UndoEvent>(`${SYNC_ID}:undo`, (d) => {
    store.remove(d.sid)
    bump()
  })
  const emitClear = useInstanceEvent<Record<string, never>>(`${SYNC_ID}:clear`, () => {
    store.clear()
    bump()
  })

  const persistFinished = useCallback(() => {
    setPersisted(store.finishedStrokes())
  }, [setPersisted, store])

  // ---- 自分の線のundoスタック（どの色のペンで描いたかは問わない） ----
  const undoStack = useRef<string[]>([])
  const pushUndoSid = useCallback((sid: string) => {
    undoStack.current.push(sid)
  }, [])
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

  /** 消しゴム/色別Clearが線を消すときの共通処理（自他問わず） */
  const eraseStroke = useCallback(
    (sid: string) => {
      store.remove(sid)
      emitUndo({ sid })
      persistFinished()
      bump()
    },
    [store, emitUndo, persistFinished, bump],
  )

  /** QvPenのペン別Clear相当: その色で描かれた線をぜんぶ消す */
  const clearColor = useCallback(
    (c: string) => {
      for (const s of store.all()) {
        if (s.color === c) {
          store.remove(s.sid)
          emitUndo({ sid: s.sid })
        }
      }
      persistFinished()
      bump()
    },
    [store, emitUndo, persistFinished, bump],
  )

  useEffect(() => {
    debugApi?.({
      undo: doUndo,
      clear: clearAll,
      strokeCount: () => store.all().length,
      strokeColors: () => store.all().map((s) => s.color),
    })
  }, [debugApi, doUndo, clearAll, store])

  // ---- 入力（手ごとに1系統。どのスロットが反応するかは各スロットが判断） ----
  // 注意: キーボードは使えない（プレイヤー移動系がwindowのkeydown/keyupを独占）
  const drawInput = useRef<DrawInput>({
    left: { down: false, seq: 0 },
    right: { down: false, seq: 0 },
  })
  const myHold = useRef<MyHolds>({ left: null, right: null })
  /** QvPen準拠: 持ち手トリガーのダブルクリック(0.2s)で消しゴムモード切替（手ごと） */
  const eraserMode = useRef<EraserModes>({ left: false, right: false })
  const lastPressAt = useRef<Record<Hand, number>>({ left: 0, right: 0 })
  /** グリップ掴みの要求。手の姿勢が要るので実処理は次フレーム（XRFrame内） */
  const pendingGrabHand = useRef<Hand | null>(null)
  const slotApi = useRef<(SlotApi | null)[]>(new Array(SLOT_COUNT).fill(null))

  useEffect(() => {
    const press = (hand: Hand) => {
      const now = performance.now()
      if (myHold.current[hand] !== null && now - lastPressAt.current[hand] < DOUBLE_CLICK_MS) {
        eraserMode.current[hand] = !eraserMode.current[hand]
      }
      lastPressAt.current[hand] = now
      drawInput.current[hand].down = true
      drawInput.current[hand].seq += 1
    }
    const release = (hand: Hand) => {
      drawInput.current[hand].down = false
    }

    // デスクトップのマウスは右手扱い
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) press('right')
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 0) release('right')
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)

    const handOf = (e: XRInputSourceEvent): Hand | null =>
      e.inputSource.handedness === 'left' ? 'left' : e.inputSource.handedness === 'right' ? 'right' : null

    const onSelectStart = (e: XRInputSourceEvent) => {
      const h = handOf(e)
      if (h) press(h)
    }
    const onSelectEnd = (e: XRInputSourceEvent) => {
      const h = handOf(e)
      if (h) release(h)
    }
    // QvPen準拠: グリップ(握る)で掴む・離すとその場に置く（左右どちらでも・片手1本）
    const onSqueezeStart = (e: XRInputSourceEvent) => {
      const h = handOf(e)
      if (!h) return
      const held = myHold.current[h]
      if (held === null) {
        pendingGrabHand.current = h
      } else {
        // レイ取り(sticky)のペンを握り直したらグリップ持ちに昇格＝離すと置けるように
        held.viaGrip = true
      }
    }
    const onSqueezeEnd = (e: XRInputSourceEvent) => {
      const h = handOf(e)
      if (!h) return
      const held = myHold.current[h]
      if (held !== null && held.viaGrip) {
        slotApi.current[held.slot]?.dropHere()
      }
    }

    let boundSession: XRSession | null = null
    const bindSession = () => {
      const session = gl.xr.getSession()
      if (!session || session === boundSession) return
      boundSession = session
      session.addEventListener('selectstart', onSelectStart)
      session.addEventListener('selectend', onSelectEnd)
      session.addEventListener('squeezestart', onSqueezeStart)
      session.addEventListener('squeezeend', onSqueezeEnd)
    }
    const unbindSession = () => {
      if (!boundSession) return
      boundSession.removeEventListener('selectstart', onSelectStart)
      boundSession.removeEventListener('selectend', onSelectEnd)
      boundSession.removeEventListener('squeezestart', onSqueezeStart)
      boundSession.removeEventListener('squeezeend', onSqueezeEnd)
      boundSession = null
      drawInput.current.left.down = false
      drawInput.current.right.down = false
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
  }, [gl])

  // グリップ掴み: squeezestartの次のフレームで手の位置を取り、届く範囲の空きスロットを掴む
  useFrame(() => {
    const hand = pendingGrabHand.current
    if (hand === null) return
    pendingGrabHand.current = null
    if (myHold.current[hand] !== null) return
    if (!localXrGripWorld(gl, hand, _grabPos, _grabQ)) return
    let best = -1
    let bestD = GRAB_RADIUS
    for (let i = 0; i < slotApi.current.length; i++) {
      const api = slotApi.current[i]
      if (!api || !api.isFree()) continue
      api.penWorldPos(_slotPos)
      const d = _slotPos.distanceTo(_grabPos)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) slotApi.current[best]?.grab(true, hand, _grabPos, _grabQ)
  })

  const putAwayAll = useCallback(() => {
    for (const api of slotApi.current) api?.putAway()
  }, [])

  // ---- レイアウト（QvPenのラック風・机なし空中固定） ----
  const strokes = store.all()
  pruneSmoothCache(new Set(strokes.map((s) => `${SYNC_ID}|${s.sid}`)))
  const penX = (i: number) => (i - (PEN_COUNT - 1) / 2) * 0.17
  const eraserX = (i: number) => penX(PEN_COUNT - 1) + 0.32 + i * 0.13

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* 手元灯（暗いワールドでも見つけられるように） */}
      <pointLight position={[0, 1.9, 0.3]} intensity={1.6} distance={5} color="#ffd49a" />

      {/* 色別ペン（吊り下げ・ペン先下向き） */}
      {PEN_COLORS.map((c, i) => (
        <PenSlot
          key={c}
          index={i}
          kind="pen"
          color={c}
          colorName={COLOR_NAMES[i] ?? c}
          slotOffset={[penX(i), 1.05, 0]}
          syncId={SYNC_ID}
          store={store}
          emitSeg={emitSeg}
          emitEnd={emitEnd}
          persistFinished={persistFinished}
          bump={bump}
          drawInput={drawInput}
          myHold={myHold}
          pushUndoSid={pushUndoSid}
          eraserMode={eraserMode}
          eraseStroke={eraseStroke}
          slotApi={slotApi}
        />
      ))}

      {/* 消しゴム（QvPen準拠: 掴んでトリガーで線に触れて消す＝線1本単位） */}
      {ERASER_COLORS.map((c, i) => (
        <PenSlot
          key={c}
          index={PEN_COUNT + i}
          kind="eraser"
          color={c}
          colorName="消しゴム"
          slotOffset={[eraserX(i), 1.15, 0]}
          syncId={SYNC_ID}
          store={store}
          emitSeg={emitSeg}
          emitEnd={emitEnd}
          persistFinished={persistFinished}
          bump={bump}
          drawInput={drawInput}
          myHold={myHold}
          pushUndoSid={pushUndoSid}
          eraserMode={eraserMode}
          eraseStroke={eraseStroke}
          slotApi={slotApi}
        />
      ))}

      {/* ペンごとのRespawn（上）とClear（下）＝QvPenのラックUI */}
      {PEN_COLORS.map((c, i) => (
        <group key={`ui-${c}`}>
          <LabeledButton
            id={`${SYNC_ID}-respawn-${i}`}
            position={[penX(i), 1.62, 0]}
            size={[0.09, 0.07, 0.02]}
            color="#37474f"
            label="Respawn"
            fontSize={0.015}
            interactionText={`${COLOR_NAMES[i]}のペンを片づける`}
            onInteract={() => slotApi.current[i]?.putAway()}
          >
            {/* 色バー（どのペンのボタンかを示す・QvPenの色帯） */}
            <mesh position={[0, -0.05, 0]}>
              <boxGeometry args={[0.1, 0.016, 0.02]} />
              <meshStandardMaterial
                color={c === RAINBOW ? '#ffffff' : c}
                emissive={c === RAINBOW ? '#ffffff' : c}
                emissiveIntensity={0.5}
              />
            </mesh>
          </LabeledButton>
          <LabeledButton
            id={`${SYNC_ID}-clearcolor-${i}`}
            position={[penX(i), 0.62, 0]}
            size={[0.09, 0.07, 0.02]}
            color="#4a3b57"
            label="Clear"
            fontSize={0.017}
            interactionText={`${COLOR_NAMES[i]}の線をぜんぶ消す`}
            onInteract={() => clearColor(c)}
          />
        </group>
      ))}

      {/* 左パネル（QvPenの管理UI相当・ラベル常時表示） */}
      <LabeledButton
        id={`${SYNC_ID}-undo`}
        position={[penX(0) - 0.35, 1.45, 0]}
        color="#8a6d00"
        label="Undo"
        interactionText="1本戻す（自分の線）"
        onInteract={doUndo}
      />
      <LabeledButton
        id={`${SYNC_ID}-clear`}
        position={[penX(0) - 0.35, 1.2, 0]}
        color="#8a0015"
        label="Clear All"
        fontSize={0.019}
        interactionText="線をぜんぶ消す"
        onInteract={clearAll}
      />
      <LabeledButton
        id={`${SYNC_ID}-reset`}
        position={[penX(0) - 0.35, 0.95, 0]}
        color="#1d4f9e"
        label="All Reset"
        fontSize={0.019}
        interactionText="ペンと消しゴムをぜんぶ片づける"
        onInteract={putAwayAll}
      />

      {/* ストロークはワールド座標なのでシーン直下に描く（描画時のみスプライン細分） */}
      {createPortal(
        <group>
          {strokes.map((s) => {
            const raw = toTuples(s.pts)
            if (raw.length < 2) return null
            const pts = smoothPoints(`${SYNC_ID}|${s.sid}`, raw)
            if (s.color === RAINBOW) {
              return (
                <Line
                  key={s.sid}
                  points={pts}
                  vertexColors={rainbowVertexColors(pts.length)}
                  color="#ffffff"
                  lineWidth={4}
                />
              )
            }
            return <Line key={s.sid} points={pts} color={s.color} lineWidth={4} />
          })}
        </group>,
        scene,
      )}
    </group>
  )
}

interface PenSlotProps {
  index: number
  kind: 'pen' | 'eraser'
  color: string
  colorName: string
  /** ラックローカルの定位置（ペンはペン先の位置） */
  slotOffset: [number, number, number]
  /** 同期キーの名前空間（親から引き継ぐ） */
  syncId: string
  store: StrokeStore
  emitSeg: (d: SegEvent) => void
  emitEnd: (d: EndEvent) => void
  persistFinished: () => void
  bump: () => void
  drawInput: MutableRefObject<DrawInput>
  myHold: MutableRefObject<MyHolds>
  pushUndoSid: (sid: string) => void
  eraserMode: MutableRefObject<EraserModes>
  eraseStroke: (sid: string) => void
  slotApi: MutableRefObject<(SlotApi | null)[]>
}

/** ラックの1本＝独立した持ち主を持つペン/消しゴム */
const PenSlot = ({
  index,
  kind,
  color,
  colorName,
  slotOffset,
  syncId,
  store,
  emitSeg,
  emitEnd,
  persistFinished,
  bump,
  drawInput,
  myHold,
  pushUndoSid,
  eraserMode,
  eraseStroke,
  slotApi,
}: PenSlotProps) => {
  const SYNC_ID = syncId
  const { localUser, getMovement, getLocalMovement, getAvatarHeight } = useUsers()
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)

  const myId = localUser?.id ?? 'dev-local'
  const myIdRef = useRef(myId)
  myIdRef.current = myId

  const [holderRaw, setHolder] = useInstanceState<HolderInfo | null>(`${SYNC_ID}:holder:${index}`, null)
  const [pose, setPose] = useInstanceState<PenPose | null>(`${SYNC_ID}:pose:${index}`, null)
  const holder = normHolder(holderRaw)
  const iAmHolder = holder !== null && holder.id === myId
  const holderRef = useRef<HolderInfo | null>(null)
  holderRef.current = holder
  const poseRef = useRef<PenPose | null>(null)
  poseRef.current = pose

  const activeRef = useRef<ActiveStroke | null>(null)
  const seqRef = useRef(0)
  const tip = useRef(new Vector3())
  const lastPt = useRef(new Vector3())
  const pressAnchor = useRef(new Vector3())
  const pressAnchorValid = useRef(false)
  const heldRef = useRef<Group>(null)
  const eraserTipRef = useRef<Mesh>(null)
  const holderLostAt = useRef<number | null>(null)
  const pressAtTake = useRef(-1)
  /** ラック定位置の実ワールド姿勢を測る不可視アンカー（設置の位置・向きに追従） */
  const anchorRef = useRef<Group>(null)
  /** 掴んだ瞬間の手→持ち物の相対姿勢（縦持ち横持ちの保持・VRC Pickup相当） */
  const offP = useRef(new Vector3(0, 0, kind === 'pen' ? -0.08 : -0.03))
  const offQ = useRef(new Quaternion())
  /** 手放し用: 最後に表示した持ち物のワールド姿勢 */
  const lastPenPos = useRef(new Vector3())
  const lastPenQuat = useRef(new Quaternion())

  // 持ち主が去ったら定位置へ戻す（線は備品として残る＝書き置き）
  useInstanceEvent<unknown>('user-left', (d) => {
    const gone = extractUserId(d)
    if (gone !== null && gone === holderRef.current?.id) {
      setHolder(null)
    }
  })

  const endActiveStroke = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    activeRef.current = null
    const s = store.get(a.sid)
    if (!s || a.count < 2) {
      store.remove(a.sid)
      bump()
      return
    }
    if (a.sent < a.count) {
      emitSeg({ sid: a.sid, color: a.color, off: a.sent, pts: s.pts.slice(a.sent * 3, a.count * 3) })
    }
    emitEnd({ sid: a.sid })
    store.markFinished(a.sid)
    pushUndoSid(a.sid)
    persistFinished()
    bump()
  }, [store, emitSeg, emitEnd, persistFinished, pushUndoSid, bump])

  /** いまの実体のワールド姿勢（ラック上 or 空中）。ラック上はアンカーの実測 */
  const restingWorldPose = useCallback(
    (outP: Vector3, outQ: Quaternion) => {
      const p = poseRef.current
      const a = anchorRef.current
      if (p) {
        outP.set(p.p[0], p.p[1], p.p[2])
        outQ.set(p.q[0], p.q[1], p.q[2], p.q[3])
      } else if (a) {
        a.getWorldPosition(outP)
        a.getWorldQuaternion(outQ)
        if (kind === 'pen') outQ.multiply(HANG_Q)
      } else {
        outP.set(0, 0, 0)
        outQ.identity()
      }
    },
    [kind],
  )

  // ---- 取る/置く/片づける ----
  /** このスロットを持っている自分の手を外す（消しゴムモードも解除） */
  const clearMyHand = useCallback(() => {
    for (const hd of ['left', 'right'] as Hand[]) {
      if (myHold.current[hd]?.slot === index) {
        myHold.current[hd] = null
        eraserMode.current[hd] = false
      }
    }
  }, [index, myHold, eraserMode])

  const take = useCallback(
    (viaGrip: boolean, hand: Hand = 'right', handPos?: Vector3, handQuat?: Quaternion) => {
      if (holderRef.current !== null) return
      const held = myHold.current[hand]
      if (held !== null && held.slot !== index) {
        // 同じ手での持ち替え: いま持っている物はその場に置く（QvPen同様）。反対の手は持ったまま
        slotApi.current[held.slot]?.dropHere()
      }
      // 掴んだ瞬間の相対姿勢を保存（グリップ掴みのみ。レイ取りは既定の構え）
      if (viaGrip && handPos && handQuat) {
        restingWorldPose(_penPos, _tipQ)
        _invQ.copy(handQuat).invert()
        offQ.current.copy(_invQ).multiply(_tipQ)
        offP.current.copy(_penPos).sub(handPos).applyQuaternion(_invQ)
      } else {
        offP.current.set(0, 0, kind === 'pen' ? -0.08 : -0.03)
        offQ.current.identity()
      }
      setHolder({ id: myIdRef.current, hand })
      myHold.current[hand] = { slot: index, viaGrip }
      eraserMode.current[hand] = false
      // この押下（トリガー/クリック）は取る操作。描画には使わない
      pressAtTake.current = drawInput.current[hand].down ? drawInput.current[hand].seq : -1
    },
    [setHolder, index, myHold, drawInput, eraserMode, slotApi, restingWorldPose, kind],
  )

  const returnToRack = useCallback(() => {
    endActiveStroke()
    setPose(null)
    setHolder(null)
    clearMyHand()
  }, [endActiveStroke, setPose, setHolder, clearMyHand])

  const dropHere = useCallback(() => {
    endActiveStroke()
    setPose({
      p: [roundMm(lastPenPos.current.x), roundMm(lastPenPos.current.y), roundMm(lastPenPos.current.z)],
      q: [
        Math.round(lastPenQuat.current.x * 1000) / 1000,
        Math.round(lastPenQuat.current.y * 1000) / 1000,
        Math.round(lastPenQuat.current.z * 1000) / 1000,
        Math.round(lastPenQuat.current.w * 1000) / 1000,
      ],
    })
    setHolder(null)
    clearMyHand()
  }, [endActiveStroke, setPose, setHolder, clearMyHand])

  const putAway = useCallback(() => {
    if (holderRef.current === null) setPose(null)
  }, [setPose])

  // 親へ横断操作APIを登録
  useEffect(() => {
    slotApi.current[index] = {
      isFree: () => holderRef.current === null,
      penWorldPos: (out: Vector3) => {
        const p = poseRef.current
        const a = anchorRef.current
        if (p) {
          out.set(p.p[0], p.p[1], p.p[2])
        } else if (a) {
          a.getWorldPosition(out)
          if (kind === 'pen') out.y += 0.17
        } else {
          out.set(0, 0, 0)
        }
      },
      grab: take,
      dropHere,
      putAway,
    }
    return () => {
      slotApi.current[index] = null
    }
  }, [index, kind, take, dropHere, putAway, slotApi])

  /** 消しゴム(オブジェクト)動作: 先端に触れている線を消す（本家準拠で線1本単位） */
  const erasePass = useCallback(() => {
    for (const s of store.all()) {
      let hit = false
      for (let i = 0; i + 2 < s.pts.length; i += 3) {
        const x = s.pts[i]
        const y = s.pts[i + 1]
        const z = s.pts[i + 2]
        if (x === undefined || y === undefined || z === undefined) continue
        _erasePt.set(x, y, z)
        if (_erasePt.distanceTo(tip.current) < ERASE_RADIUS) {
          hit = true
          break
        }
      }
      if (hit) eraseStroke(s.sid)
    }
  }, [store, eraseStroke])

  /**
   * ペン先消しゴムモードの部分消し: 球に触れた点だけ削り、線の残り部分を
   * 連続区間ごとに新しいストロークへ分割して全員に再同期する（本家に無い独自拡張）
   */
  const partialErasePass = useCallback(() => {
    for (const s of store.all()) {
      const pts = s.pts
      let touched = false
      const runs: number[][] = []
      let cur: number[] = []
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const x = pts[i]
        const y = pts[i + 1]
        const z = pts[i + 2]
        if (x === undefined || y === undefined || z === undefined) continue
        _erasePt.set(x, y, z)
        if (_erasePt.distanceTo(tip.current) < PARTIAL_ERASE_RADIUS) {
          touched = true
          if (cur.length >= 6) runs.push(cur)
          cur = []
        } else {
          cur.push(x, y, z)
        }
      }
      if (cur.length >= 6) runs.push(cur)
      if (!touched) continue
      // 元の線を消し、残り区間を新しい線として配り直す
      eraseStroke(s.sid)
      for (const run of runs) {
        seqRef.current += 1
        const sid = `${myIdRef.current}:${index}:${Date.now().toString(36)}:${seqRef.current}`
        store.applySegment(sid, s.color, 0, run)
        store.markFinished(sid)
        emitSeg({ sid, color: s.color, off: 0, pts: run })
        emitEnd({ sid })
      }
      persistFinished()
      bump()
    }
  }, [store, eraseStroke, emitSeg, emitEnd, persistFinished, bump, index])

  // ---- 毎フレーム: 先端計算・点打ち/消しゴム・表示姿勢 ----
  useFrame(({ camera, clock }) => {
    const held = heldRef.current
    const h = holderRef.current

    if (h === null) {
      if (held) held.visible = false
      if (activeRef.current) endActiveStroke()
      holderLostAt.current = null
      return
    }

    let hasPose = false
    _penPos.copy(tip.current)
    if (h.id === myIdRef.current) {
      const mv = getLocalMovement()
      if (mv.isInVR && localXrGripWorld(gl, h.hand, _handP, _handQ)) {
        // 自分のVRの手はXRFrameのgrip姿勢が一次情報。
        // 掴んだ瞬間の相対姿勢を掛けて「持った向きのまま」手に追従させる
        _tipQ.copy(_handQ).multiply(offQ.current)
        _penPos.copy(offP.current).applyQuaternion(_handQ).add(_handP)
        tip.current.copy(_penPos)
        if (held) held.quaternion.copy(_tipQ)
        hasPose = true
      } else if (mv.isInVR && mv.vrTracking) {
        hasPose = handToWorld(mv, h.hand, tip.current)
        _penPos.copy(tip.current)
        if (held && handWorldQuaternion(mv, h.hand, _tipQ)) held.quaternion.copy(_tipQ)
      } else {
        // デスクトップ: インクは照準先、持ち物はFPSの構え
        camera.getWorldPosition(_camPos)
        camera.getWorldDirection(_dir)
        tip.current.copy(_camPos).addScaledVector(_dir, DESKTOP_DRAW_DISTANCE)
        _viewOffset.set(0.17, -0.11, -0.4).applyQuaternion(camera.quaternion)
        _penPos.copy(_camPos).add(_viewOffset)
        if (held) {
          _lookM.lookAt(_penPos, tip.current, camera.up)
          held.quaternion.setFromRotationMatrix(_lookM)
        }
        hasPose = true
      }
      if (hasPose && held) {
        lastPenPos.current.copy(_penPos)
        lastPenQuat.current.copy(held.quaternion)
      }
    } else {
      const mv = getMovement(h.id)
      if (mv) {
        holderLostAt.current = null
        if (mv.isInVR && mv.vrTracking) {
          hasPose = handToWorld(mv, h.hand, tip.current)
          _penPos.copy(tip.current)
          if (held && handWorldQuaternion(mv, h.hand, _tipQ)) held.quaternion.copy(_tipQ)
        } else {
          const eye = getAvatarHeight?.(h.id)?.eyeHeight ?? 1.3
          desktopHandApprox(mv, eye, tip.current)
          _penPos.copy(tip.current)
          hasPose = true
        }
      } else {
        // 持ち主の姿が取れない＝退出後の取り残し疑い。5秒で自動返却
        const now = clock.elapsedTime
        if (holderLostAt.current === null) {
          holderLostAt.current = now
        } else if (now - holderLostAt.current > 5) {
          holderLostAt.current = null
          setHolder(null)
        }
      }
    }

    if (held) {
      held.visible = hasPose
      if (hasPose) held.position.copy(_penPos)
    }
    // 消しゴムモードの表示（ペン先が球になる・QvPen準拠。手ごとに独立）
    const inEraserMode = kind === 'pen' && eraserMode.current[h.hand]
    const et = eraserTipRef.current
    if (et) et.visible = h.id === myIdRef.current && inEraserMode

    // 自分が操作している間だけ入力を反映（持ち手のトリガーのみ）
    if (h.id !== myIdRef.current || !hasPose) return
    const input = drawInput.current[h.hand]
    const pressing = input.down && input.seq !== pressAtTake.current

    if (kind === 'eraser' || inEraserMode) {
      // トリガーを押しながら線に触れると消える。
      // 消しゴム=線1本単位（本家準拠）/ ペン先消しゴム=部分消し（独自拡張）
      if (activeRef.current) endActiveStroke()
      pressAnchorValid.current = false
      if (pressing) {
        if (kind === 'eraser') erasePass()
        else partialErasePass()
      }
      return
    }

    if (pressing) {
      let a = activeRef.current
      if (!a) {
        // 遅延開始: 押下中に一定距離動いてからストロークを起こす（クリック操作との両立）
        if (!pressAnchorValid.current) {
          pressAnchor.current.copy(tip.current)
          pressAnchorValid.current = true
          return
        }
        if (tip.current.distanceTo(pressAnchor.current) < MIN_SEGMENT * 1.5) return
        seqRef.current += 1
        a = {
          sid: `${myIdRef.current}:${index}:${Date.now().toString(36)}:${seqRef.current}`,
          color,
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

  const inAir = pose !== null
  const onRack = holder === null && !inAir
  const noun = kind === 'pen' ? `${colorName}のペン` : colorName
  const rackText =
    holder === null
      ? inAir
        ? `${noun}をラックに戻す`
        : kind === 'pen'
          ? `${noun}を持つ（VR:グリップで掴む・トリガー2回で消しゴム）`
          : `${noun}を持つ（トリガーで線に当てて消す）`
      : iAmHolder
        ? `${noun}をラックに戻す`
        : 'だれかが使用中'

  const onRackInteract = useCallback(() => {
    const h = holderRef.current
    if (h === null) {
      if (poseRef.current) {
        putAway()
      } else {
        take(false)
      }
    } else if (h.id === myIdRef.current) {
      returnToRack()
    }
  }, [take, returnToRack, putAway])

  return (
    <group position={slotOffset}>
      {/* 定位置のワールド姿勢を測るアンカー（描画なし） */}
      <group ref={anchorRef} />
      <Interactable
        id={`${SYNC_ID}-slot-${index}`}
        onInteract={onRackInteract}
        interactionText={rackText}
        enabled={holder === null || iAmHolder}
      >
        {/* ラック上の実体（誰も持っておらず空中にも無いときだけ見える） */}
        {kind === 'pen' ? (
          <group rotation={[-Math.PI / 2, 0, 0]} visible={onRack}>
            <PencilMesh color={color} />
          </group>
        ) : (
          <group visible={onRack}>
            <EraserMesh color={color} />
          </group>
        )}
        {/* 不可視の当たり（raycast可・描画なし。持ち帰り操作の受け皿でもある） */}
        <mesh position={[0, kind === 'pen' ? 0.17 : 0, 0]}>
          <cylinderGeometry args={[0.06, 0.06, kind === 'pen' ? 0.36 : 0.12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </Interactable>

      {/* 空中に置かれた実体（QvPen準拠: 離した場所・離した向きのまま浮いて留まる） */}
      {holder === null &&
        pose !== null &&
        createPortal(
          <group
            position={[pose.p[0], pose.p[1], pose.p[2]]}
            quaternion={[pose.q[0], pose.q[1], pose.q[2], pose.q[3]]}
          >
            <Interactable
              id={`${SYNC_ID}-slot-air-${index}`}
              onInteract={() => take(false)}
              interactionText={`${noun}を持つ`}
            >
              {kind === 'pen' ? <PencilMesh color={color} /> : <EraserMesh color={color} />}
              <mesh position={[0, 0, kind === 'pen' ? 0.17 : 0]}>
                <sphereGeometry args={[0.08, 8, 8]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </Interactable>
          </group>,
          scene,
        )}

      {/* 手元の実体はワールド座標なのでシーン直下に描く */}
      {createPortal(
        <group ref={heldRef} visible={false} name={`${SYNC_ID}-held-${index}`}>
          {kind === 'pen' ? <PencilMesh color={color} /> : <EraserMesh color={color} />}
          {/* 消しゴムモード時にペン先が球になる（QvPen準拠の表示） */}
          {kind === 'pen' && (
            <mesh ref={eraserTipRef} visible={false} position={[0, 0, 0.005]}>
              <sphereGeometry args={[0.02, 12, 12]} />
              <meshStandardMaterial color="#f0f0f0" emissive="#f0f0f0" emissiveIntensity={0.6} />
            </mesh>
          )}
        </group>,
        scene,
      )}
    </group>
  )
}

/** 虹ペンの軸の縞 */
const RAINBOW_STRIPES = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa']

/**
 * 鉛筆の造形（QvPenの見た目準拠）。原点がペン先、+Z方向へ軸が伸びる。
 * ラック表示時は rotation.x=-90° で吊るす（ペン先下向き）
 */
const PencilMesh = ({ color }: { color: string }) => {
  const lead = color === RAINBOW ? '#ffffff' : color
  return (
    <group>
      {/* 芯（発光） */}
      <mesh position={[0, 0, 0.007]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.0045, 0.015, 8]} />
        <meshStandardMaterial color={lead} emissive={lead} emissiveIntensity={1.8} />
      </mesh>
      {/* 木の削り部（六角錐） */}
      <mesh position={[0, 0, 0.031]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.013, 0.034, 6]} />
        <meshStandardMaterial color="#d8bb90" roughness={0.85} />
      </mesh>
      {/* 六角軸 */}
      {color === RAINBOW ? (
        RAINBOW_STRIPES.map((c, i) => (
          <mesh key={c} position={[0, 0, 0.048 + 0.048 * i + 0.024]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.048, 6]} />
            <meshStandardMaterial color={c} roughness={0.6} />
          </mesh>
        ))
      ) : (
        <mesh position={[0, 0, 0.192]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.288, 6]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
      )}
    </group>
  )
}

/** 消しゴムの造形（六角の塊・原点中心） */
const EraserMesh = ({ color }: { color: string }) => (
  <mesh rotation={[Math.PI / 2, 0, 0]}>
    <cylinderGeometry args={[0.05, 0.05, 0.07, 6]} />
    <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
  </mesh>
)

/** ラベル常時表示のボタン（VRはホバー文言が見えないため） */
const LabeledButton = ({
  id,
  position,
  size = [0.12, 0.08, 0.03],
  color,
  label,
  labelColor = '#ffffff',
  fontSize = 0.022,
  interactionText,
  onInteract,
  children,
}: {
  id: string
  position: [number, number, number]
  size?: [number, number, number]
  color: string
  label: string
  labelColor?: string
  fontSize?: number
  interactionText: string
  onInteract: () => void
  children?: ReactNode
}) => (
  <Interactable id={id} onInteract={onInteract} interactionText={interactionText}>
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
      </mesh>
      <Text
        position={[0, 0, size[2] / 2 + 0.002]}
        fontSize={fontSize}
        color={labelColor}
        anchorX="center"
        anchorY="middle"
        outlineWidth={fontSize * 0.08}
        outlineColor="#00000088"
      >
        {label}
      </Text>
      {children}
    </group>
  </Interactable>
)
