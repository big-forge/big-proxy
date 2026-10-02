import type { Duplex } from 'node:stream';

type Pending =
  | { kind: 'bytes'; n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }
  | { kind: 'until'; delim: Buffer; max: number; resolve: (b: Buffer) => void; reject: (e: Error) => void };

/**
 * Pull-style reads over a socket for protocol handshakes (SOCKS5, HTTP heads).
 * Call `detach()` once the handshake is done to get any bytes that arrived
 * early, then pipe the socket normally.
 */
export class SocketReader {
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private failure: Error | null = null;

  constructor(private readonly sock: Duplex) {
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'bytes', n, resolve, reject };
      this.drain();
    });
  }

  /** Resolves with everything up to and including `delim`. */
  readUntil(delim: string, max: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'until', delim: Buffer.from(delim, 'latin1'), max, resolve, reject };
      this.drain();
    });
  }

  detach(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    this.sock.pause();
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }

  private onData = (chunk: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.drain();
  };

  private onEnd = () => this.fail(new Error('Connection closed during handshake'));

  private onError = (err: Error) => this.fail(err);

  private fail(err: Error) {
    this.failure ??= err;
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  private drain() {
    const p = this.pending;
    if (!p) return;
    if (p.kind === 'bytes') {
      if (this.buf.length >= p.n) {
        this.pending = null;
        const out = this.buf.subarray(0, p.n);
        this.buf = this.buf.subarray(p.n);
        p.resolve(out);
        return;
      }
    } else {
      const idx = this.buf.indexOf(p.delim);
      if (idx !== -1) {
        this.pending = null;
        const end = idx + p.delim.length;
        const out = this.buf.subarray(0, end);
        this.buf = this.buf.subarray(end);
        p.resolve(out);
        return;
      }
      if (this.buf.length > p.max) {
        this.pending = null;
        p.reject(new Error('Request header too large'));
        return;
      }
    }
    if (this.failure) {
      this.pending = null;
      p.reject(this.failure);
    }
  }
}
