/**
 * ペンのストローク＝色付き折れ線1本。
 * pts は [x0, y0, z0, x1, y1, z1, ...] のフラット配列（ワールド座標・メートル）
 */
export interface Stroke {
  sid: string
  color: string
  pts: number[]
  /**
   * 虹ペンの色相位相オフセット（元の点単位）。部分消しで線が分割されても、
   * 残り区間が「切られる前の続き」の色から始まるようにするための基準点。
   * 新規に描き始めたストロークは常に0
   */
  hueOffset: number
}

/** 描画中ストロークの増分同期イベント。off は点単位（floatではない）の書き込み開始位置 */
export interface SegEvent {
  sid: string
  color: string
  off: number
  pts: number[]
  /** 新規ストローク作成時（off===0）のみ意味を持つ。省略時は0 */
  hueOffset?: number
}

export interface EndEvent {
  sid: string
}

export interface UndoEvent {
  sid: string
}

/**
 * これ以上手が動いたら点を打つ（メートル）。
 * 本家QvPenはTrailRenderer minVertexDistance=2µm＝実質毎フレーム打点の力技で滑らかさを
 * 出している（プレハブ実測）。こちらは10mm間隔＋描画側Catmull-Rom補間(SMOOTH_DIV)で
 * 同等の見た目を同期帯域ほぼ据え置きで得る方針。
 */
export const MIN_SEGMENT = 0.01
/** 描画側スプライン補間の分割数（同期点1区間あたりの描画セグメント数） */
export const SMOOTH_DIV = 4
/** 1ストロークの最大点数 */
export const MAX_POINTS_PER_STROKE = 2000
/** インスタンス全体で保持する合計点数の予算（超えたら古いストロークから捨てる） */
export const MAX_TOTAL_POINTS = 20000
/** 増分同期のバッチ点数 */
export const SEG_BATCH_POINTS = 4
/** デスクトップモードの描画距離（カメラ前方・メートル） */
export const DESKTOP_DRAW_DISTANCE = 1.2

/** 虹ペンの色識別子（線を虹色グラデーションで描く） */
export const RAINBOW = 'rainbow'

/** QvPen準拠の15本（14色＋虹） */
export const PEN_COLORS: readonly string[] = [
  '#111111',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#9ccc65',
  '#43a047',
  '#26a69a',
  '#26c6da',
  '#42a5f5',
  '#1f4fd8',
  '#8e24aa',
  '#d500f9',
  '#f06292',
  '#ffffff',
  RAINBOW,
]

/** 座標をmm精度に丸める（同期ペイロード削減） */
export function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000
}
