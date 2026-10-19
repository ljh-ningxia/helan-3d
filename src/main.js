/**
 * 贺兰山 3D 地形 —— 真实 SRTM 数据渲染
 *
 * 数据: data/helan_heightmap.bin
 *   - 16 字节头: uint32 width, uint32 height, float32 elev_min, float32 elev_max
 *   - 之后: width*height 个 uint16（小端，行优先，海拔米）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const HEIGHT_URL = './data/helan_heightmap.bin';

/* ---------- 渲染参数（可按机器性能调） ---------- */
const VERTICAL_EXAGGERATION = 0.9;   // 垂直夸张系数（真实比例下山会显得很平）
const SUN_DIR = new THREE.Vector3(-0.55, 0.7, 0.45).normalize();
const FOG_COLOR = 0x0d1420;
const SKY_TOP = 0x0b1526;
const SKY_BOTTOM = 0x1d3350;

/* ---------- 高程配色带（干旱区山地） ---------- */
const COLOR_STOPS = [
  [0.00, [0x2e, 0x59, 0x4e]],   // 盆地戈壁 深青
  [0.18, [0x55, 0x7d, 0x4f]],   // 山麓草原
  [0.38, [0xa8, 0xa0, 0x6a]],   // 干草原 黄褐
  [0.55, [0xc9, 0x97, 0x5b]],   // 岩屑坡
  [0.75, [0xe8, 0xdc, 0xc8]],   // 高山草甸/岩面
  [0.92, [0xf6, 0xf2, 0xe8]],   // 近峰顶
  [1.00, [0xff, 0xff, 0xff]],   // 峰顶
];

function hypsoColor(t) {
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    if (t <= COLOR_STOPS[i][0]) {
      const [t0, c0] = COLOR_STOPS[i - 1];
      const [t1, c1] = COLOR_STOPS[i];
      const k = (t - t0) / (t1 - t0);
      return [0, 1, 2].map(j => c0[j] + (c1[j] - c0[j]) * k);
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}

/* ---------- 状态 ---------- */
let showContour = false;
let autoRotate = true;

/* ---------- 场景 ---------- */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(FOG_COLOR, 900, 2600);

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 8000);
camera.position.set(320, 300, 520);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 60;
controls.maxDistance = 2200;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.55;
controls.target.set(0, 60, 0);

/* 天空穹顶 */
{
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4000, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(SKY_TOP) },
        bottom: { value: new THREE.Color(SKY_BOTTOM) },
      },
      vertexShader: /* glsl */`
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 top; uniform vec3 bottom;
        varying vec3 vPos;
        void main() {
          float h = clamp(vPos.y / 4000.0 * 0.5 + 0.5, 0.0, 1.0);
          vec3 c = mix(bottom, top, pow(h, 0.8));
          // 地平线轻微泛光
          float glow = exp(-abs(vPos.y) * 0.004) * 0.25;
          gl_FragColor = vec4(c + glow * vec3(0.35, 0.5, 0.7), 1.0);
        }`,
    })
  );
  sky.renderOrder = -1;
  scene.add(sky);
}

/* 光照 */
const sun = new THREE.DirectionalLight(0xfff2df, 2.2);
sun.position.copy(SUN_DIR).multiplyScalar(1000);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x8fb4dd, 0x2a2a20, 0.55));

/* ---------- 地形网格 ---------- */
async function loadHeightmap() {
  const res = await fetch(HEIGHT_URL);
  if (!res.ok) throw new Error(`heightmap fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  const emin = dv.getFloat32(8, true);
  const emax = dv.getFloat32(12, true);
  const n = w * h;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = dv.getUint16(16 + i * 2, true);
  return { w, h, emin, emax, heights };
}

function buildTerrain({ w, h, emin, emax, heights }) {
  const span = emax - emin;

  // 世界尺度: 横向 1px ≈ 0.55 单位（贺兰山约 60km 宽 → 全域 ~240 单位）
  const scaleXZ = 0.55;
  const planeW = (w - 1) * scaleXZ;
  const planeH = (h - 1) * scaleXZ;
  // 垂直换算：全域宽约 60km → 1 单位 ≈ 0.109 km ≈ 109 m；
  // 真实比例应为 1m ≈ 1/109 单位 ≈ 0.0092，太扁，故乘夸张系数
  const yScale = 0.0092 * 6 * VERTICAL_EXAGGERATION; // 约 6 倍真实比例后仍显立体

  const geo = new THREE.PlaneGeometry(planeW, planeH, w - 1, h - 1);
  geo.rotateX(-Math.PI / 2);      // XZ 平面，+Y 朝上
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  // PlaneGeometry 顶点顺序: 从左上到右下逐行（rotateX 后 z 从 -planeH/2 → +planeH/2）
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const e = heights[idx];
      const t = (e - emin) / span;
      // 顶点 y
      pos.setY(idx, (e - emin) * yScale);
      // 顶点色
      const c = hypsoColor(t);
      colors[idx * 3 + 0] = c[0] / 255;
      colors[idx * 3 + 1] = c[1] / 255;
      colors[idx * 3 + 2] = c[2] / 255;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.02,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0;

  // 等高线组（默认隐藏）—— 行/列方向按"相邻格元交叉"成对生成线段
  const contourMat = new THREE.LineBasicMaterial({ color:0xfff6d8, transparent: true, opacity: 0.35 });
  const contourGroup = new THREE.Group();
  {
    const levels = 24;
    const ex = i => (i / (w - 1) - 0.5) * planeW;   // x 坐标
    const ez = j => (j / (h - 1) - 0.5) * planeH;   // z 坐标
    const ey = lv => (lv - emin) * yScale;
    for (let li = 1; li < levels; li++) {
      const lv = emin + (span * li) / levels;
      const pts = [];
      // 水平方向（沿 x）：对每个 (j, i)-(j, i+1) 边
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = heights[j * w + i], b = heights[j * w + i + 1];
          if ((a - lv) * (b - lv) < 0) {
            const k = (lv - a) / (b - a);
            const y = ey(lv);
            pts.push(new THREE.Vector3(ex(i + k), y, ez(j)));
            pts.push(new THREE.Vector3(ex(i + k), y, ez(j))); // 同点成对（点状等高线）
          }
        }
      }
      // 垂直方向（沿 z）：对每个 (j, i)-(j+1, i) 边
      for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w; i++) {
          const a = heights[j * w + i], b = heights[(j + 1) * w + i];
          if ((a - lv) * (b - lv) < 0) {
            const k = (lv - a) / (b - a);
            const y = ey(lv);
            pts.push(new THREE.Vector3(ex(i), y, ez(j + k)));
            pts.push(new THREE.Vector3(ex(i), y, ez(j + k)));
          }
        }
      }
      if (pts.length > 1) {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        contourGroup.add(new THREE.LineSegments(g, contourMat));
      }
    }
  }
  contourGroup.visible = false;

  // 裙边：四周垂直壁 + 底面，让地形看起来是"实体块"而非纸片
  let skirtMesh;
  {
    const skirtPts = [];
    const base = -12;
    const edge = (i, j) => new THREE.Vector3(
      ex2(i), (heights[j * w + i] - emin) * yScale, ez2(j)
    );
    function ex2(i) { return (i / (w - 1) - 0.5) * planeW; }
    function ez2(j) { return (j / (h - 1) - 0.5) * planeH; }

    const pushQuad = (a, b) => {   // 两顶点构成的竖直条带
      skirtPts.push(a.x, a.y, a.z, b.x, b.y, b.z, a.x, base, a.z);
      skirtPts.push(b.x, b.y, b.z, b.x, base, b.z, a.x, base, a.z);
    };
    for (let i = 0; i < w - 1; i++) {                 // 前后边
      pushQuad(edge(i, 0), edge(i + 1, 0));
      pushQuad(edge(i + 1, h - 1), edge(i, h - 1));
    }
    for (let j = 0; j < h - 1; j++) {                 // 左右边
      pushQuad(edge(w - 1, j + 1), edge(w - 1, j));
      pushQuad(edge(0, j), edge(0, j + 1));
    }
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPts), 3));
    skirtGeo.computeVertexNormals();
    const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({
      color: 0x4a4034, roughness: 1.0, metalness: 0,
      side: THREE.DoubleSide,
    }));
    skirtMesh = skirt;
  }

  const group = new THREE.Group();
  group.add(mesh);
  group.add(contourGroup);
  group.add(skirtMesh);
  return { group, mesh, contourGroup, planeW, planeH };
}

/* ---------- 启动 ---------- */
const statsEl = document.getElementById('stats');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');

loadHeightmap()
  .then(data => {
    console.log('[helan] heightmap ok', data.w, data.h);
    const t0 = performance.now();
    const { group, contourGroup, planeW } = buildTerrain(data);
    console.log('[helan] terrain built in', Math.round(performance.now() - t0), 'ms');
    scene.add(group);

    // 简单底座：地形下方一个渐隐裙边，避免“纸片”感
    statsEl.innerHTML =
      `范围 105.55°–106.15°E · 38.15°–39.35°N<br>` +
      `高程 ${Math.round(data.emin)} – ${Math.round(data.emax)} m<br>` +
      `格网 ${data.w} × ${data.h} · SRTM 30m<br>` +
      `数据 NASA SRTM / AWS Terrain Tiles`;

    loadingEl.classList.add('hide');

    // 交互
    const btnRotate = document.getElementById('btnRotate');
    const btnWire = document.getElementById('btnWire');
    const btnContour = document.getElementById('btnContour');
    const btnReset = document.getElementById('btnReset');

    btnRotate.onclick = () => {
      autoRotate = !autoRotate;
      controls.autoRotate = autoRotate;
      btnRotate.classList.toggle('on', autoRotate);
    };
    btnWire.onclick = () => {
      const m = scene.children.find(c => c.isGroup);
      const mesh = m?.children.find(c => c.isMesh);
      if (mesh) mesh.material.wireframe = !mesh.material.wireframe;
      btnWire.classList.toggle('on');
    };
    btnContour.onclick = () => {
      showContour = !showContour;
      contourGroup.visible = showContour;
      btnContour.classList.toggle('on', showContour);
    };
    btnReset.onclick = () => {
      camera.position.set(320, 300, 520);
      controls.target.set(0, 60, 0);
    };
  })
  .catch(err => {
    loadingText.innerHTML = `<span class="err">加载失败: ${err.message}\n\n请确认通过本地 HTTP 服务访问（如 python -m http.server），\n直接双击 index.html 会因 CORS 无法读取数据文件。</span>`;
    console.error(err);
  });

/* 渲染循环 */
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
