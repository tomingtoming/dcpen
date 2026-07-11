import { MAX_TOTAL_POINTS, roundMm } from './types'
import type { Stroke } from './types'

/**
 * インスタンス内の全ストロークを保持するストア。
 * イベントは自分にもエコーされ得る・順序も保証されない前提で、
 * off（点単位オフセット）による冪等な書き込みだけを許す。
 */
export class StrokeStore {
  private strokes = new Map<string, Stroke>()
  /** 描画完了したストロークのsid（到着順） */
  private finishedOrder: string[] = []
  private finished = new Set<string>()
  /** 変更通知用の世代カウンタ（Reactの再描画トリガ） */
  version = 0

  get(sid: string): Stroke | undefined {
    return this.strokes.get(sid)
  }

  all(): Stroke[] {
    return [...this.strokes.values()]
  }

  finishedStrokes(): Stroke[] {
    return this.finishedOrder
      .map((sid) => this.strokes.get(sid))
      .filter((s): s is Stroke => s !== undefined)
  }

  /** 増分書き込み（自エコー・重複到着に冪等） */
  applySegment(sid: string, color: string, off: number, pts: number[]): void {
    let s = this.strokes.get(sid)
    if (!s) {
      s = { sid, color, pts: [] }
      this.strokes.set(sid, s)
    }
    const base = off * 3
    for (let i = 0; i < pts.length; i++) {
      s.pts[base + i] = pts[i]
    }
    this.version++
  }

  markFinished(sid: string): void {
    if (this.finished.has(sid)) return
    if (!this.strokes.has(sid)) return
    this.finished.add(sid)
    this.finishedOrder.push(sid)
    this.trim()
    this.version++
  }

  /** 完成形ストロークの一括投入（late join時のinstance stateマージ） */
  merge(strokes: Stroke[]): void {
    let changed = false
    for (const s of strokes) {
      if (this.strokes.has(s.sid)) continue
      this.strokes.set(s.sid, { sid: s.sid, color: s.color, pts: [...s.pts] })
      this.finished.add(s.sid)
      this.finishedOrder.push(s.sid)
      changed = true
    }
    if (changed) {
      this.trim()
      this.version++
    }
  }

  remove(sid: string): void {
    if (!this.strokes.delete(sid)) return
    this.finished.delete(sid)
    this.finishedOrder = this.finishedOrder.filter((x) => x !== sid)
    this.version++
  }

  clear(): void {
    if (this.strokes.size === 0) return
    this.strokes.clear()
    this.finished.clear()
    this.finishedOrder = []
    this.version++
  }

  /** 合計点数が予算を超えたら古い完成ストロークから捨てる */
  private trim(): void {
    let total = 0
    for (const s of this.strokes.values()) total += s.pts.length / 3
    while (total > MAX_TOTAL_POINTS && this.finishedOrder.length > 0) {
      const oldest = this.finishedOrder[0]
      const s = this.strokes.get(oldest)
      total -= s ? s.pts.length / 3 : 0
      this.remove(oldest)
    }
  }
}

/** Vector3的な点をmm丸めでフラット配列に積む */
export function pushPoint(pts: number[], x: number, y: number, z: number): void {
  pts.push(roundMm(x), roundMm(y), roundMm(z))
}
