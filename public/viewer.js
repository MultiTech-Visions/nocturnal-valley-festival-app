// Pan / pinch / wheel-zoom viewer for one image. Markers are positioned in
// image-pixel coordinates but drawn in screen space so they stay a constant
// size at any zoom. Used by both the map app and the calibration tool.
class Viewer {
  constructor(container, img, { onTap, maxZoom }) {
    this.el = container;
    this.img = img;
    this.onTap = onTap;
    this.maxZoom = maxZoom;
    this.iw = img.naturalWidth;
    this.ih = img.naturalHeight;
    if (!this.iw || !this.ih) throw new Error('Viewer needs a fully loaded image.');

    this.layer = document.createElement('div');
    this.layer.className = 'viewer-layer';
    this.layer.appendChild(img);
    this.el.appendChild(this.layer);
    this.markers = new Map();
    this.pointers = new Map();

    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.viewW = 0;
    this.viewH = 0;
    new ResizeObserver(() => this.refit()).observe(this.el);
    this.fit();
  }

  fit() {
    const { clientWidth: w, clientHeight: h } = this.el;
    this.viewW = w;
    this.viewH = h;
    this.minScale = Math.min(w / this.iw, h / this.ih);
    this.scale = this.minScale;
    this.tx = (w - this.iw * this.scale) / 2;
    this.ty = (h - this.ih * this.scale) / 2;
    this.render();
  }

  // The box changing size is not a reason to throw away where someone is
  // looking. A line of footer text appearing, the on-screen keyboard, a
  // rotation -- all of these resize the viewer, and a plain fit() would
  // snap a zoomed-in map back to the whole image every time. Keep the same
  // image point centred and the same zoom, rescaled against the new fit.
  refit() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.viewW === 0 || this.viewH === 0) {
      this.fit();
      return;
    }
    const cx = (this.viewW / 2 - this.tx) / this.scale;
    const cy = (this.viewH / 2 - this.ty) / this.scale;
    const nextMin = Math.min(w / this.iw, h / this.ih);
    const zoomRatio = this.scale / this.minScale;
    this.minScale = nextMin;
    this.scale = Math.min(Math.max(nextMin * zoomRatio, nextMin), nextMin * this.maxZoom);
    this.viewW = w;
    this.viewH = h;
    this.tx = w / 2 - cx * this.scale;
    this.ty = h / 2 - cy * this.scale;
    this.clamp();
    this.render();
  }

  zoomAt(sx, sy, factor) {
    const next = Math.min(Math.max(this.scale * factor, this.minScale), this.minScale * this.maxZoom);
    const f = next / this.scale;
    this.tx = sx - (sx - this.tx) * f;
    this.ty = sy - (sy - this.ty) * f;
    this.scale = next;
    this.clamp();
    this.render();
  }

  // Keep at least a third of the viewport covered by the image.
  clamp() {
    const { clientWidth: w, clientHeight: h } = this.el;
    const iw = this.iw * this.scale, ih = this.ih * this.scale;
    this.tx = Math.min(Math.max(this.tx, w / 3 - iw), (w * 2) / 3);
    this.ty = Math.min(Math.max(this.ty, h / 3 - ih), (h * 2) / 3);
  }

  centerOn(x, y, zoom) {
    if (zoom !== undefined) this.scale = Math.max(this.scale, this.minScale * zoom);
    this.tx = this.el.clientWidth / 2 - x * this.scale;
    this.ty = this.el.clientHeight / 2 - y * this.scale;
    this.clamp();
    this.render();
  }

  toImage(sx, sy) {
    return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale];
  }

  down(e) {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    else this.tap = null;
    this.pinch = null;
  }

  move(e) {
    const prev = this.pointers.get(e.pointerId);
    if (prev === undefined) return;
    const cur = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, cur);

    if (this.pointers.size === 1) {
      this.tx += cur.x - prev.x;
      this.ty += cur.y - prev.y;
      this.clamp();
      this.render();
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.el.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch !== null) {
        this.tx += mid.x - this.pinch.mid.x;
        this.ty += mid.y - this.pinch.mid.y;
        this.zoomAt(mid.x, mid.y, dist / this.pinch.dist);
      }
      this.pinch = { mid, dist };
    }
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    if (this.tap === null || this.onTap === undefined) return;
    // A thumb on a phone is not a mouse: 8px of drift is an ordinary tap,
    // not a pan, and treating it as one made tapping the map feel dead.
    const slop = e.pointerType === 'mouse' ? 8 : 14;
    const moved = Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y);
    if (moved < slop && performance.now() - this.tap.t < 500) {
      const r = this.el.getBoundingClientRect();
      this.onTap(...this.toImage(e.clientX - r.left, e.clientY - r.top));
    }
    this.tap = null;
  }

  // m: { x, y, el, radiusPx? } in image pixels. radiusPx sizes el as a circle.
  setMarker(key, m) {
    const existing = this.markers.get(key);
    if (existing !== undefined && existing.el !== m.el) existing.el.remove();
    if (m.el.parentNode !== this.el) this.el.appendChild(m.el);
    this.markers.set(key, m);
    this.renderMarker(m);
  }

  removeMarker(key) {
    const m = this.markers.get(key);
    if (m === undefined) return;
    m.el.remove();
    this.markers.delete(key);
  }

  renderMarker(m) {
    const sx = this.tx + m.x * this.scale;
    const sy = this.ty + m.y * this.scale;
    if (m.radiusPx !== undefined) {
      const d = Math.max(m.radiusPx * this.scale * 2, 0);
      m.el.style.width = m.el.style.height = `${d}px`;
    }
    m.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
  }

  render() {
    this.layer.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    for (const m of this.markers.values()) this.renderMarker(m);
  }
}
