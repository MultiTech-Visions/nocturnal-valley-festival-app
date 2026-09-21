// Phone-to-phone transfer over an animated QR sequence. No network, no
// account, no pairing: one screen cycles frames, the other camera reads them
// until it has the whole set.
//
// A QR tops out at 2953 bytes, so anything bigger than a handful of points is
// split across frames. The sender cycles forever rather than playing once, so
// a frame the camera misses simply comes around again -- the receiver waits
// for the gaps instead of the pair starting over.
const Share = (() => {
  const MAGIC = 'NVQ1';
  // Well under the format ceiling: a dense QR is a slow, fussy scan in the
  // dark, and more frames of an easy code beats fewer of a hard one.
  const CHUNK = 900;
  const FRAME_MS = 400;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const canDeflate = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- Photos ----------
  // One shrinker for both jobs: the copy kept on the phone and the much
  // smaller copy that has to survive a QR sequence. Only the sizes differ.
  function shrinkPhoto(source, maxPx, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(source);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          if (blob === null) reject(new Error('Could not re-encode that photo.'));
          else resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not an image this browser can read.'));
      };
      img.src = url;
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.slice(fr.result.indexOf(',') + 1));
      fr.onerror = () => reject(new Error('Could not read that photo back.'));
      fr.readAsDataURL(blob);
    });
  }

  const base64ToBlob = (b64) => new Blob([base64ToBytes(b64)], { type: 'image/jpeg' });

  // ---------- Payload ----------
  // Positional arrays, not objects: at QR scale, repeating a key like "label"
  // forty times costs real frames.
  async function encode(name, points, photos, favorites, edits, finds) {
    const index = new Map();
    const images = [];
    for (const [pointId, blob] of photos) {
      index.set(pointId, images.length);
      images.push(await blobToBase64(blob));
    }
    const payload = {
      v: 4,
      n: name,
      p: points.map((pt) => [pt.label, +pt.lat.toFixed(6), +pt.lng.toFixed(6), pt.note, index.has(pt.id) ? index.get(pt.id) : -1]),
      i: images,
      // Event ids only. Both phones read the same schedule.json, so sending
      // titles and times as well would just be frames spent on data the
      // other side already has.
      f: favorites,
      // Corrections travel as [eventId, patch]: the patch is only the fields
      // somebody actually changed, so a whole evening of retimes is still
      // small enough to stay in one or two frames.
      o: edits.map((e) => [e.eventId, e.patch]),
      // Landmarks found, with the coordinates captured on the spot and the
      // artwork pixel if they placed it. A pair with both is a calibration
      // point, which is what actually sharpens the map.
      q: finds.map((f) => [f.questId, f.lat, f.lng, Math.round(f.accuracy), f.px, f.foundAt])
    };

    const raw = enc.encode(JSON.stringify(payload));
    const body = canDeflate ? await pipe(raw, new CompressionStream('deflate-raw')) : raw;
    const text = bytesToBase64(body);
    const sid = Math.random().toString(36).slice(2, 6);
    const flag = canDeflate ? 'c' : 'r';

    const total = Math.max(1, Math.ceil(text.length / CHUNK));
    const frames = [];
    for (let i = 0; i < total; i++) {
      frames.push(`${MAGIC}${flag}:${sid}:${i}:${total}:${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
    return { frames, sid, bytes: body.length };
  }

  function parseFrame(text) {
    if (!text.startsWith(MAGIC)) return null;
    const flag = text[MAGIC.length];
    const parts = text.slice(MAGIC.length + 2).split(':');
    if (parts.length < 4) return null;
    const [sid, seq, total] = parts;
    return {
      flag,
      sid,
      seq: Number(seq),
      total: Number(total),
      chunk: parts.slice(3).join(':')
    };
  }

  async function assemble(flag, chunks) {
    const body = base64ToBytes(chunks.join(''));
    const raw = flag === 'c' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
    const payload = JSON.parse(dec.decode(raw));
    if (payload.v < 1 || payload.v > 4) {
      throw new Error(`This code is version ${payload.v}; this app speaks 1 to 4. Update both phones.`);
    }
    // Older codes predate these fields. Fill them per version rather than
    // defaulting them away, so a malformed current payload still fails loud.
    if (payload.v < 2) payload.f = [];
    if (payload.v < 3) payload.o = [];
    if (payload.v < 4) payload.q = [];
    return payload;
  }

  // ---------- Showing ----------
  // Error correction M, not L: L squeezes in more bytes but gives up the
  // redundancy that carries a scan through a fingerprint or a bad angle.
  function drawFrame(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4;
    const size = canvas.width;
    const scale = Math.floor(size / (count + quiet * 2));
    const offset = Math.round((size - scale * count) / 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(offset + c * scale, offset + r * scale, scale, scale);
      }
    }
  }

  function play(canvas, frames, onFrame) {
    let i = 0;
    const tick = () => {
      drawFrame(canvas, frames[i]);
      onFrame(i + 1, frames.length);
      i = (i + 1) % frames.length;
    };
    tick();
    const timer = frames.length === 1 ? null : setInterval(tick, FRAME_MS);
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }

  // ---------- Reading ----------
  // BarcodeDetector where it exists (Android Chrome), jsQR everywhere else.
  // Safari has no BarcodeDetector, so the library is not optional.
  function makeReader() {
    if (typeof BarcodeDetector === 'function') {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      return async (canvas) => {
        const found = await detector.detect(canvas);
        return found.length === 0 ? null : found[0].rawValue;
      };
    }
    if (typeof jsQR !== 'function') throw new Error('No QR reader available: jsQR.min.js did not load.');
    return async (canvas) => {
      const { width, height } = canvas;
      const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
      const found = jsQR(data.data, width, height, { inversionAttempts: 'dontInvert' });
      return found === null ? null : found.data;
    };
  }

  // Resolves with the assembled payload once every frame has been seen.
  // Rejects only on a real fault; a frame from another sender is ignored.
  async function receive(video, canvas, onProgress, signal) {
    const read = makeReader();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();

    const stop = () => {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };

    try {
      let session = null;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (;;) {
        if (signal.aborted) throw new Error('Scan cancelled.');
        if (video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const text = await read(canvas);
          const frame = text === null ? null : parseFrame(text);
          if (frame !== null) {
            // A different sender mid-scan means a fresh start, not a mix.
            if (session === null || session.sid !== frame.sid) {
              session = { sid: frame.sid, flag: frame.flag, total: frame.total, chunks: new Array(frame.total).fill(null) };
            }
            session.chunks[frame.seq] = frame.chunk;
            const have = session.chunks.filter((c) => c !== null).length;
            onProgress(have, session.total);
            if (have === session.total) return await assemble(session.flag, session.chunks);
          }
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    } finally {
      stop();
    }
  }

  return { encode, parseFrame, assemble, play, receive, shrinkPhoto, blobToBase64, base64ToBlob, canDeflate };
})();
