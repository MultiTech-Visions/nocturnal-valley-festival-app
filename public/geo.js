// Converts GPS lat/lng to pixel coordinates on the festival map image.
// Inside the control-point mesh: piecewise affine (one exact affine per
// Delaunay triangle), which absorbs the artist's local stretching.
// Outside the mesh: one global least-squares affine as a fallback.
const Geo = (() => {
  const R = 6371008.8;
  const RAD = Math.PI / 180;

  // Local equirectangular projection to meters around an origin.
  // Accurate to well under a meter across a site this size.
  function makeProjector(lat0, lng0) {
    const k = Math.cos(lat0 * RAD);
    return {
      toMeters: (lat, lng) => [(lng - lng0) * RAD * R * k, (lat - lat0) * RAD * R],
      toLatLng: ([x, y]) => [lat0 + y / (R * RAD), lng0 + x / (R * k * RAD)],
      metersEastToLng: (m) => m / (R * k * RAD)
    };
  }

  function solve3(m, b) {
    const det = (a) =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det(m);
    if (Math.abs(d) < 1e-9) throw new Error('Control points are collinear or duplicated; cannot fit a transform.');
    return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)))) / d);
  }

  // Least-squares affine from src [x,y] to dst [u,v]. Exact for 3 points.
  function fitAffine(src, dst) {
    if (src.length < 3) throw new Error(`fitAffine needs 3+ points, got ${src.length}`);
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const bu = [0, 0, 0];
    const bv = [0, 0, 0];
    src.forEach(([x, y], i) => {
      const r = [x, y, 1];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b];
        bu[a] += r[a] * dst[i][0];
        bv[a] += r[a] * dst[i][1];
      }
    });
    const [a, b, c] = solve3(M, bu);
    const [d, e, f] = solve3(M, bv);
    const fn = ([x, y]) => [a * x + b * y + c, d * x + e * y + f];
    const det = a * e - b * d;
    if (Math.abs(det) < 1e-12) throw new Error('Degenerate affine fit; control points give no usable transform.');
    fn.scale = Math.sqrt(Math.abs(det)); // image px per meter
    // The same map read backwards: pixels to meters. Dropping a pin by
    // tapping the artwork needs this direction.
    fn.invert = ([u, v]) => [
      (e * (u - c) - b * (v - f)) / det,
      (a * (v - f) - d * (u - c)) / det
    ];
    return fn;
  }

  function circumcircle(p, t) {
    const [ax, ay] = p[t[0]];
    const [bx, by] = p[t[1]];
    const [cx, cy] = p[t[2]];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (d === 0) return null;
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return { x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  }

  // Bowyer-Watson. Returns triangles as index triples into pts.
  function delaunay(pts) {
    const n = pts.length;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY) * 20;
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const P = pts.concat([[mx - span, my - span], [mx, my + span], [mx + span, my - span]]);
    let tris = [[n, n + 1, n + 2]];

    for (let i = 0; i < n; i++) {
      const [px, py] = P[i];
      const bad = [];
      const keep = [];
      for (const t of tris) {
        const c = circumcircle(P, t);
        if (c !== null && (px - c.x) ** 2 + (py - c.y) ** 2 < c.r2) bad.push(t);
        else keep.push(t);
      }
      const edgeCount = new Map();
      for (const t of bad) {
        for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edgeCount.set(key, (edgeCount.get(key) === undefined ? 0 : edgeCount.get(key)) + 1);
        }
      }
      tris = keep;
      for (const [key, count] of edgeCount) {
        if (count !== 1) continue;
        const [a, b] = key.split(',').map(Number);
        tris.push([a, b, i]);
      }
    }
    return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n);
  }

  function inTriangle([x, y], a, b, c) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const eps = -1e-9;
    return l1 >= eps && l2 >= eps && 1 - l1 - l2 >= eps;
  }

  // calib: { image:{width,height}, points:[{label, px:[x,y], ll:[lat,lng]}] }
  function build(calib) {
    const pts = calib.points;
    if (pts.length < 3) throw new Error(`Calibration needs at least 3 points, has ${pts.length}.`);

    const lat0 = pts.reduce((s, p) => s + p.ll[0], 0) / pts.length;
    const lng0 = pts.reduce((s, p) => s + p.ll[1], 0) / pts.length;
    const proj = makeProjector(lat0, lng0);
    const src = pts.map((p) => proj.toMeters(p.ll[0], p.ll[1]));
    const dst = pts.map((p) => p.px);

    const global = fitAffine(src, dst);
    const mesh = delaunay(src).map((t) => ({
      verts: t.map((i) => src[i]),
      // The same triangle in pixel space, so a tapped pixel can be matched
      // to the triangle whose transform should undo it.
      pxVerts: t.map((i) => dst[i]),
      fn: fitAffine(t.map((i) => src[i]), t.map((i) => dst[i]))
    }));

    function project(lat, lng) {
      const m = proj.toMeters(lat, lng);
      for (const tri of mesh) {
        if (inTriangle(m, tri.verts[0], tri.verts[1], tri.verts[2])) {
          const [x, y] = tri.fn(m);
          return { x, y, inMesh: true };
        }
      }
      const [x, y] = global(m);
      return { x, y, inMesh: false };
    }

    // Pixels back to GPS, mirroring project(): the triangle that contains the
    // pixel undoes it exactly, anything outside the mesh falls back to the
    // global fit. inMesh carries the same warning as it does on the way out.
    function unproject(x, y) {
      for (const tri of mesh) {
        if (inTriangle([x, y], tri.pxVerts[0], tri.pxVerts[1], tri.pxVerts[2])) {
          const [lat, lng] = proj.toLatLng(tri.fn.invert([x, y]));
          return { lat, lng, inMesh: true };
        }
      }
      const [lat, lng] = proj.toLatLng(global.invert([x, y]));
      return { lat, lng, inMesh: false };
    }

    // Image px per meter at a location, for drawing the GPS accuracy circle.
    function pxPerMeter(lat, lng) {
      const a = project(lat, lng);
      const b = project(lat, lng + proj.metersEastToLng(10));
      return Math.hypot(b.x - a.x, b.y - a.y) / 10;
    }

    // How far each point sits from the single global affine, in meters.
    // A pair with a large value is either a mismatched click or a spot
    // where the artist distorted heavily. Mismatches are the thing to catch.
    function residuals() {
      return src.map((m, i) => {
        const [x, y] = global(m);
        return Math.hypot(x - dst[i][0], y - dst[i][1]) / global.scale;
      });
    }

    return { project, unproject, pxPerMeter, residuals, triangleCount: mesh.length };
  }

  return { build };
})();
