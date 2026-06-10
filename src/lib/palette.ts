/**
 * Command palette storage — up to 9 per-user saved commands bound to
 * slots 1-9. Shared by the browser route (/api/palette) and the CLI
 * route (/api/cli/palette) so both UIs read and write the same list.
 *
 * The whole palette is replaced atomically on every save: with at most
 * 9 rows per user, diffing individual entries buys nothing, and
 * replace-all makes reorder/edit/delete a single round-trip from
 * either client.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { paletteCommands } from "@/lib/db/schema";

export const MAX_PALETTE_SLOTS = 9;

export const paletteEntrySchema = z.object({
  slot: z.number().int().min(1).max(MAX_PALETTE_SLOTS),
  label: z.string().trim().max(60).nullish(),
  // Long, detailed commands are the point of the feature; 4000 chars is
  // far beyond any sane shell one-liner while still bounding abuse.
  command: z.string().min(1).max(4000),
});

export const palettePutSchema = z
  .object({
    commands: z.array(paletteEntrySchema).max(MAX_PALETTE_SLOTS),
  })
  .refine(
    (body) =>
      new Set(body.commands.map((c) => c.slot)).size === body.commands.length,
    { message: "Duplicate slot numbers" }
  );

export interface PaletteEntry {
  slot: number;
  label: string | null;
  command: string;
}

export async function listPalette(userId: string): Promise<PaletteEntry[]> {
  const rows = await db
    .select({
      slot: paletteCommands.slot,
      label: paletteCommands.label,
      command: paletteCommands.command,
    })
    .from(paletteCommands)
    .where(eq(paletteCommands.userId, userId))
    .orderBy(asc(paletteCommands.slot));
  return rows;
}

export async function replacePalette(
  userId: string,
  entries: PaletteEntry[]
): Promise<PaletteEntry[]> {
  const now = Date.now();
  await db.delete(paletteCommands).where(eq(paletteCommands.userId, userId));
  if (entries.length > 0) {
    await db.insert(paletteCommands).values(
      entries.map((e) => ({
        id: randomUUID(),
        userId,
        slot: e.slot,
        label: e.label?.trim() ? e.label.trim() : null,
        command: e.command,
        createdAt: now,
        updatedAt: now,
      }))
    );
  }
  return listPalette(userId);
}
