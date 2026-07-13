/**
 * dcpen — QvPen風の空間らくがきペン（XRiftワールド部品）
 *
 * ワールド作者向けエントリ。XRiftワールドの任意の場所に:
 *   import { DcPen } from 'dcpen'
 *   <DcPen position={[0, 0, -3]} rotationY={Math.PI / 4} />
 */
export { DcPen } from './pen/DcPen'
export type { DcPenProps, DcPenDebugApi } from './pen/DcPen'
export { PEN_COLORS, RAINBOW } from './pen/types'
export type { Stroke } from './pen/types'
