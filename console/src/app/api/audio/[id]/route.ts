import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { getApiUser } from "@/lib/auth/guards";
import { audioPath } from "@/lib/audio";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
};

/** Serves an uploaded file so staff can preview it in the browser. */
export async function GET(_req: Request, { params }: RouteContext<"/api/audio/[id]">) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const file = db
    .select()
    .from(schema.audioFiles)
    .where(eq(schema.audioFiles.id, Number(id)))
    .get();
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Path comes from the catalogue's random stored name, never from user input.
  const path = audioPath(file.storedName);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return NextResponse.json({ error: "file missing on disk" }, { status: 410 });
  }

  const ext = file.storedName.slice(file.storedName.lastIndexOf("."));
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": file.mimeType || MIME[ext] || "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
