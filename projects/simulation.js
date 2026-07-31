import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ---------------------------------------------------------------------------
// Seedable RNG.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let SEED = 1234;
let rand = mulberry32(SEED);

// ---------------------------------------------------------------------------
// Scene / camera / renderer.
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
// Fallback color behind/beyond the sky dome (matches its zenith color) —
// the dome below is what actually shows under normal use.
scene.background = new THREE.Color(0x8fc7f0);

// ---------------------------------------------------------------------------
// Sky dome — a large inverted sphere with a vertex-color gradient. Daytime
// look: a clear mid-blue at the zenith fading to a pale, slightly hazy blue
// near the horizon (the usual "sky gets lighter near the ground" effect).
// Procedural on purpose: no external texture/cubemap assets needed, and
// it's cheap to render (one big sphere, BackSide only).
// ---------------------------------------------------------------------------
function buildSkyDome(radius) {
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const zenith  = new THREE.Color(0x3d8ede); // clear mid-blue overhead
    const horizon = new THREE.Color(0xcfeafc); // pale hazy blue near the ground
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        const t = THREE.MathUtils.clamp(pos.getY(i) / radius * 0.5 + 0.5, 0, 1); // 0 bottom, 1 top
        tmp.copy(horizon).lerp(zenith, Math.pow(t, 0.45)); // wider horizon band
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    return mesh;
}
scene.add(buildSkyDome(70));

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 150);
camera.position.set(0, 10, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 5, 0);
controls.maxDistance = 55; // stay inside the sky dome (radius 70)
controls.update();

// Daytime lighting — bright sky-tint fill + a strong "sun" directional light.
// (Previously dimmed for a night look; the leaders' own point lights still
// work the same, they're just less visually dominant now that the scene
// itself is lit.)
scene.add(new THREE.HemisphereLight(0xaed4ff, 0x6b5847, 1.0));
const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.1);
dirLight.position.set(10, 20, 8);
scene.add(dirLight);




// ---------------------------------------------------------------------------
// Leader marker.
// ---------------------------------------------------------------------------
// A leader is now a literal light source: an unlit bright core (so it reads
// as glowing regardless of scene lighting) + a real PointLight so it
// actually illuminates nearby bugs + a soft additive halo mesh to fake
// bloom, since there's no post-processing pipeline here.
function makeLeaderLightMesh(coreColor, lightColor) {
    const group = new THREE.Group();

    const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 16, 16),
        new THREE.MeshBasicMaterial({ color: coreColor })
    );
    group.add(core);

    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.75, 16, 16),
        new THREE.MeshBasicMaterial({
            color: lightColor,
            transparent: true,
            opacity: 0.35,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
    group.add(halo);

    const light = new THREE.PointLight(lightColor, 600, 100, 2);
    group.add(light);

    group.visible = false;
    scene.add(group);
    return group;
}

const leaderMesh = makeLeaderLightMesh(0xfff2cc, 0xffaa33);

// Second leader, used only in "asymmetric neural" mode. Identical
// random-walk behavior to leaderMesh, just visually distinct (red/orange).
const leaderMesh2 = makeLeaderLightMesh(0xffe0cc, 0xff5533);

// ---------------------------------------------------------------------------
// Spheres — COUNT must match N used in training (N_NETS * GROUP_SIZE) so
// group indices line up with the exported per-network weights. GROUP_SIZE
// mirrors GROUP_SIZE in train_cohesion.py: every GROUP_SIZE spheres share
// one network. Colored per-group so you can visually confirm the grouping
// (e.g. does group 3 behave differently from group 7).
//
// Declared early (before the GUI/variant-loading section below) since both
// the variant weight loader and the sphere/color setup need N_NETS and
// GROUP_SIZE.
// ---------------------------------------------------------------------------
const COUNT = 40;       // matches train_cohesion2.py's N = N_NETS * GROUP_SIZE
const GROUP_SIZE = 4;   // matches train_cohesion2.py's GROUP_SIZE
const N_NETS = COUNT / GROUP_SIZE;
// ---------------------------------------------------------------------------
// Bug model — loaded from models/bug.glb instead of built procedurally.
// Handles both single-mesh and multi-part (e.g. separate body/wing meshes,
// possibly with different materials) models: everything gets merged into
// one geometry so the whole swarm still renders in one InstancedMesh draw
// call, with per-part materials preserved as geometry groups if there was
// more than one.
// ---------------------------------------------------------------------------

// If your bug faces the wrong way once it's loaded (e.g. sideways or
// backwards relative to its direction of travel), that's almost certainly
// an authoring-convention mismatch, not a bug in this code — adjust
// BUG_MODEL_FORWARD to whichever local axis the model was modeled facing
// down (try (0,0,-1) or (1,0,0) etc.), or add a fixed correction via
// BUG_MODEL_FIXUP (e.g. new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0))
// to flip it 180° on Y).
const BUG_MODEL_FORWARD = new THREE.Vector3(0, 0, -1);
const BUG_MODEL_FIXUP = new THREE.Quaternion(); // identity by default

// Optional: if the loaded material is a MeshStandardMaterial (glTF's
// default), upgrade it to MeshPhysicalMaterial and add the same iridescent
// "beetle shell" coat used previously, so switching to a real model doesn't
// lose that look. Materials that already declare KHR_materials_iridescence
// in the file (which GLTFLoader auto-upgrades to MeshPhysicalMaterial) are
// left alone so the artist's authored settings win. Set to false to use
// the model's materials completely as-authored.
const ADD_IRIDESCENCE_TO_MODEL = true;
function maybeUpgradeToIridescent(mat) {
    if (!ADD_IRIDESCENCE_TO_MODEL) return mat;
    if (mat.isMeshPhysicalMaterial) return mat; // already has whatever the file specified
    if (!mat.isMeshStandardMaterial) return mat; // Basic/Lambert/etc. — leave as-is

    // NOTE: MeshPhysicalMaterial.copy(source) assumes `source` already has
    // physical-only fields (clearcoatNormalScale, sheenColor, etc.) and
    // throws if it doesn't — which a plain MeshStandardMaterial (glTF's
    // default) never does. Passing the fields in via the constructor
    // instead only assigns what's actually present, so it's safe here.
    const physical = new THREE.MeshPhysicalMaterial({
        name: mat.name,
        color: mat.color,
        map: mat.map,
        normalMap: mat.normalMap,
        normalScale: mat.normalScale ? mat.normalScale.clone() : undefined,
        roughness: mat.roughness,
        roughnessMap: mat.roughnessMap,
        metalness: mat.metalness,
        metalnessMap: mat.metalnessMap,
        emissive: mat.emissive,
        emissiveMap: mat.emissiveMap,
        emissiveIntensity: mat.emissiveIntensity,
        aoMap: mat.aoMap,
        aoMapIntensity: mat.aoMapIntensity,
        alphaMap: mat.alphaMap,
        transparent: mat.transparent,
        opacity: mat.opacity,
        alphaTest: mat.alphaTest,
        side: mat.side,
        vertexColors: mat.vertexColors,
        flatShading: mat.flatShading,
        envMap: mat.envMap,
        envMapIntensity: mat.envMapIntensity,
    });
    physical.iridescence = 1;
    physical.iridescenceIOR = 1.3;
    physical.iridescenceThicknessRange = [100, 400];
    return physical;
}

async function loadBugModel(url, targetRadius) {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);

    const meshes = [];
    gltf.scene.traverse((obj) => { if (obj.isMesh) meshes.push(obj); });
    if (meshes.length === 0) throw new Error(`${url} contains no mesh`);

    const geoms = [];
    const materials = [];
    for (const m of meshes) {
        const g = m.geometry.toNonIndexed().clone();
        g.applyMatrix4(m.matrixWorld); // bake this mesh's place in the scene hierarchy in
        geoms.push(g);
        materials.push(maybeUpgradeToIridescent(Array.isArray(m.material) ? m.material[0] : m.material));
    }

    // useGroups=true keeps each part's material assignment intact when there's
    // more than one; with a single mesh this just passes it through.
    const merged = meshes.length === 1 ? geoms[0] : mergeGeometries(geoms, true);

    // Recenter + rescale so the model behaves like the old procedural bug did
    // for collision radius (SPHERE_RADIUS below) and framing, regardless of
    // whatever units/scale it was authored in.
    merged.computeBoundingSphere();
    const bs = merged.boundingSphere;
    if (bs) {
        merged.translate(-bs.center.x, -bs.center.y, -bs.center.z);
        const scale = bs.radius > 1e-6 ? targetRadius / bs.radius : 1;
        merged.scale(scale, scale, scale);
    }
    if (!merged.attributes.normal) merged.computeVertexNormals();

    return { geometry: merged, material: meshes.length === 1 ? materials[0] : materials };
}

const SPHERE_RADIUS   = 0.5; // still used as the collision radius below, and as the model's target size
const SPHERE_DIAMETER = SPHERE_RADIUS * 2;

const bug = await loadBugModel("models/bug.glb", SPHERE_RADIUS);
const sphereGeo = bug.geometry;
const sphereMat = bug.material; // single material or an array (one per geometry group)

const instancedMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, COUNT);
instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
// Per-instance color by group, only meaningful/visible in neural mode but
// harmless to set unconditionally. Tints whatever base color the model's
// material has — works with instancing regardless of vertexColors, but
// won't do much for unlit/Basic materials.
{
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
        const g = Math.floor(i / GROUP_SIZE);
        c.setHSL(0.45 + (g / N_NETS) * 0.35, 0.7, 0.45); // ~cyan through violet
        colorAttr.setXYZ(i, c.r, c.g, c.b);
    }
    instancedMesh.instanceColor = colorAttr;
}
scene.add(instancedMesh);

// ---------------------------------------------------------------------------
// Trained policy weights.
//
// Each variant's files live under its own folder, matching the training
// script's EXPORT_DIR_NAMES: individual/, shared/, mixed/. Each folder has
// N_NETS files (cohesion_net_0.json .. cohesion_net_{N_NETS-1}.json).
// ---------------------------------------------------------------------------
async function loadWeights(path) {
    const res = await fetch(`${path}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    const weights = await res.json();
    console.log("loaded weights meta:", path, weights.meta);
    // runs2/ (asymmetric-neural) nets observe BOTH leaders (own-leader rel +
    // other-leader rel), same as the single-leader runs/ nets plus one more
    // 3-float leader-relative block: velocity(3) + K*3 neighbors +
    // own_leader(3) + other_leader(3). NOTE: train_cohesion2.py's
    // compute_obs does NOT include crowd_a/crowd_b -- the crowd counts only
    // feed into compute_reward's divisor server-side, they were never added
    // as an observation feature -- so there's no "+2" here.
    const expectedObsDim = path.startsWith("runs2/") ? 3 + 3 * 5 + 3 + 3 : 3 + 3 * 5 + 3;
    console.assert(weights.meta.obs_dim === expectedObsDim, "obs_dim mismatch — wrong file or stale export?");
    console.assert(weights.meta.act_dim === 4, "act_dim mismatch");
    return weights;
}

const VARIANTS = ["individual", "shared", "mixed"];
const weightsByVariant = {};
const weightsByVariant2 = {}; // asymmetric-neural weights, loaded from runs2/ --
                                // matches train_cohesion2.py's default --out_dir.
                                // If you train with a different --out_dir, update
                                // the path below (and the expectedObsDim check
                                // above, which keys off this same prefix) to match.

for (const variant of VARIANTS) {
    const files = [];
    const files2 = [];
    for (let g = 0; g < N_NETS; g++) {
        files.push(await loadWeights(`runs/${variant}/cohesion_net_${g}.json`));
        files2.push(await loadWeights(`runs2/${variant}/cohesion_net_${g}.json`));
    }
    weightsByVariant[variant] = files;
    weightsByVariant2[variant] = files2;
}

// Active set the sim reads from — swapped by the GUI dropdown below.
let weightFiles = weightsByVariant["individual"];

// ---------------------------------------------------------------------------
// GUI.
// ---------------------------------------------------------------------------
const gui = new GUI();
const flockParams = {
    separationRadius: 2.0,
    neighborRadius:   4.0,
    separation: 0.02,
    alignment:  0.05,
    cohesion:   0.005,
    maxSpeed:   0.05,
    BOUNDS:     15,
};
const modeParams = { mode: "ruleBased" }; // "ruleBased" | "neural" | "asymmetricNeural"

const modeController = gui.add(modeParams, "mode", ["ruleBased", "neural", "asymmetricNeural"]).name("mode");
modeController.onChange((val) => {
    const isNeural = (val === "neural" || val === "asymmetricNeural");
    leaderMesh.visible = isNeural;
    leaderMesh2.visible = (val === "asymmetricNeural");
    flockFolder.domElement.style.opacity = isNeural ? 0.4 : 1.0;
    variantController.domElement.style.opacity = isNeural ? 1.0 : 0.4;
    // switch which weight set the variant dropdown is pointing at
    const source = (val === "asymmetricNeural") ? weightsByVariant2 : weightsByVariant;
    weightFiles = source[variantParams.variant];
});

const flockFolder = gui.addFolder("flocking (rule-based mode only)");
flockFolder.add(flockParams, "separationRadius", 0, 10, 0.1);
flockFolder.add(flockParams, "neighborRadius",   0, 10, 0.1);
flockFolder.add(flockParams, "separation", 0, 0.2, 0.001);
flockFolder.add(flockParams, "alignment",  0, 0.2, 0.001);
flockFolder.add(flockParams, "cohesion",   0, 0.05, 0.0001);
flockFolder.add(flockParams, "maxSpeed",   0, 0.2, 0.001);
flockFolder.open();

// Policy variant — only meaningful in neural mode, dimmed otherwise (see
// modeController.onChange above).
const variantParams = { variant: "individual" };
const variantController = gui.add(variantParams, "variant", VARIANTS).name("policy variant");
variantController.onChange((v) => {
    const source = (modeParams.mode === "asymmetricNeural") ? weightsByVariant2 : weightsByVariant;
    weightFiles = source[v];
});
variantController.domElement.style.opacity = 0.4; // starts dimmed: default mode is ruleBased

const trailParams = { trails: false };
gui.add(trailParams, "trails").name("afterimage trails").onChange((enabled) => {
    trailMeshes.forEach((m) => (m.visible = enabled));
});

gui.add({ reset: () => resetSimulation() }, "reset");



// ---------------------------------------------------------------------------
// Sim config.
// ---------------------------------------------------------------------------
const FIXED_DT    = 1 / 60;
const SUBSTEP_CAP = 5;

// ---------------------------------------------------------------------------
// Afterimage trails.
// ---------------------------------------------------------------------------
const TRAIL_LAYERS    = 30;   // number of ghost layers — more = smoother trail
const TRAIL_MAX_DELAY = 90;   // how many steps back the oldest ghost reaches
const TRAIL_MIN_SCALE = 0.1; // scale of the oldest/farthest ghost
const TRAIL_MAX_SCALE = 0.9;  // scale of the newest ghost
const TRAIL_MIN_OPACITY = 0.02;
const TRAIL_MAX_OPACITY = 0.3;

const HISTORY_LEN = TRAIL_MAX_DELAY + 4; // must cover the deepest trail sample

const historyBuffer = [];
for (let h = 0; h < HISTORY_LEN; h++) historyBuffer.push(new Float32Array(COUNT * 3));
let historyHead = 0;

// Build one InstancedMesh per trail layer instead of two hardcoded ones.
const trailConfigs = [];
for (let t = 1; t <= TRAIL_LAYERS; t++) {
    const f = t / TRAIL_LAYERS; // 0 (closest/newest) .. 1 (farthest/oldest)
    trailConfigs.push({
        delay:   Math.round(THREE.MathUtils.lerp(1, TRAIL_MAX_DELAY, f)),
        scale:   THREE.MathUtils.lerp(TRAIL_MAX_SCALE, TRAIL_MIN_SCALE, f),
        opacity: THREE.MathUtils.lerp(TRAIL_MAX_OPACITY, TRAIL_MIN_OPACITY, f),
    });
}

const trailMeshes = trailConfigs.map((cfg) => {
    const mat = new THREE.MeshPhongMaterial({
        color: 0x66aacc,
        transparent: true,
        opacity: cfg.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // optional: makes overlaps glow instead of muddying
    });
    const mesh = new THREE.InstancedMesh(sphereGeo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
});

function recordHistory() {
    const snap = historyBuffer[historyHead];
    for (let i = 0; i < COUNT; i++) {
        const p = boids[i].position;
        snap[i * 3] = p.x; snap[i * 3 + 1] = p.y; snap[i * 3 + 2] = p.z;
    }
    historyHead = (historyHead + 1) % HISTORY_LEN;
}

function syncTrailInstances() {
    dummy.quaternion.identity();
    for (let layer = 0; layer < trailConfigs.length; layer++) {
        const cfg = trailConfigs[layer];
        const mesh = trailMeshes[layer];
        const idx = (historyHead - 1 - cfg.delay + HISTORY_LEN * 2) % HISTORY_LEN;
        const snap = historyBuffer[idx];

        dummy.scale.setScalar(cfg.scale);
        for (let i = 0; i < COUNT; i++) {
            dummy.position.set(snap[i * 3], snap[i * 3 + 1], snap[i * 3 + 2]);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }
    dummy.scale.setScalar(1);
}

// ---------------------------------------------------------------------------
// Scratch objects.
// ---------------------------------------------------------------------------
const _sep    = new THREE.Vector3();
const _ali    = new THREE.Vector3();
const _coh    = new THREE.Vector3();
const _diff   = new THREE.Vector3();
const _relVel = new THREE.Vector3();
const dummy   = new THREE.Object3D();

const grid = new Map();
function cellKey(x, y, z) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
}

const collisionGrid = new Map();
function buildCollisionGrid(invCell) {
    collisionGrid.clear();
    for (let i = 0; i < COUNT; i++) {
        const p = boids[i].position;
        const k = cellKey(Math.floor(p.x * invCell), Math.floor(p.y * invCell), Math.floor(p.z * invCell));
        let cell = collisionGrid.get(k);
        if (!cell) { cell = []; collisionGrid.set(k, cell); }
        cell.push(i);
    }
}

function resolveCollisions() {
    const invCell = 1 / SPHERE_DIAMETER;
    buildCollisionGrid(invCell);

    for (let i = 0; i < COUNT; i++) {
        const bi = boids[i];
        const cx = Math.floor(bi.position.x * invCell);
        const cy = Math.floor(bi.position.y * invCell);
        const cz = Math.floor(bi.position.z * invCell);

        for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
        for (let oz = -1; oz <= 1; oz++) {
            const cell = collisionGrid.get(cellKey(cx + ox, cy + oy, cz + oz));
            if (!cell) continue;
            for (let n = 0; n < cell.length; n++) {
                const j = cell[n];
                if (j <= i) continue;
                const bj = boids[j];

                _diff.copy(bi.position).sub(bj.position);
                const distSq = _diff.lengthSq();
                if (distSq >= SPHERE_DIAMETER * SPHERE_DIAMETER) continue;

                const dist = Math.sqrt(distSq) || 1e-6;
                _diff.multiplyScalar(1 / dist);
                const overlap = SPHERE_DIAMETER - dist;

                bi.position.addScaledVector(_diff, overlap * 0.5);
                bj.position.addScaledVector(_diff, -overlap * 0.5);

                _relVel.copy(bi.velocity).sub(bj.velocity);
                const closingSpeed = _relVel.dot(_diff);
                if (closingSpeed < 0) {
                    bi.velocity.addScaledVector(_diff, -0.5 * closingSpeed);
                    bj.velocity.addScaledVector(_diff,  0.5 * closingSpeed);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Flock state + reset.
// ---------------------------------------------------------------------------
const boids = [];
let simStep = 0;

// Leader state — random-walk, mirrors gen_leader_traj() in training:
// accel-limited + speed-clamped, wraps through bounds. Not seeded off the
// same RNG stream as boid spawns (uses Math.random()) since exact leader
// path reproducibility isn't important — the policy is trained to react to
// *any* random-walking leader, not one specific path.
const leaderPos = new THREE.Vector3();
const leaderVel = new THREE.Vector3();
// Second leader — only stepped/used in "asymmetric neural" mode.
const leaderPos2 = new THREE.Vector3();
const leaderVel2 = new THREE.Vector3();
const LEADER_SPEED_MAX = 0.015;
const LEADER_ACCEL_STD = 0.002;

function resetLeader() {
    leaderPos.set(
        (Math.random() * 2 - 1) * 4.0,   // match training's uniform(-4, 4)
        2 + Math.random() * (flockParams.BOUNDS - 2),
        (Math.random() * 2 - 1) * 4.0
    );
    leaderVel.set(0, 0, 0);

    leaderPos2.set(
        (Math.random() * 2 - 1) * 4.0,
        2 + Math.random() * (flockParams.BOUNDS - 2),
        (Math.random() * 2 - 1) * 4.0
    );
    leaderVel2.set(0, 0, 0);
}

// Bounces a position/velocity pair off a hard wall at [lo, hi] instead of
// wrapping — used for all three axes now that the world has solid bounds.
// (Previously this only handled Y; X/Z used to teleport-wrap instead.)
function reflectAxis(x, v, lo, hi) {
    const period = 2 * (hi - lo);
    let xShifted = ((x - lo) % period + period) % period; // JS-safe mod
    const folded = xShifted > (hi - lo);
    const newX = (folded ? period - xShifted : xShifted) + lo;
    const newV = folded ? -v : v;
    return [newX, newV];
}


// Generic — used for both leaders so behavior stays identical, just fed
// different position/velocity vectors.
function stepLeaderGeneric(pos, vel, B, minY) {
    vel.x += (Math.random() * 2 - 1) * LEADER_ACCEL_STD;
    vel.y += (Math.random() * 2 - 1) * LEADER_ACCEL_STD;
    vel.z += (Math.random() * 2 - 1) * LEADER_ACCEL_STD;
    const speed = vel.length();
    if (speed > LEADER_SPEED_MAX) vel.multiplyScalar(LEADER_SPEED_MAX / speed);

    pos.add(vel);

    let r;
    r = reflectAxis(pos.x, vel.x, -B, B); pos.x = r[0]; vel.x = r[1];
    r = reflectAxis(pos.z, vel.z, -B, B); pos.z = r[0]; vel.z = r[1];
    r = reflectAxis(pos.y, vel.y, minY, B); pos.y = r[0]; vel.y = r[1];
}

function stepLeader(B, minY) { stepLeaderGeneric(leaderPos, leaderVel, B, minY); }

function resetSimulation() {
    rand = mulberry32(SEED);
    boids.length = 0;
    for (let i = 0; i < COUNT; i++) {
        boids.push({
            position: new THREE.Vector3(
                (rand() - 0.5) * 20,
                rand() * 5 + 2,
                (rand() - 0.5) * 20
            ),
            velocity: new THREE.Vector3(
                (rand() - 0.5) * 0.05,
                (rand() - 0.5) * 0.05,
                (rand() - 0.5) * 0.05
            ),
        });
    }
    simStep = 0;
    resetLeader();

    for (let h = 0; h < HISTORY_LEN; h++) {
        const snap = historyBuffer[h];
        for (let i = 0; i < COUNT; i++) {
            snap[i * 3] = boids[i].position.x;
            snap[i * 3 + 1] = boids[i].position.y;
            snap[i * 3 + 2] = boids[i].position.z;
        }
    }
    historyHead = 0;
}
resetSimulation();

// ---------------------------------------------------------------------------
// RULE-BASED PHYSICS.
// ---------------------------------------------------------------------------
function buildGrid(invCell) {
    grid.clear();
    for (let i = 0; i < COUNT; i++) {
        const p = boids[i].position;
        const k = cellKey(Math.floor(p.x * invCell), Math.floor(p.y * invCell), Math.floor(p.z * invCell));
        let cell = grid.get(k);
        if (!cell) { cell = []; grid.set(k, cell); }
        cell.push(i);
    }
}

function stepSimulationRuleBased(dt) {
    const p = flockParams;
    const cellSize = Math.max(p.separationRadius, p.neighborRadius, 1e-4);
    const invCell  = 1 / cellSize;
    buildGrid(invCell);

    for (let i = 0; i < COUNT; i++) {
        const boid = boids[i];

        _sep.set(0, 0, 0);
        _ali.set(0, 0, 0);
        _coh.set(0, 0, 0);
        let neighborCount = 0;

        const cx = Math.floor(boid.position.x * invCell);
        const cy = Math.floor(boid.position.y * invCell);
        const cz = Math.floor(boid.position.z * invCell);

        for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
        for (let oz = -1; oz <= 1; oz++) {
            const cell = grid.get(cellKey(cx + ox, cy + oy, cz + oz));
            if (!cell) continue;
            for (let n = 0; n < cell.length; n++) {
                const j = cell[n];
                if (j === i) continue;
                const other = boids[j];
                _diff.copy(boid.position).sub(other.position);
                const distSq = _diff.lengthSq();
                if (distSq === 0) continue;
                const dist = Math.sqrt(distSq);

                if (dist < p.separationRadius) {
                    _sep.addScaledVector(_diff, 1 / distSq);
                }
                if (dist < p.neighborRadius) {
                    _ali.add(other.velocity);
                    _coh.add(other.position);
                    neighborCount++;
                }
            }
        }

        if (neighborCount > 0) {
            _ali.divideScalar(neighborCount).sub(boid.velocity);
            _coh.divideScalar(neighborCount).sub(boid.position);
        }

        boid.velocity
            .addScaledVector(_sep, p.separation)
            .addScaledVector(_ali, p.alignment)
            .addScaledVector(_coh, p.cohesion);

        const speed = boid.velocity.length();
        if (speed > p.maxSpeed) boid.velocity.multiplyScalar(p.maxSpeed / speed);

        boid.position.add(boid.velocity);

        const B = p.BOUNDS;
        let r;
        r = reflectAxis(boid.position.x, boid.velocity.x, -B, B); boid.position.x = r[0]; boid.velocity.x = r[1];
        r = reflectAxis(boid.position.z, boid.velocity.z, -B, B); boid.position.z = r[0]; boid.velocity.z = r[1];
        r = reflectAxis(boid.position.y, boid.velocity.y, 2, B); boid.position.y = r[0]; boid.velocity.y = r[1];
    }
}

// ---------------------------------------------------------------------------
// NEURAL PHYSICS — N_NETS independent networks, one per boid group. The
// active `weightFiles` array is swapped by the "policy variant" GUI dropdown
// (individual / shared / mixed) above; everything below just reads whatever
// is currently assigned to it, so switching variants live requires no
// changes here.
// ---------------------------------------------------------------------------
function forwardActor(layers, x) {
    let a = x;
    for (let li = 0; li < layers.length; li++) {
        const { w, b } = layers[li];
        const outDim = b.length, inDim = w[0].length;
        const out = new Float32Array(outDim);
        for (let o = 0; o < outDim; o++) {
            let sum = b[o];
            const row = w[o];
            for (let i = 0; i < inDim; i++) sum += row[i] * a[i];
            out[o] = sum;
        }
        const isLast = li === layers.length - 1;
        for (let o = 0; o < outDim; o++) out[o] = isLast ? Math.tanh(out[o]) : Math.max(0, out[o]);
        a = out;
    }
    return a;
}

function sampleGaussian() {
    // Box-Muller
    const u1 = Math.random(), u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function policyAction(i, obs) {
    const g = Math.floor(i / GROUP_SIZE);
    const meanAction = forwardActor(weightFiles[g].actor, obs);
    const STD = 0.37; // match final training log_std
    for (let k = 0; k < meanAction.length; k++) {
        meanAction[k] = Math.max(-1.5, Math.min(1.5, meanAction[k] + sampleGaussian() * STD));
    }
    return meanAction;
}

// NOTE: this used to be a wrap-aware minimum-image delta (mirroring
// wrapped_delta() in training) because the world wrapped through its
// bounds. Now that walls bounce instead of wrapping, plain differences are
// the physically correct thing to feed the network — with wrapping removed,
// treating two boids near opposite walls as "close" (which wrapping did)
// would be wrong, since they're no longer actually adjacent through a
// seam. Heads up: this does mean the network's observations near the walls
// now differ from what it saw during training (which assumed a toroidal
// world), so behavior right at the edges of the arena may look slightly
// different than it did before. In practice this should rarely matter
// since boids spend most of their time well inside the bounds.
function findKNearest(i, k) {
    const bi = boids[i].position;
    const out = [];
    for (let j = 0; j < COUNT; j++) {
        if (j === i) continue;
        const p = boids[j].position;
        const dx = p.x - bi.x;
        const dy = p.y - bi.y;
        const dz = p.z - bi.z;
        out.push({ d2: dx * dx + dy * dy + dz * dz, dx, dy, dz });
    }

    out.sort((a, b) => a.d2 - b.d2);
    return out.slice(0, k);
}

// `leaders` is an ordered array of leader positions ({x,y,z}) — one entry
// for single-leader "neural" mode, two for "asymmetricNeural" (own leader
// first, other leader second — must match build_leader_own_other() /
// compute_obs() ordering in train_cohesion.py, or the policy will read
// garbage). obs_dim from meta grows automatically with leaders.length since
// the Float32Array is sized from it directly.
const CROWD_RADIUS = 6.0;
const FAIR_SHARE = COUNT / 2; // 50 -- matches training's N/2

function computeCrowdCounts(leaders, m) {
    // Only meaningful in asymmetric mode (two leaders). Returns
    // {countA, countB} — global counts, same for every boid this frame.
    if (leaders.length < 2) return { countA: 0, countB: 0 };

    let countA = 0, countB = 0;
    for (let i = 0; i < COUNT; i++) {
        const p = boids[i].position;
        const distA = Math.hypot(leaders[0].x - p.x, leaders[0].y - p.y, leaders[0].z - p.z);
        const distB = Math.hypot(leaders[1].x - p.x, leaders[1].y - p.y, leaders[1].z - p.z);

        // mirrors captured_a / captured_b in training: mutually exclusive,
        // ties go to A
        if (distA < CROWD_RADIUS && distA <= distB) countA++;
        else if (distB < CROWD_RADIUS && distB < distA) countB++;
    }
    return { countA, countB };
}

function buildObservation(i, leaders, m, crowd) {
    const b = boids[i];
    const obs = new Float32Array(m.obs_dim);
    obs[0] = b.velocity.x; obs[1] = b.velocity.y; obs[2] = b.velocity.z;
    let idx = 3;
    for (const nb of findKNearest(i, m.k_neighbors)) {
        obs[idx++] = nb.dx; obs[idx++] = nb.dy; obs[idx++] = nb.dz;
    }

    for (const leader of leaders) {
        obs[idx++] = leader.x - b.position.x;
        obs[idx++] = leader.y - b.position.y;
        obs[idx++] = leader.z - b.position.z;
    }

    // NOTE: no crowd_a/crowd_b fields here -- train_cohesion2.py's
    // compute_obs doesn't give the policy a crowd observation (crowd only
    // affects reward at training time, not what the net can see), so
    // there's nothing to append. `crowd` is accepted but unused here; kept
    // as a param in case you later train a variant whose compute_obs does
    // expose it.
    return obs;
}

function stepSimulationNeural() {
    // Use meta from the first file of the active variant (all exports
    // within a variant share the same meta).
    const m = weightFiles[0].meta;
    const asymmetric = (modeParams.mode === "asymmetricNeural");

    stepLeaderGeneric(leaderPos, leaderVel, m.bounds, m.min_y);
    leaderMesh.position.copy(leaderPos);
    if (asymmetric) {
        stepLeaderGeneric(leaderPos2, leaderVel2, m.bounds, m.min_y);
        leaderMesh2.position.copy(leaderPos2);
    }

    const leaders = asymmetric ? [leaderPos, leaderPos2] : [leaderPos];
    const crowd = computeCrowdCounts(leaders, m);   // <-- once per frame

    const nextVel = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        const b = boids[i];
        const action = policyAction(i, buildObservation(i, leaders, m, crowd));
        // Even groups' "own" leader is leader 1 (white), odd groups' own is
        // leader 2 (red) — matches LEADER_ID in training. In asymmetric
        // mode every boid observes BOTH leaders (own first, other second);
        // in plain neural mode there's only ever leader 1.
        const g = Math.floor(i / GROUP_SIZE);

        const speed = b.velocity.length() || 1e-6;
        let dx = b.velocity.x / speed + action[0] * m.rot_scale;
        let dy = b.velocity.y / speed + action[1] * m.rot_scale;
        let dz = b.velocity.z / speed + action[2] * m.rot_scale;
        const dl = Math.hypot(dx, dy, dz) || 1e-6;
        dx /= dl; dy /= dl; dz /= dl;

        let newSpeed = speed + action[3] * m.accel_scale;
        newSpeed = Math.min(Math.max(newSpeed, m.min_speed), m.max_speed);

        nextVel[i] = { x: dx * newSpeed, y: dy * newSpeed, z: dz * newSpeed };
    }

    for (let i = 0; i < COUNT; i++) {
        const b = boids[i];
        b.velocity.set(nextVel[i].x, nextVel[i].y, nextVel[i].z);
        b.position.add(b.velocity);

        const B = m.bounds, minY = m.min_y;
        let r;
        r = reflectAxis(b.position.x, b.velocity.x, -B, B); b.position.x = r[0]; b.velocity.x = r[1];
        r = reflectAxis(b.position.z, b.velocity.z, -B, B); b.position.z = r[0]; b.velocity.z = r[1];
        r = reflectAxis(b.position.y, b.velocity.y, minY, B); b.position.y = r[0]; b.velocity.y = r[1];
    }
    simStep++;
}

// ---------------------------------------------------------------------------
// RENDER SYNC.
// ---------------------------------------------------------------------------
const _bugDir = new THREE.Vector3();
const _bugQuat = new THREE.Quaternion();

// Buzz amplitude — a cheap "alive" pulse (whole-instance Y scale), not
// targeted at any specific part since we don't know the model's internal
// structure the way we did with the old procedural wing planes. Subtle by
// design so it doesn't visibly distort a real model; set to 0 to disable
// entirely if it looks off with your model.
const BUG_BUZZ_AMOUNT = 0.05;

function syncInstances() {
    for (let i = 0; i < COUNT; i++) {
        const b = boids[i];
        dummy.position.copy(b.position);

        const speed = b.velocity.length();
        if (speed > 1e-5) {
            _bugDir.copy(b.velocity).multiplyScalar(1 / speed);
            _bugQuat.setFromUnitVectors(BUG_MODEL_FORWARD, _bugDir);
            dummy.quaternion.copy(_bugQuat).multiply(BUG_MODEL_FIXUP);
        }

        const buzz = 1 + BUG_BUZZ_AMOUNT * Math.sin(simStep * 1.6 + i * 2.3);
        dummy.scale.set(1, buzz, 1);

        dummy.updateMatrix();
        instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Main loop.
// ---------------------------------------------------------------------------
let lastTime = performance.now() / 1000;
let accumulator = 0;

function animate(nowMs) {
    const now = nowMs / 1000;
    let frame = now - lastTime;
    lastTime = now;
    if (frame > 0.25) frame = 0.25;
    accumulator += frame;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < SUBSTEP_CAP) {
        if (modeParams.mode === "neural" || modeParams.mode === "asymmetricNeural") {
            stepSimulationNeural();
        } else {
            stepSimulationRuleBased(FIXED_DT);
            resolveCollisions();
        }
        recordHistory();
        accumulator -= FIXED_DT;
        steps++;
    }

    syncInstances();
    if (trailParams.trails) syncTrailInstances();
    renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
});