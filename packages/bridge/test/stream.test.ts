import { describe, expect, it } from "vitest";
import { frame, PacketParser, type VideoPacket } from "../src/stream.ts";

function media(flags: { config?: boolean; key?: boolean }, pts: number, data: number[]): Buffer {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE((flags.config ? 1n << 62n : 0n) | (flags.key ? 1n << 61n : 0n) | BigInt(pts), 0);
  h.writeUInt32BE(data.length, 8);
  return Buffer.concat([h, Buffer.from(data)]);
}

describe("scrcpy PacketParser", () => {
  it("splits packets across arbitrary chunk boundaries and reads flags", () => {
    const out: VideoPacket[] = [];
    const sessions: Array<[number, number]> = [];
    const p = new PacketParser((x) => out.push(x), (w, h) => sessions.push([w, h]));
    const session = Buffer.alloc(12);
    session.writeUInt32BE(0x80000000, 0);
    session.writeUInt32BE(720, 4);
    session.writeUInt32BE(1600, 8);
    const all = Buffer.concat([session, media({ config: true }, 0, [0, 0, 0, 1, 0x67, 0x42]), media({ key: true }, 1000, [9, 9, 9]), media({}, 2000, [])]);
    for (let i = 0; i < all.length; i += 5) p.feed(all.subarray(i, i + 5));
    expect(sessions).toEqual([[720, 1600]]);
    expect(out.map((x) => [x.config, x.key, Number(x.pts), [...x.data]])).toEqual([
      [true, false, 0, [0, 0, 0, 1, 0x67, 0x42]],
      [false, true, 1000, [9, 9, 9]],
      [false, false, 2000, []],
    ]);
  });

  it("frames packets for the browser as flags + u32 length + payload", () => {
    const f = frame({ config: false, key: true, data: Buffer.from([1, 2, 3]) });
    expect([...f]).toEqual([2, 0, 0, 0, 3, 1, 2, 3]);
    expect(frame({ config: true, key: false, data: Buffer.alloc(0) })[0]).toBe(1);
  });
});
