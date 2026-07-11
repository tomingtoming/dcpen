import { Euler, Quaternion, Vector3 } from 'three'
import type { PlayerMovement } from '@xrift/world-components'

const UP = new Vector3(0, 1, 0)
const tmpQ = new Quaternion()
const tmpE = new Euler()

/**
 * VRトラッキングの手（アバター基準相対座標）をワールド座標へ変換する。
 * アバター根＝ position + rotY(yaw)。yaw はラジアン
 * （world-components の PhysicsPlayer が avatarGroup.rotation.set(0, yaw, 0) している規約に一致）
 */
export function handToWorld(mv: PlayerMovement, hand: 'left' | 'right', out: Vector3): boolean {
  const t = mv.vrTracking
  if (!t) return false
  const h = hand === 'right' ? t.rightHand.position : t.leftHand.position
  out.set(h.x, h.y, h.z)
  out.applyAxisAngle(UP, mv.rotation.yaw)
  out.x += mv.position.x
  out.y += mv.position.y
  out.z += mv.position.z
  return true
}

/** アバターのyawをワールド回転クォータニオンにする */
export function yawQuaternion(mv: PlayerMovement, out: Quaternion): Quaternion {
  return out.setFromAxisAngle(UP, mv.rotation.yaw)
}

/**
 * VRの手の回転（アバター基準オイラー）をワールド回転にする。
 * ペンの向き表示用（描画位置には影響しない）
 */
export function handWorldQuaternion(mv: PlayerMovement, hand: 'left' | 'right', out: Quaternion): boolean {
  const t = mv.vrTracking
  if (!t) return false
  const r = hand === 'right' ? t.rightHand.rotation : t.leftHand.rotation
  out.setFromAxisAngle(UP, mv.rotation.yaw)
  tmpE.set(r.x, r.y, r.z, 'XYZ')
  tmpQ.setFromEuler(tmpE)
  out.multiply(tmpQ)
  return true
}

/**
 * デスクトップ勢（vrTracking無し）のペン表示位置＝目の高さ弱・体の前方。
 * リモートユーザーの手元表現に使う
 */
export function desktopHandApprox(mv: PlayerMovement, eyeHeight: number, out: Vector3): void {
  out.set(0.15, 0, -0.35)
  out.applyAxisAngle(UP, mv.rotation.yaw)
  out.x += mv.position.x
  out.y += mv.position.y + eyeHeight * 0.55
  out.z += mv.position.z
}
