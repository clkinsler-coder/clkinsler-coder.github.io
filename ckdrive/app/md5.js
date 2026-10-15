// Incremental MD5, so large files can be fingerprinted a piece at a time in the browser
// (Web Crypto has no MD5, and Drive's fingerprint is MD5).
(function () {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  class MD5 {
    constructor() {
      this.h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
      this.buf = new Uint8Array(64);
      this.bufLen = 0;
      this.total = 0;
      this.m = new Int32Array(16);
    }

    update(bytes) {
      let i = 0;
      this.total += bytes.length;
      if (this.bufLen) {
        const n = Math.min(64 - this.bufLen, bytes.length);
        this.buf.set(bytes.subarray(0, n), this.bufLen);
        this.bufLen += n;
        i = n;
        if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
      }
      for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
      if (i < bytes.length) { this.buf.set(bytes.subarray(i), 0); this.bufLen = bytes.length - i; }
      return this;
    }

    digest() {
      const tail = new Uint8Array(this.bufLen < 56 ? 64 : 128);
      tail.set(this.buf.subarray(0, this.bufLen));
      tail[this.bufLen] = 0x80;
      const p = tail.length - 8;
      const lo = (this.total * 8) >>> 0;
      const hi = Math.floor(this.total / 0x20000000) >>> 0;
      for (let k = 0; k < 4; k++) { tail[p + k] = (lo >>> (8 * k)) & 255; tail[p + 4 + k] = (hi >>> (8 * k)) & 255; }
      this.block(tail, 0);
      if (tail.length === 128) this.block(tail, 64);
      let out = "";
      for (const w of this.h) for (let k = 0; k < 4; k++) out += ((w >>> (8 * k)) & 255).toString(16).padStart(2, "0");
      return out;
    }

    block(b, o) {
      const m = this.m;
      for (let j = 0; j < 16; j++) {
        const q = o + j * 4;
        m[j] = b[q] | (b[q + 1] << 8) | (b[q + 2] << 16) | (b[q + 3] << 24);
      }
      let [a, bb, c, d] = this.h;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
        else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
        const t = d;
        d = c;
        c = bb;
        const x = (a + f + K[i] + m[g]) | 0;
        bb = (bb + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
        a = t;
      }
      this.h[0] = (this.h[0] + a) | 0;
      this.h[1] = (this.h[1] + bb) | 0;
      this.h[2] = (this.h[2] + c) | 0;
      this.h[3] = (this.h[3] + d) | 0;
    }
  }

  /** Fingerprints a File/Blob 4 MB at a time; onProgress gets bytes read. */
  async function md5File(file, onProgress) {
    const h = new MD5();
    const step = 4 * 1024 * 1024;
    for (let pos = 0; pos < file.size; pos += step) {
      const chunk = new Uint8Array(await file.slice(pos, pos + step).arrayBuffer());
      h.update(chunk);
      if (onProgress) onProgress(Math.min(pos + step, file.size));
    }
    return h.digest();
  }

  window.MD5 = MD5;
  window.md5File = md5File;
})();
