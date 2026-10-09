const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Finger tracking feel — tweak these to taste.
//
// Drawing follows a hold, like gripping a pencil: pinch your thumb and index finger together
// to draw, open them and the pencil drops. This is read fresh every frame (not a toggle you
// trigger once) — fingers together draws *now*, fingers apart doesn't, so one bad frame just
// skips a point instead of getting stuck in the wrong state.
const PINCH_HOLD_ON = 0.22;     // thumb–index distance (relative to hand size) below which the fingertips
                                 // count as actually touching and drawing starts — tighter than "close
                                 // together", but with enough room that a real pinch reliably registers
const PINCH_HOLD_OFF = 0.32;    // ...and above which you've let go; the gap avoids flicker right at contact
const HOLD_FRAMES = 2;          // consecutive pinched frames required before drawing starts
const RELEASE_FRAMES = 2;       // consecutive open frames required before drawing stops
const LOST_HAND_MS = 900;       // how long the hand can drop out before the cursor fades/hides
const JUMP_FRACTION = 0.2;      // a jump bigger than this share of the canvas starts a new line
const SMOOTH_MIN_CUTOFF = 0.5;  // lower = steadier when moving slowly (but laggier) — lowered so careful,
                                 // slow tracing (fine details like ears) comes out calm instead of shaky
const SMOOTH_BETA = 0.03;       // higher = less lag when moving fast — raised a bit to compensate, so
                                 // quick strokes still keep up despite the steadier baseline above
const MIN_STEP = 2.5;           // px; smaller movements are ignored to avoid jittery blobs
const EDGE_MARGIN = 0.22;       // fraction of the stage's width/height, from each edge, where hand
                                 // tracking tends to get noisiest — lighting falls off, the hand is
                                 // partly out of frame, the camera's lens distorts more
const EDGE_MAX_DAMPING = 0.75;  // right at an edge/corner, this much of each frame's raw movement is
                                 // held back rather than applied — tapers to 0 (no extra damping) by
                                 // the time the hand is back in the middle of the frame
const STROKE_SMOOTH_POINTS = 3; // while actually moving, the last N points are averaged into each
                                 // plotted point — rounds off small hand-shake zig-zags without
                                 // flattening the shape you're drawing
const STROKE_DWELL_SPAN = 12;   // px; if the last several points haven't ended up far from where they
                                 // started, that's a hint you're basically holding still
const STROKE_DWELL_PATH = 20;   // ...but only if the finger hasn't covered much *total* ground either.
                                 // A tight corner or a small deliberate loop can also end near where it
                                 // started, while your hand travelled the whole way around it — this
                                 // catches that case and refuses to flatten it into a shortcut
const STROKE_DWELL_WINDOW = 6;  // while genuinely dwelling, average over this many points instead of
                                 // STROKE_SMOOTH_POINTS — enough to flatten a wobble into a steady point

const FILL_EMPTY_ALPHA = 24;     // px alpha (out of 255) at or below which a pixel counts as empty
                                  // canvas; fill only ever spreads across pixels this transparent
const FILL_SOLID_TOLERANCE = 10; // how far alpha or color can drift and still count as "the same
                                  // solid fill you clicked on" when refilling with a new color —
                                  // tight on purpose, since a real anti-aliased stroke edge differs
                                  // by far more than this, so it can never get caught up by mistake
const UNDO_LIMIT = 10;
const CANVAS_BG = "#f5f7ff";
const GRID_COLOR = "rgba(10, 31, 214, 0.1)";
const GRID_SIZE = 24;

const stage = document.getElementById("stage");
const video = document.getElementById("video");
const draw = document.getElementById("draw");
const ctx = draw.getContext("2d", { willReadFrequently: true });

// Tracks *where* a brush/eraser stroke has ever been drawn, completely separately from the
// visible drawing's pixel colors. Fill checks this before it checks anything else: a pixel marked
// here is "locked" and can never be touched by the fill tool, no matter how close a color match it
// might otherwise look like (which is what let fill bleed into — and recolor — stroke edges
// before: an anti-aliased edge pixel keeps the stroke's exact color even at low opacity, so
// color-distance matching alone can never fully tell a stroke apart from "empty-ish" space). This
// mask is the one thing that can.
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
const grid = document.getElementById("grid");
const handCursor = document.getElementById("handCursor");
const countdownEl = document.getElementById("countdown");
const photoDialog = document.getElementById("photoDialog");
const photoImg = document.getElementById("photoImg");
const photoDownload = document.getElementById("photoDownload");
const sprite = document.getElementById("sprite");
const spriteImg = document.getElementById("spriteImg");
const spriteHandle = document.getElementById("spriteHandle");
const paintHelp = document.getElementById("paintHelp");

const state = {
  tool: "brush",
  color: "#0016d4",
  size: 14,
  showGrid: true,
};

let dpr = window.devicePixelRatio || 1;
let undoStack = [];
let stroke = null;
let stream = null;
let landmarker = null;
let fingerPaintOn = false;
let trackingPaused = false; // true while the tab is hidden — see the visibilitychange handler below

/* ---------- Canvas sizing ---------- */

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;

  const prev = document.createElement("canvas");
  prev.width = draw.width;
  prev.height = draw.height;
  if (draw.width) prev.getContext("2d").drawImage(draw, 0, 0);

  const prevMask = document.createElement("canvas");
  prevMask.width = maskCanvas.width;
  prevMask.height = maskCanvas.height;
  if (maskCanvas.width) prevMask.getContext("2d").drawImage(maskCanvas, 0, 0);

  dpr = window.devicePixelRatio || 1;
  draw.width = w * dpr;
  draw.height = h * dpr;
  maskCanvas.width = draw.width;
  maskCanvas.height = draw.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(prev, 0, 0, prev.width / dpr, prev.height / dpr);
  maskCtx.drawImage(prevMask, 0, 0, prevMask.width / dpr, prevMask.height / dpr);
  undoStack = [];
}
new ResizeObserver(resize).observe(stage);

/* ---------- Drawing ---------- */

function snapshot() {
  undoStack.push({
    img: ctx.getImageData(0, 0, draw.width, draw.height),
    mask: maskCtx.getImageData(0, 0, draw.width, draw.height),
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  ctx.putImageData(entry.img, 0, 0);
  maskCtx.putImageData(entry.mask, 0, 0);
}

function clearDrawing() {
  snapshot();
  ctx.clearRect(0, 0, draw.width, draw.height);
  maskCtx.clearRect(0, 0, draw.width, draw.height);
}
/* ---------- Placing: pick the beetle up as a sticker to size/position for the photo ---------- */

// Two ways to draw: the mouse/trackpad always works on the canvas, and finger painting
// (camera + hand tracking) is an optional toggle on top of it — these two strings make
// that explicit depending on which one is currently active.
const DRAW_HELP_MOUSE = paintHelp.innerHTML; // captured from the default copy already in the HTML
const DRAW_HELP_CAMERA =
  "Pinch your thumb and index finger together, like you're holding a pencil, to draw. Open them to drop it. Press <strong>space</strong> when you're done drawing, then use the hand tool to pick your beetle up and size it for the photo.";
const PLACE_HELP =
  "Drag your beetle to move it, drag the blue dot to resize it. Click the hand tool again when you're happy, then take the picture.";

// Swaps the help text for whichever input is active, unless we're mid-placement (that copy wins).
function updateDrawHelp() {
  if (placing) return;
  paintHelp.innerHTML = fingerPaintOn ? DRAW_HELP_CAMERA : DRAW_HELP_MOUSE;
}

// Mouse/trackpad and finger paint can't draw at the same time — otherwise a stray mouse
// nudge while you're mid-pinch (or vice versa) draws a line nobody meant to make. Finger
// paint (like placing) takes the canvas's pointer events away from the mouse entirely while
// it's on; turning it off hands control straight back.
function syncCanvasInput() {
  draw.style.pointerEvents = fingerPaintOn || placing ? "none" : "";
}

let placing = false;
const spriteState = { x: 0, y: 0, w: 0, h: 0 };

// Finds the bounding box of everything actually drawn (non-transparent pixels), in CSS px,
// so the sticker starts out fitted to the drawing instead of a big empty square.
function getDrawingBounds() {
  const w = draw.width;
  const h = draw.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 4 * dpr;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return { x: minX / dpr, y: minY / dpr, w: (maxX - minX + 1) / dpr, h: (maxY - minY + 1) / dpr };
}

function applySpriteTransform() {
  sprite.style.left = `${spriteState.x}px`;
  sprite.style.top = `${spriteState.y}px`;
  sprite.style.width = `${spriteState.w}px`;
  sprite.style.height = `${spriteState.h}px`;
}

function enterPlacing() {
  if (placing) return true;
  const bounds = getDrawingBounds();
  if (!bounds) return false; // nothing drawn yet — nothing to pick up

  const crop = document.createElement("canvas");
  crop.width = bounds.w * dpr;
  crop.height = bounds.h * dpr;
  crop
    .getContext("2d")
    .drawImage(draw, bounds.x * dpr, bounds.y * dpr, crop.width, crop.height, 0, 0, crop.width, crop.height);
  spriteImg.src = crop.toDataURL();

  Object.assign(spriteState, bounds);
  applySpriteTransform();
  sprite.hidden = false;

  // The drawing is now the sticker, not a layer on the canvas — clear it so it isn't shown twice,
  // including its lock: picking it up leaves nothing behind that fill should still treat as a
  // stroke.
  snapshot();
  ctx.clearRect(0, 0, draw.width, draw.height);
  maskCtx.clearRect(0, 0, draw.width, draw.height);

  placing = true;
  syncCanvasInput();
  paintHelp.innerHTML = PLACE_HELP;
  return true;
}

function exitPlacing() {
  if (!placing) return;
  if (spriteImg.naturalWidth) {
    ctx.drawImage(spriteImg, spriteState.x, spriteState.y, spriteState.w, spriteState.h);
    // Setting it back down puts real drawn pixels back on the canvas, not empty space — lock them
    // again the same as any other stroke. Drawing the sticker's own alpha onto the mask locks
    // exactly the pixels it actually drew (not its transparent padding).
    maskCtx.drawImage(spriteImg, spriteState.x, spriteState.y, spriteState.w, spriteState.h);
  }
  sprite.hidden = true;
  placing = false;
  syncCanvasInput();
  updateDrawHelp();
}

let spriteDrag = null; // { mode: "move" | "resize", startX, startY, ...spriteState at drag start }

function beginSpriteDrag(e, mode) {
  e.stopPropagation();
  (e.currentTarget).setPointerCapture(e.pointerId);
  spriteDrag = { mode, startX: e.clientX, startY: e.clientY, ...spriteState, ratio: spriteState.w / spriteState.h };
}

sprite.addEventListener("pointerdown", (e) => {
  if (e.target === spriteHandle) return;
  beginSpriteDrag(e, "move");
});
spriteHandle.addEventListener("pointerdown", (e) => beginSpriteDrag(e, "resize"));

addEventListener("pointermove", (e) => {
  if (!spriteDrag) return;
  const dx = e.clientX - spriteDrag.startX;
  const dy = e.clientY - spriteDrag.startY;
  if (spriteDrag.mode === "move") {
    spriteState.x = spriteDrag.x + dx;
    spriteState.y = spriteDrag.y + dy;
  } else {
    const w = Math.max(30, spriteDrag.w + (dx + dy) / 2);
    spriteState.w = w;
    spriteState.h = w / spriteDrag.ratio;
  }
  applySpriteTransform();
});
addEventListener("pointerup", () => (spriteDrag = null));
addEventListener("pointercancel", () => (spriteDrag = null));

// Draws the same path on both the visible canvas and the lock mask, so every brush/eraser stroke
// marks its own pixels as locked the moment it's drawn (and the eraser un-marks them, since
// erasing a stroke should make that space fillable again). The mask doesn't care about color —
// just where a stroke exists — so it always paints opaque black regardless of state.color.
function withBrush(pathFn) {
  const isEraser = state.tool === "eraser";
  const lineWidth = isEraser ? state.size * 2 : state.size;

  for (const c of [ctx, maskCtx]) {
    c.save();
    c.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
    c.lineWidth = lineWidth;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = c.fillStyle = c === maskCtx ? "#000" : state.color;
    pathFn(c);
    c.restore();
  }
}

function dot(p) {
  withBrush((c) => {
    c.beginPath();
    c.arc(p.x, p.y, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
  });
}

function curve(from, ctrl, to) {
  withBrush((c) => {
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y);
    c.stroke();
  });
}

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Averages the last few incoming points into one. This is what actually takes the scatter out of
// a shaky hand — a single noisy sample (a camera-tracking wobble, a trackpad tremor) can only ever
// nudge the average a little, instead of yanking the line off toward itself. The window is short,
// so the line still goes exactly where you move it — it just stops tracing every little tremor
// along the way.
function smoothedPoint(points, window) {
  const recent = points.slice(-window);
  const sum = recent.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / recent.length, y: sum.y / recent.length };
}

// Strokes are drawn as curves through the midpoints of incoming points, which smooths out corners.
function strokeStart(p) {
  if (state.tool === "fill") {
    floodFill(p); // snapshots for undo itself, but only if it actually changes anything
    stroke = { last: null };
    return;
  }
  snapshot();
  stroke = { points: [p], last: p, mid: p };
  dot(p);
}

function strokeMove(p) {
  if (!stroke || !stroke.last) return;
  if (distance(p, stroke.last) < MIN_STEP) return;
  stroke.points.push(p);
  if (stroke.points.length > STROKE_DWELL_WINDOW) stroke.points.shift();

  // "Holding still" needs two things to both be true: the recent points haven't ended up far from
  // where they started (span), AND the finger hasn't actually travelled much to get there (path).
  // Checking span alone isn't enough — a tight corner or a small intentional loop also ends up
  // close to its own start, but the hand moved the whole way around it on purpose. Requiring a
  // short path too means that real shape gets drawn as-is, and only genuine in-place trembling
  // (short span, short path — it never really went anywhere) gets smoothed away.
  const span = distance(stroke.points[0], stroke.points[stroke.points.length - 1]);
  let path = 0;
  for (let i = 1; i < stroke.points.length; i++) path += distance(stroke.points[i - 1], stroke.points[i]);
  const isDwelling = span < STROKE_DWELL_SPAN && path < STROKE_DWELL_PATH;
  const window = isDwelling ? stroke.points.length : STROKE_SMOOTH_POINTS;

  const smoothed = smoothedPoint(stroke.points, window);
  const mid = midpoint(stroke.last, smoothed);
  curve(stroke.mid, stroke.last, mid);
  stroke.mid = mid;
  stroke.last = smoothed;
}

function strokeEnd() {
  if (stroke && stroke.last && stroke.mid) curve(stroke.mid, stroke.last, stroke.last);
  stroke = null;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function floodFill(p) {
  const w = draw.width;
  const h = draw.height;
  const sx = Math.floor(p.x * dpr);
  const sy = Math.floor(p.y * dpr);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mask = maskCtx.getImageData(0, 0, w, h).data;
  const start = sy * w + sx;

  // Clicking directly on a stroke does nothing at all — it's locked, not a space to fill into.
  if (mask[start * 4 + 3] > 0) return;

  const t = d.slice(start * 4, start * 4 + 4);
  const [r, g, b] = hexToRgb(state.color);
  if (t[0] === r && t[1] === g && t[2] === b && t[3] === 255) return; // already that exact color

  // Clicking empty canvas fills the space enclosed by your drawing, same as any paint bucket.
  // Clicking an already-filled area re-fills just that solid patch with the new color. Either way,
  // the lock mask is checked on every single neighbour before anything else — a stroke pixel is
  // never a valid match, full stop, regardless of how close its color might look. That's what
  // makes this airtight where a color-distance tolerance alone wasn't: a stroke's anti-aliased
  // edge keeps its exact color even at partial opacity, so no tolerance could ever fully rule it
  // out by color alone, but the mask doesn't need to — it just knows where strokes are.
  const targetIsEmpty = t[3] <= FILL_EMPTY_ALPHA;
  const matches = targetIsEmpty
    ? (i) => mask[i + 3] === 0 && d[i + 3] <= FILL_EMPTY_ALPHA
    : (i) =>
        mask[i + 3] === 0 &&
        Math.abs(d[i + 3] - t[3]) <= FILL_SOLID_TOLERANCE &&
        Math.abs(d[i] - t[0]) + Math.abs(d[i + 1] - t[1]) + Math.abs(d[i + 2] - t[2]) <=
          FILL_SOLID_TOLERANCE;

  const filled = new Uint8Array(w * h);
  const stack = [start];
  filled[start] = 1;
  // Tracks whether the empty area reaches all the way to a canvas edge — i.e. it's the open
  // background, not a space enclosed by something you've drawn.
  let touchesEdge = sx === 0 || sy === 0 || sx === w - 1 || sy === h - 1;

  while (stack.length) {
    const q = stack.pop();
    const x = q % w;
    const neighbours = [
      x > 0 ? q - 1 : -1,
      x < w - 1 ? q + 1 : -1,
      q >= w ? q - w : -1,
      q < w * (h - 1) ? q + w : -1,
    ];
    for (const n of neighbours) {
      if (n >= 0 && !filled[n] && matches(n * 4)) {
        filled[n] = 1;
        stack.push(n);
        const nx = n % w;
        const ny = (n - nx) / w;
        if (nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1) touchesEdge = true;
      }
    }
  }

  // Finger paint can pinch down anywhere, including empty canvas that's just open background
  // rather than a space your drawing actually encloses — filling the whole background by camera
  // gesture is too easy to trigger by accident. That's reserved for a deliberate mouse/trackpad
  // click.
  if (fingerPaintOn && touchesEdge) return;

  snapshot(); // only now that the fill is actually going to happen does it belong on the undo stack

  // Only the matched area gets the fill color — nothing outside it, including the line that
  // encloses it, is touched at all. (A line's own anti-aliased edge can end up a pixel or two
  // short of the fill as a result; that trade-off is intentional — the outline's color is never
  // allowed to shift, even slightly.)
  for (let q = 0; q < w * h; q++) {
    if (!filled[q]) continue;
    const i = q * 4;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------- Mouse / touch ---------- */

const pointFromEvent = (e) => ({ x: e.offsetX, y: e.offsetY });

draw.addEventListener("pointerdown", (e) => {
  draw.setPointerCapture(e.pointerId);
  strokeStart(pointFromEvent(e));
});
draw.addEventListener("pointermove", (e) => {
  if (!stroke) return;
  // Coalesced events include the in-between positions the browser batched up, for smoother lines.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) strokeMove(pointFromEvent(ev));
});
draw.addEventListener("pointerup", strokeEnd);
draw.addEventListener("pointercancel", strokeEnd);

/* ---------- Tools, palette, menus ---------- */

function setActive(attr, value) {
  document.querySelectorAll(`[${attr}]`).forEach((b) =>
    b.classList.toggle("is-active", b.getAttribute(attr) === String(value))
  );
}

let toolBeforeHand = "brush";

// The hand tool isn't really a drawing tool — clicking it picks your beetle up as a sticker
// you can drag and resize (see enterPlacing/exitPlacing). Clicking it again, or switching to
// any other tool, puts it back down.
function setTool(tool) {
  if (tool === "hand") {
    if (state.tool === "hand") {
      exitPlacing();
      setTool(toolBeforeHand);
      return;
    }
    if (!enterPlacing()) return; // nothing drawn yet — nothing to pick up, stay put
    toolBeforeHand = state.tool;
  } else if (state.tool === "hand") {
    exitPlacing();
  }
  state.tool = tool;
  setActive("data-tool", tool);
}

function setColor(color) {
  state.color = color;
  setActive("data-color", color);
  if (state.tool === "eraser") setTool("brush");
}

document.addEventListener("click", (e) => {
  // Close any open menu when clicking elsewhere or choosing an item.
  document.querySelectorAll(".menu[open]").forEach((m) => {
    if (!m.contains(e.target) || e.target.closest(".menu-items")) m.open = false;
  });

  const b = e.target.closest(".paint button");
  if (!b) return;

  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.size) {
    state.size = Number(b.dataset.size);
    setActive("data-size", b.dataset.size);
  } else if (b.dataset.color) setColor(b.dataset.color);
  else if (b.dataset.action === "undo") undo();
  else if (b.dataset.action === "clear") clearDrawing();
  else if (b.dataset.action === "camera") stream ? stopCamera() : startCamera();
  else if (b.dataset.action === "fingerpaint") fingerPaintOn ? stopFingerPaint() : startFingerPaint();
  else if (b.dataset.action === "photo") takePhoto();
  else if (b.dataset.action === "grid") {
    state.showGrid = !state.showGrid;
    grid.hidden = !state.showGrid;
    b.textContent = state.showGrid ? "hide grid" : "show grid";
  }
});

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (!fingerPaintOn) return; // nothing to exit, so leave space to do its normal job
  // Don't hijack space while it's doing its normal job elsewhere (typing, a focused button, a dialog).
  if (photoDialog.open) return;
  const el = document.activeElement;
  if (el && (el.tagName === "BUTTON" || el.tagName === "SUMMARY" || el.closest(".menu"))) return;
  e.preventDefault();
  stopFingerPaint();
});

// Escape backs all the way out of the camera (which also takes finger paint down with it,
// same as clicking "turn off camera"). The photo dialog already closes on Escape natively —
// leave that to the browser rather than also tearing down the camera underneath it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (photoDialog.open) return;
  if (!stream) return; // camera's already off, nothing to cancel
  e.preventDefault();
  stopCamera();
});

function setCameraLabels(on) {
  const label = on ? "turn off camera" : "turn on camera";
  document.querySelectorAll("[data-camera-label]").forEach((el) => (el.textContent = label));
  document.querySelectorAll(".camera-toggle").forEach((el) => el.classList.toggle("is-active", on));
}

function setFingerPaintLabels(on) {
  const label = on ? "turn off finger paint" : "turn on finger paint";
  document.querySelectorAll("[data-fingerpaint-label]").forEach((el) => (el.textContent = label));
  document.querySelectorAll(".fingerpaint-toggle").forEach((el) => el.classList.toggle("is-active", on));
}

/* ---------- Camera + hand tracking ---------- */
//
// Camera and finger paint are separate toggles: the camera just gets you on video (handy for
// the photo even if you're drawing with your mouse), and finger paint layers hand tracking on
// top of it. Turning finger paint on will turn the camera on for you if it isn't already; turning
// the camera off always takes finger paint down with it, since there's no video left to track.

function cameraErrorMessage(err) {
  if (!navigator.mediaDevices?.getUserMedia) return "this browser can't use the camera · try Chrome";
  if (err?.name === "NotAllowedError") return "camera blocked · allow it from the icon in the address bar";
  if (err?.name === "NotFoundError") return "no camera found";
  if (err?.name === "NotReadableError") return "camera is busy · close other apps using it";
  return "couldn't load hand tracking · check your internet connection";
}

async function loadLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: HAND_MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    // Lower thresholds keep hold of the hand between frames instead of dropping it and re-searching.
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("GPU hand tracking unavailable, falling back to CPU", err);
    return HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
    paintHelp.textContent = "asking for camera access…";
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    trackingPaused = false;
    stage.classList.add("has-camera");
    setCameraLabels(true);
    updateDrawHelp();
  } catch (err) {
    console.error(err);
    stopCamera();
    paintHelp.textContent = cameraErrorMessage(err);
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  stage.classList.remove("has-camera");
  setCameraLabels(false);
  if (fingerPaintOn) {
    fingerPaintOn = false;
    setFingerPaintLabels(false);
    syncCanvasInput();
  }
  handCursor.hidden = true;
  resetHand();
  updateDrawHelp();
}

async function startFingerPaint() {
  if (!stream) {
    await startCamera();
    if (!stream) return; // camera failed to start — the error is already on screen
  }
  try {
    if (!landmarker) {
      paintHelp.textContent = "loading hand tracking…";
      landmarker = await loadLandmarker();
    }
    fingerPaintOn = true;
    setFingerPaintLabels(true);
    syncCanvasInput();
    updateDrawHelp();
    setDrawing(false);
    scheduleTracking();
  } catch (err) {
    console.error(err);
    fingerPaintOn = false;
    setFingerPaintLabels(false);
    syncCanvasInput();
    paintHelp.textContent = cameraErrorMessage(err);
  }
}

function stopFingerPaint() {
  fingerPaintOn = false;
  setFingerPaintLabels(false);
  syncCanvasInput();
  handCursor.hidden = true;
  resetHand();
  updateDrawHelp();
}

// Maps a normalised landmark onto the canvas, matching the mirrored, object-fit: cover video.
function toStage(lm) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const s = Math.max(W / video.videoWidth, H / video.videoHeight);
  const dw = video.videoWidth * s;
  const dh = video.videoHeight * s;
  return {
    x: (W - dw) / 2 + (1 - lm.x) * dw,
    y: (H - dh) / 2 + lm.y * dh,
  };
}

// One Euro filter: smooths heavily when the finger is slow (kills jitter),
// and lightly when it's fast (keeps up with quick strokes).
class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

const filterX = new OneEuroFilter(SMOOTH_MIN_CUTOFF, SMOOTH_BETA);
const filterY = new OneEuroFilter(SMOOTH_MIN_CUTOFF, SMOOTH_BETA);

const hand = {
  pos: null,
  drawing: false,
  holdFrames: 0,
  releaseFrames: 0,
  missingSince: 0,
};

// 0 in the middle of the frame, ramping up to 1 right at an edge or corner — used to add extra
// damping exactly where tracking tends to get shakiest, without affecting the rest of the canvas.
function edgeFactor(pt) {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const marginX = w * EDGE_MARGIN;
  const marginY = h * EDGE_MARGIN;
  const nearestX = Math.min(pt.x, w - pt.x);
  const nearestY = Math.min(pt.y, h - pt.y);
  const fx = 1 - Math.max(0, Math.min(1, nearestX / marginX));
  const fy = 1 - Math.max(0, Math.min(1, nearestY / marginY));
  // A corner is near both edges at once, so it should damp more than a point near just one edge —
  // combine them like independent probabilities rather than just taking whichever is bigger.
  return fx + fy - fx * fy;
}

function resetHand() {
  strokeEnd();
  filterX.reset();
  filterY.reset();
  hand.pos = null;
  hand.holdFrames = 0;
  hand.releaseFrames = 0;
  if (hand.drawing) setDrawing(false);
}

function setDrawing(on) {
  hand.drawing = on;
  if (!on) strokeEnd();
  // The hand cursor's own filled dot (see .hand-cursor.is-on) is the pencil-down/up feedback now.
  handCursor.classList.toggle("is-on", on);
}

// Thumb tip to index tip, relative to palm size (wrist to middle knuckle), in 3D so hand
// depth/rotation don't throw it off. Hysteresis (different thresholds for closing vs.
// opening) keeps the reading right at the edge of the threshold from flickering.
function pinchRatio(lm) {
  const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return dist3(lm[4], lm[8]) / dist3(lm[0], lm[9]);
}

let lastVideoTime = -1;

// Switching tabs (or apps) shouldn't leave the beetle drawing on its own in the background —
// whatever's in frame of the camera while you're not even looking at the page. Pause the video
// and the tracking loop entirely while that's true, and end any in-progress stroke so there's
// nothing left dangling to accidentally continue when you come back.
//
// Two different signals catch this, because either one alone misses cases the other covers:
// visibilitychange fires when this tab itself is hidden (switched to another tab, minimized), but
// doesn't reliably fire for every way of switching to another app/window — window blur/focus
// catches that instead, but wouldn't catch e.g. switching tabs within the same window on its own.
// Both funnel into the same pause/resume so it doesn't matter which one notices first.
function pauseForBackground() {
  if (!stream || trackingPaused) return;
  trackingPaused = true;
  video.pause();
  if (fingerPaintOn) resetHand();
}

function resumeFromBackground() {
  if (!stream || !trackingPaused) return;
  // Only actually resume if we're truly back: the tab visible AND the window focused. Either
  // signal alone can fire optimistically (e.g. focus firing while another app's dialog still has
  // the tab's document reporting hidden), so require both before letting tracking start again.
  if (document.hidden || !document.hasFocus()) return;
  trackingPaused = false;
  video.play().catch(() => {});
  if (fingerPaintOn) scheduleTracking();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseForBackground();
  else resumeFromBackground();
});
addEventListener("blur", pauseForBackground);
addEventListener("focus", resumeFromBackground);

function scheduleTracking() {
  if (!fingerPaintOn || trackingPaused) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(trackHand);
  else requestAnimationFrame(trackHand);
}

function trackHand() {
  if (!fingerPaintOn || trackingPaused) return;
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    handleHand(result.landmarks[0], performance.now());
  }
  scheduleTracking();
}

function handleHand(lm, now) {
  if (!lm) {
    // Brief dropouts are common — keep the stroke open so the line picks up where it left off.
    // Crucially, this never touches hand.drawing: whether you're drawing is the pencil toggle's
    // call alone, not something losing sight of your hand should quietly change.
    if (!hand.missingSince) hand.missingSince = now;
    handCursor.classList.add("is-lost");
    if (now - hand.missingSince > LOST_HAND_MS) handCursor.hidden = true;
    return;
  }
  hand.missingSince = 0;
  handCursor.classList.remove("is-lost");

  // Always tracked, regardless of hand shape — the pencil toggle decides whether this draws.
  const raw = toStage(lm[8]);
  const jumpLimit = Math.hypot(stage.clientWidth, stage.clientHeight) * JUMP_FRACTION;
  if (hand.pos && distance(raw, hand.pos) > jumpLimit) {
    strokeEnd();
    filterX.reset();
    filterY.reset();
    hand.pos = null; // a deliberate teleport, not noise — don't drag the edge-damping below toward it
  }
  const filtered = { x: filterX.filter(raw.x, now), y: filterY.filter(raw.y, now) };

  // Right near an edge or corner, hold back part of this frame's movement rather than applying it
  // outright — the noisier the tracking gets out there, the more each new reading gets questioned
  // instead of taken at face value. In the middle of the frame this does nothing at all.
  const ef = edgeFactor(filtered);
  if (ef > 0 && hand.pos) {
    hand.pos = {
      x: hand.pos.x + (filtered.x - hand.pos.x) * (1 - EDGE_MAX_DAMPING * ef),
      y: hand.pos.y + (filtered.y - hand.pos.y) * (1 - EDGE_MAX_DAMPING * ef),
    };
  } else {
    hand.pos = filtered;
  }

  const ratio = pinchRatio(lm);
  const pinched = ratio < (hand.drawing ? PINCH_HOLD_OFF : PINCH_HOLD_ON);
  hand.holdFrames = pinched ? hand.holdFrames + 1 : 0;
  hand.releaseFrames = pinched ? 0 : hand.releaseFrames + 1;

  if (!hand.drawing && hand.holdFrames >= HOLD_FRAMES) setDrawing(true);
  else if (hand.drawing && hand.releaseFrames >= RELEASE_FRAMES) setDrawing(false);

  handCursor.hidden = false;
  handCursor.style.transform = `translate(${hand.pos.x}px, ${hand.pos.y}px)`;
  handCursor.style.setProperty("--color", state.tool === "eraser" ? "#ffffff" : state.color);

  if (!hand.drawing || placing) return;

  // hand.drawing can stay true for a couple of frames after you start opening your fingers —
  // that's the RELEASE_FRAMES debounce, which exists so one noisy frame doesn't cut a stroke
  // short. But your fingertip is already moving as it opens, so without this check those debounce
  // frames would draw a little stray flick right as you let go. Freeze instead: only actually
  // draw on frames where the pinch reads as currently closed.
  if (!pinched) return;

  if (!stroke) strokeStart(hand.pos);
  else strokeMove(hand.pos);
}

/* ---------- Photo ---------- */

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function takePhoto() {
  countdownEl.hidden = false;
  for (const n of [3, 2, 1]) {
    countdownEl.textContent = n;
    await wait(800);
  }
  countdownEl.hidden = true;

  const out = document.createElement("canvas");
  out.width = draw.width;
  out.height = draw.height;
  const o = out.getContext("2d");
  o.fillStyle = CANVAS_BG;
  o.fillRect(0, 0, out.width, out.height);

  if (stream && video.videoWidth) {
    const s = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
    const dw = video.videoWidth * s;
    const dh = video.videoHeight * s;
    o.save();
    o.translate(out.width, 0);
    o.scale(-1, 1);
    o.drawImage(video, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
    o.restore();
  }

  if (state.showGrid) {
    o.strokeStyle = GRID_COLOR;
    o.lineWidth = dpr;
    const step = GRID_SIZE * dpr;
    o.beginPath();
    for (let x = step; x < out.width; x += step) {
      o.moveTo(x, 0);
      o.lineTo(x, out.height);
    }
    for (let y = step; y < out.height; y += step) {
      o.moveTo(0, y);
      o.lineTo(out.width, y);
    }
    o.stroke();
  }

  o.drawImage(draw, 0, 0);

  if (placing && spriteImg.naturalWidth) {
    o.drawImage(spriteImg, spriteState.x * dpr, spriteState.y * dpr, spriteState.w * dpr, spriteState.h * dpr);
  }

  stage.classList.add("flash");
  setTimeout(() => stage.classList.remove("flash"), 300);

  const url = out.toDataURL("image/png");
  photoImg.src = url;
  photoDownload.href = url;
  photoDialog.showModal();
}

document.getElementById("photoClose").addEventListener("click", () => photoDialog.close());
