/**
 * ペンのストローク＝色付き折れ線1本。
 * pts は [x0, y0, z0, x1, y1, z1, ...] のフラット配列（ワールド座標・メートル）
 */
export interface Stroke {
  sid: string
  color: string
  pts: number[]
}

/** 描画中ストロークの増分同期イベント。off は点単位（floatではない）の書き込み開始位置 */
export interface SegEvent {
  sid: string
  color: string
  off: number
  pts: number[]
}

export interface EndEvent {
  sid: string
}

export interface UndoEvent {
  sid: string
}

/** これ以上手が動いたら点を打つ（メートル） */
export const MIN_SEGMENT = 0.015
/** 1ストロークの最大点数 */
export const MAX_POINTS_PER_STROKE = 2000
/** インスタンス全体で保持する合計点数の予算（超えたら古いストロークから捨てる） */
export const MAX_TOTAL_POINTS = 20000
/** 増分同期のバッチ点数 */
export const SEG_BATCH_POINTS = 4
/** デスクトップモードの描画距離（カメラ前方・メートル） */
export const DESKTOP_DRAW_DISTANCE = 1.2

export const PEN_COLORS: readonly string[] = [
  '#ffffff',
  '#ff4d4d',
  '#ff9f1c',
  '#ffe066',
  '#7cff6b',
  '#4dd2ff',
  '#4d6bff',
  '#c44dff',
  '#ff66c4',
  '#333333',
]

/** 座標をmm精度に丸める（同期ペイロード削減） */
export function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000
}
