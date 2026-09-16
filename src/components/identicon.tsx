"use client";

import { keccak256, stringToBytes } from "viem";

/**
 * Deterministic identicon for an address: a 5×5 horizontally-mirrored grid
 * (blockies-style) with colours derived from keccak256(address). No deps.
 */
export function Identicon({ address, size = 32, className = "" }: { address: string; size?: number; className?: string }) {
  const hex = keccak256(stringToBytes(address.toLowerCase())).slice(2);
  const bytes = Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const hue = (bytes[0] * 360) / 255;
  const hue2 = (hue + 120 + (bytes[1] % 90)) % 360;
  const bg = `hsl(${hue} 60% 92%)`;
  const fg = `hsl(${hue} 65% 45%)`;
  const spot = `hsl(${hue2} 70% 50%)`;
  // 15 cells decide the left 3 columns of 5 rows; mirror to the right.
  const cells: string[] = [];
  for (let row = 0; row < 5; row++) {
    const left: (string | null)[] = [];
    for (let col = 0; col < 3; col++) {
      const b = bytes[2 + row * 3 + col];
      left.push(b % 3 === 0 ? null : b % 3 === 1 ? fg : spot);
    }
    const rowCells = [...left, left[1], left[0]];
    rowCells.forEach((c, col) => {
      if (c) cells.push(`<rect x="${col}" y="${row}" width="1" height="1" fill="${c}"/>`);
    });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="${bg}"/>${cells.join("")}</svg>`;
  return (
    <span
      className={`inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 ${className}`}
      style={{ width: size, height: size, backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`, backgroundSize: "cover" }}
      aria-hidden
    />
  );
}
