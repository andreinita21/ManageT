/**
 * GET /api/agent/binary/[target]
 *
 * Streams the pre-built agent binary for a given Rust target triple.
 * Used by:
 *   - The dashboard's SSH-push installer (on-host, no auth required: server
 *     only serves these to localhost in dev, and production deployments
 *     should not expose this port unauthenticated).
 *   - Manual installers downloading via curl (auth via NextAuth session —
 *     users must be logged in to fetch the binary).
 *
 * Auth: either a valid NextAuth session OR a dashboard-local request. We
 * keep this simple for v1: require a NextAuth session. The SSH-push
 * installer runs in-process and reads the file directly via `binaryPath()`
 * rather than going through HTTP, so this route is only for manual curl.
 */
import { NextResponse } from "next/server";
import { createReadStream, statSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { binaryExists, binaryPath, isAgentTarget } from "@/lib/agent/targets";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ target: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { target } = await params;
  if (!isAgentTarget(target)) {
    return NextResponse.json({ error: "Unknown target" }, { status: 404 });
  }
  if (!binaryExists(target)) {
    return NextResponse.json(
      { error: `Binary for ${target} not built. Run 'npm run build:agent'.` },
      { status: 404 }
    );
  }

  const path = binaryPath(target);
  const size = statSync(path).size;

  // Optional: include SHA256 header if the sha256 file is next to the binary.
  let sha256: string | undefined;
  try {
    const sumFile = readFileSync(`${path}.sha256`, "utf8");
    sha256 = sumFile.trim().split(/\s+/)[0];
  } catch {
    /* optional */
  }

  // Next.js 16 can consume a Web ReadableStream as the body. We convert the
  // node stream into a web stream so the runtime can pipe it efficiently.
  const nodeStream = createReadStream(path);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": size.toString(),
    "Content-Disposition": `attachment; filename="managet-agent"`,
  });
  if (sha256) headers.set("X-Sha256", sha256);

  return new Response(webStream, { status: 200, headers });
}
