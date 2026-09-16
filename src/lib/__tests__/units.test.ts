import { describe, expect, it } from "vitest";
import { AmountError, formatAmount, parseAmount } from "@/lib/amounts";
import { memoFromOrderId, orderIdFromMemo } from "@/lib/memo";
import { nonceKeyFor } from "@/lib/nonce-key";
import { classifyError } from "@/lib/chain";

describe("amounts", () => {
  it("parses decimals exactly once, at the edge", () => {
    expect(parseAmount("25")).toBe(25_000_000n);
    expect(parseAmount("25.5")).toBe(25_500_000n);
    expect(parseAmount("1.000001")).toBe(1_000_001n);
  });
  it("rejects junk, too many decimals, and out-of-range", () => {
    for (const bad of ["", "abc", "1e3", "-5", "1.2345678", "0.5", "10001"]) {
      expect(() => parseAmount(bad), bad).toThrow(AmountError);
    }
  });
  it("formats with thousands separators and 2+ decimals", () => {
    expect(formatAmount(1_234_567_890n)).toBe("1,234.56789");
    expect(formatAmount(25_000_000n)).toBe("25.00");
    expect(formatAmount(1n)).toBe("0.000001");
  });
});

describe("memo / nonce key", () => {
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  it("round-trips order id <-> bytes32 memo", () => {
    const memo = memoFromOrderId(id);
    expect(memo).toHaveLength(66);
    expect(memo.startsWith("0x00000000000000000000000000000000")).toBe(true);
    expect(orderIdFromMemo(memo)).toBe(id);
  });
  it("derives distinct keys per attempt and per order, within 256 bits", () => {
    const k0 = nonceKeyFor(id, 0);
    const k1 = nonceKeyFor(id, 1);
    expect(k0).not.toBe(k1);
    expect(k1 - k0).toBe(1n);
    expect(k0 >> 8n).toBe(BigInt(`0x${id.replaceAll("-", "")}`));
    expect(k0 < 1n << 136n).toBe(true);
    expect(() => nonceKeyFor(id, 256)).toThrow();
  });
});

describe("classifyError", () => {
  it("maps nonce-too-low to a landed signal", () => {
    expect(classifyError(new Error("nonce too low: next nonce 1"))).toMatchObject({ kind: "rejected", nonceTooLow: true });
  });
  it("maps transport failures to unknown", () => {
    expect(classifyError(Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }))).toMatchObject({ kind: "unknown" });
    expect(classifyError(new Error("Timed out while waiting for transaction"))).toMatchObject({ kind: "unknown" });
  });
  it("maps everything else to rejected", () => {
    expect(classifyError(new Error("insufficient funds for fee"))).toMatchObject({ kind: "rejected", nonceTooLow: false });
  });
  it("never stores RPC URLs or request payloads in the reason shown to users", () => {
    const err = Object.assign(new Error("HTTP request failed.\nURL: https://rpc.example/key123\nRequest body: {...}"), {
      name: "HttpRequestError",
      shortMessage: "HTTP request failed.",
      details: "https://rpc.example/key123 returned 502",
    });
    const out = classifyError(err);
    expect(out.kind).toBe("unknown");
    const reason = out.kind === "unknown" ? out.reason : "";
    expect(reason).not.toContain("key123");
    expect(reason).not.toContain("Request body");
    expect(reason.length).toBeLessThanOrEqual(200);
  });
});
