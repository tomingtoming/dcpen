/**
 * サムネイル撮影スクリプト（public/thumbnail.png の再現手順）
 *
 * devサーバの実シーンにストロークを注入し、撮影用カメラで直接レンダして
 * canvasから2560x1440のPNGを取り出す。DOMオーバーレイ（マウスロック案内等）は写らない。
 *
 * 使い方:
 *   1. DCPEN_HTTP=1 npm run dev        # httpでdevサーバを起動
 *   2. playwright-cli open http://localhost:5173/
 *   3. playwright-cli run-code --filename=scripts/shoot-thumbnail.js
 *   4. ffmpeg -i shot.png -vf "scale=1280:720:flags=lanczos" public/thumbnail.png
 *
 * 依存: dev.tsx の __scene/__gl/__THREE プローブと debugApi の inject（dev専用）。
 */
async page => {
  // ==== 調整パラメータ（イテレーションはここだけ触る） ====
  const P = {
    ver: 3,                       // ストロークsidの世代（形を変えたら上げる）
    cam: { pos: [0, 1.78, 3.1], look: [0, 1.5, 0], fov: 45 },
    lineWidthPx: 9,               // 2560px幅での線太さ(px)
    bgTop: '#1c2233', bgBottom: '#39415a',
    fog: null,
    hideGrid: true,
    hideFloor: true,
    noShadows: true,
    fillLight: true,
    posePen: true,                // 虹ペンを文字の書き終わりに浮かせる
    out: 'shot.png',
  }

  await page.setViewportSize({ width: 2560, height: 1440 })
  await page.waitForFunction(
    () => window.__scene && window.__gl && window.__xpen && window.__THREE,
    null, { timeout: 30000 },
  )

  // ---- ストローク舞台設営 ----
  await page.evaluate((P) => {
    const xpen = window.__xpen
    xpen.clear()

    const mm = v => Math.round(v * 1000) / 1000
    const strokes = []
    let cum = 0 // 虹の色相連続用: これまでの合計点数
    // pts2: [x,y]列（レター座標） → ワールドへ配置してストローク化
    const add = (color, pts3, { rainbowCont = false } = {}) => {
      const flat = []
      for (const p of pts3) flat.push(mm(p[0]), mm(p[1]), mm(p[2]))
      strokes.push({
        sid: `thumb${P.ver}-${strokes.length}`,
        color,
        pts: flat,
        hueOffset: rainbowCont ? cum : 0,
      })
      cum += pts3.length
    }
    // 折れ線を等間隔リサンプル
    const resample = (pts, step) => {
      const out = [pts[0]]
      let prev = pts[0]
      for (let i = 1; i < pts.length; i++) {
        const c = pts[i]
        const d = Math.hypot(c[0] - prev[0], c[1] - prev[1])
        const n = Math.max(1, Math.round(d / step))
        for (let k = 1; k <= n; k++)
          out.push([prev[0] + (c[0] - prev[0]) * k / n, prev[1] + (c[1] - prev[1]) * k / n])
        prev = c
      }
      return out
    }
    const arc = (cx, cy, rx, ry, a0, a1, n) => {
      const out = []
      for (let i = 0; i <= n; i++) {
        const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180
        out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
      }
      return out
    }

    // ==== 文字「DcPen」（レター座標: x右 y上、原点=左下） ====
    const H = 0.55, h = 0.38 // 大文字高・小文字x-height
    const letters = {
      // D: 縦棒を上がってボウルを回って戻る（一筆・戻り書きなし）
      D: { w: 0.44, path: [
        [0.04, 0], [0.04, H],
        ...arc(0.06, H / 2, 0.38, H / 2, 90, -90, 14),
      ] },
      c: { w: 0.36, path: arc(0.19, 0.19, 0.185, 0.19, 55, 305, 14) },
      P: { w: 0.36, path: [
        [0.02, 0], [0.02, H],
        ...arc(0.04, H * 0.72, 0.31, H * 0.28, 90, -90, 12),
      ] },
      e: { w: 0.37, path: [
        [0.03, 0.21], [0.34, 0.215],
        ...arc(0.185, 0.195, 0.175, 0.185, 5, 250, 14),
        [0.28, 0.015], [0.335, 0.06],
      ] },
      n: { w: 0.34, path: [
        [0.02, 0], [0.02, h * 0.95],
        ...arc(0.16, 0.22, 0.14, 0.16, 165, 15, 10),
        [0.30, 0.22], [0.30, 0],
      ] },
    }
    const word = 'DcPen'
    const gap = 0.10
    const wordW = [...word].reduce((s, ch) => s + letters[ch].w, 0) + gap * (word.length - 1)
    let x0 = -wordW / 2
    const baseY = 1.85, z0 = 0.35
    const jitter = [0.01, -0.012, 0.008, -0.006, 0.012] // 手書きらしい行揺れ
    ;[...word].forEach((ch, li) => {
      const L = letters[ch]
      const p2 = resample(L.path, 0.035)
      const p3 = p2.map(([x, y]) => [
        x0 + x,
        baseY + y + jitter[li],
        z0 + 0.03 * Math.sin((x0 + x) * 2.1 + y * 1.7),
      ])
      add('rainbow', p3, { rainbowCont: true })
      x0 += L.w + gap
    })

    // ==== 落書き ====
    // 赤ハート（左上）
    {
      const s = 0.155, cx = -1.42, cy = 2.18, cz = 0.15
      const pts = []
      for (let i = 0; i <= 44; i++) {
        const t = (i / 44) * Math.PI * 2
        const x = 16 * Math.sin(t) ** 3
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
        pts.push([cx + (x / 16) * s, cy + (y / 16) * s + 0.02, cz + 0.02 * Math.sin(t * 2)])
      }
      add('#e53935', pts)
    }
    // 黄色い星（右上）
    {
      const cx = 1.53, cy = 2.28, cz = 0.2, ro = 0.17, ri = 0.075, tilt = -0.18
      const pts = []
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI / 2 + tilt + (i / 10) * Math.PI * 2
        const r = i % 2 === 0 ? ro : ri
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz])
      }
      add('#fdd835', resample3(pts, 0.02))
    }
    // 青い渦巻き（左・パネルの外側）
    {
      const cx = -1.63, cy = 1.33, cz = 0.45
      const pts = []
      for (let i = 0; i <= 80; i++) {
        const a = (i / 80) * Math.PI * 2 * 2.6
        const r = 0.03 + (i / 80) * 0.145
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz + 0.015 * Math.sin(a * 1.3)])
      }
      add('#42a5f5', pts)
    }
    // 緑のスウッシュ（文字の下線）
    {
      const pts = []
      for (let i = 0; i <= 60; i++) {
        const t = i / 60
        const x = -1.05 + t * 2.15
        pts.push([x, 1.735 - t * 0.02 + 0.035 * Math.sin(t * Math.PI * 2.2), 0.38 + 0.02 * Math.sin(t * 9)])
      }
      add('#43a047', pts)
    }

    // 3D折れ線の等間隔リサンプル（星の直線区間を密にしてCatmull-Romの角丸を抑える）
    function resample3(pts, step) {
      const out = [pts[0]]
      let prev = pts[0]
      for (let i = 1; i < pts.length; i++) {
        const c = pts[i]
        const d = Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2])
        const n = Math.max(1, Math.round(d / step))
        for (let k = 1; k <= n; k++)
          out.push([
            prev[0] + (c[0] - prev[0]) * k / n,
            prev[1] + (c[1] - prev[1]) * k / n,
            prev[2] + (c[2] - prev[2]) * k / n,
          ])
        prev = c
      }
      return out
    }

    xpen.inject(strokes)
    return strokes.length
  }, P)

  // Reactのコミットと1フレームを待つ
  await page.waitForTimeout(500)

  // ---- 演出＋撮影 ----
  const dl = page.waitForEvent('download')
  await page.evaluate((P) => {
    const THREE = window.__THREE, scene = window.__scene, gl = window.__gl

    // 背景グラデーション
    const c = document.createElement('canvas')
    c.width = 4; c.height = 512
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 512)
    grad.addColorStop(0, P.bgTop)
    grad.addColorStop(1, P.bgBottom)
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 512)
    scene.background = new THREE.CanvasTexture(c)
    scene.fog = P.fog ? new THREE.Fog(P.bgBottom, P.fog.near, P.fog.far) : null

    // プレイヤーのカプセル等を隠す・線を太らせる・影を切る
    scene.traverse(o => {
      if (o.geometry && o.geometry.type === 'CapsuleGeometry') o.visible = false
      if (o.material && o.material.isLineMaterial) o.material.linewidth = P.lineWidthPx
      if (P.hideGrid && o.type === 'GridHelper') o.visible = false
      if (P.noShadows && o.isLight) o.castShadow = false
      if (P.hideFloor && o.geometry && o.geometry.type === 'BoxGeometry' && o.geometry.parameters.width === 30) o.visible = false
    })

    // フィルライト（ペンの暗さ対策・撮影用に追加）
    if (P.fillLight && !scene.getObjectByName('thumbFill')) {
      const fill = new THREE.DirectionalLight(0xffffff, 1.0)
      fill.name = 'thumbFill'
      fill.position.set(1.5, 3, 6)
      scene.add(fill)
      const amb = new THREE.AmbientLight(0xffffff, 0.35)
      amb.name = 'thumbFill'
      scene.add(amb)
    }

    // 虹ペンのクローンを「n」の書き終わりに浮かせる（書いた直後の演出）
    if (P.posePen && !scene.getObjectByName('thumbPen')) {
      let rainbowSlot = null
      scene.traverse(o => {
        if (o.type === 'Group' && Math.abs(o.position.x - 1.19) < 0.001 && Math.abs(o.position.y - 1.05) < 0.001)
          rainbowSlot = o
      })
      if (rainbowSlot) {
        const clone = rainbowSlot.clone(true)
        clone.name = 'thumbPen'
        clone.position.set(1.13, 1.87, 0.38) // 先端がnの終端付近に来る
        clone.rotation.set(-0.25, 0, -0.55)  // 右上に傾けて「持たれている」感
        clone.traverse(x => { x.visible = true })
        scene.add(clone)
      }
    }

    // 撮影カメラ
    const canvas = gl.domElement
    const cam = new THREE.PerspectiveCamera(P.cam.fov, canvas.width / canvas.height, 0.05, 100)
    cam.position.set(...P.cam.pos)
    cam.lookAt(...P.cam.look)
    cam.updateProjectionMatrix()

    gl.render(scene, cam)
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = P.out
    document.body.appendChild(a); a.click(); a.remove()
  }, P)
  const d = await dl
  await d.saveAs(P.out)
  return 'captured ' + P.out
}
