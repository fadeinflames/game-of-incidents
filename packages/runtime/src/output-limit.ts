// A script runs as root next to a player who is root too: whatever it prints is not ours to buffer without a bound.

/** how much of each of stdout and stderr is kept: the verdict JSON is the last thing check.sh prints, the cause of a failure is at the end */
export const SCRIPT_OUTPUT_TAIL_BYTES = 256 * 1024;

/** raw bytes read from the exec stream (both channels together, framing included) before the stream is dropped */
export const SCRIPT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** sliding window over the end of a byte stream */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
