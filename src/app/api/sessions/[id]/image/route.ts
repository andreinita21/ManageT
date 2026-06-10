/**
 * POST /api/sessions/[id]/image — push an image to the session's host.
 *
 * Multipart form upload (`file` field). The image is written to a
 * world-readable temp file on the server that owns the session, and the
 * remote path is returned. The browser then pastes that path into the
 * terminal, which is exactly how drag-and-drop onto a local terminal
 * delivers an image to Claude Code — it sees a pasted path to an image
 * file and attaches it.
 *
 * Why a file path instead of "put it in the remote clipboard": managed
 * hosts are headless. There is no X/Wayland clipboard for xclip/wl-paste
 * to read, so a literal remote Ctrl+V can never work reliably. A path in
 * /tmp works everywhere and for every PTY user (mode 0644).
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { writeRemoteFile } from "@/lib/ssh/sftp-write";

/** Screenshots are typically well under 1MB; 10MB leaves headroom for
 *  retina-scale captures without letting the route become a generic
 *  file-push channel. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Sniff the actual content instead of trusting the client's MIME type.
 *  Returns the extension to use on the remote file, or null when the
 *  bytes aren't one of the image formats Claude Code understands. */
function sniffImageExt(buf: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Writes a file to a managed host and feeds terminal input — same
  // privilege tier as the other session-mutating routes.
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const rows = await db
    .select({ serverId: sessions.serverId })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a `file` field" },
      { status: 400 }
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing `file` field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large (max ${MAX_BYTES / 1024 / 1024}MB)` },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffImageExt(buf);
  if (!ext) {
    return NextResponse.json(
      { error: "Not a supported image (png, jpeg, gif, webp)" },
      { status: 415 }
    );
  }

  // /tmp because it's the one place writable by the SSH user and
  // readable by whatever user the PTY runs as, and the OS reaps it.
  // The fixed prefix makes stragglers easy to spot and clean.
  const remotePath = `/tmp/managet-img-${randomUUID().slice(0, 8)}.${ext}`;
  try {
    await writeRemoteFile(rows[0].serverId, remotePath, buf, 0o644);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to write image to server: ${msg}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ data: { remotePath } });
}
