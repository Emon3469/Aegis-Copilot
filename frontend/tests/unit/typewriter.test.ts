import { describe, expect, it, vi } from "vitest";
import { createTypewriter } from "@/lib/typewriter";

function harness(options: Parameters<typeof createTypewriter>[1] = {}) {
  const frames: FrameRequestCallback[] = [];
  const renders: string[] = [];
  const writer = createTypewriter((v) => renders.push(v), {
    raf: (cb) => frames.push(cb),
    caf: (id) => {
      frames[id - 1] = () => {};
    },
    ...options,
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      const cb = frames.shift();
      if (!cb) return;
      cb(0);
    }
  };
  const runAll = () => {
    let guard = 0;
    while (frames.length && guard++ < 10_000) step();
  };
  return { writer, renders, step, runAll, frames };
}

describe("typewriter", () => {
  it("reveals text gradually over several frames", () => {
    const { writer, renders, runAll } = harness();
    writer.push("x".repeat(500));
    expect(renders).toEqual([]);
    runAll();
    expect(renders.length).toBeGreaterThan(20);
    expect(renders.length).toBeLessThan(80);
    const lengths = renders.map((r) => r.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(renders.at(-1)).toBe("x".repeat(500));
  });

  it("speeds up when the backlog grows", () => {
    const small = harness();
    small.writer.push("a".repeat(100));
    small.step();
    const big = harness();
    big.writer.push("a".repeat(5000));
    big.step();
    expect(big.renders[0].length).toBeGreaterThan(small.renders[0].length * 10);
  });

  it("keeps streaming as more text arrives", () => {
    const { writer, renders, step, runAll } = harness();
    writer.push("Hello ");
    step(2);
    writer.push("world");
    runAll();
    expect(renders.at(-1)).toBe("Hello world");
  });

  it("never splits surrogate pairs", () => {
    const { writer, renders, runAll } = harness({ minStep: 1, drainFrames: 1000 });
    writer.push("🚀🔥✅ নমস্কার");
    runAll();
    for (const r of renders) {
      const last = r.charCodeAt(r.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("reset clears everything", () => {
    const { writer, renders, step } = harness();
    writer.push("draft text");
    step();
    writer.reset();
    expect(renders.at(-1)).toBe("");
    expect(writer.received).toBe("");
  });

  it("replace keeps the matching prefix and rewrites the rest", () => {
    const { writer, renders, runAll } = harness();
    writer.push("The answer is 42");
    runAll();
    writer.replace("The answer is 42.");
    runAll();
    expect(renders.at(-1)).toBe("The answer is 42.");
    writer.replace("Different");
    runAll();
    expect(renders.at(-1)).toBe("Different");
  });

  it("flushAll reveals immediately and resolves drained", async () => {
    const { writer, renders } = harness();
    writer.push("long ".repeat(200));
    const done = vi.fn();
    writer.drained().then(done);
    writer.flushAll();
    await Promise.resolve();
    expect(renders.at(-1)).toBe("long ".repeat(200));
    expect(done).toHaveBeenCalled();
  });

  it("drained resolves after the animation finishes", async () => {
    const { writer, runAll } = harness();
    writer.push("abc def ghi");
    let resolved = false;
    const p = writer.drained().then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    runAll();
    await p;
    expect(resolved).toBe(true);
    await expect(writer.drained()).resolves.toBeUndefined();
  });

  it("instant mode skips animation for reduced motion", () => {
    const { writer, renders, frames } = harness({ instant: true });
    writer.push("no animation");
    expect(renders).toEqual(["no animation"]);
    expect(frames).toHaveLength(0);
  });

  it("cancel releases waiters", async () => {
    const { writer } = harness();
    writer.push("pending");
    const p = writer.drained();
    writer.cancel();
    await expect(p).resolves.toBeUndefined();
  });
});
