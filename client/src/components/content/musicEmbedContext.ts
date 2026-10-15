import { createContext } from "react";
import { stripMediaGrant } from "@ishtarservices/core";

/**
 * The pictures the surrounding note already shows, as `coverKey`s. A music
 * card whose cover is one of them drops its thumb instead of painting the
 * same picture twice (soot `NoteMediaContext`).
 */
export const NoteMediaContext = createContext<readonly string[]>([]);

/**
 * How a music embed draws at the top level. `poster`: chat rows and DMs show
 * a public track or project as its cover with the title on it; anything else
 * (private, a folder, nested) keeps the row.
 */
export type MusicEmbedShape = "row" | "poster";
export const MusicEmbedShapeContext = createContext<MusicEmbedShape>("row");

/** Comparable form of an image URL: grant token dropped, WHATWG-normalised. */
export function coverKey(url: string): string {
  const plain = stripMediaGrant(url.trim());
  try {
    return new URL(plain).href;
  } catch {
    return plain;
  }
}
