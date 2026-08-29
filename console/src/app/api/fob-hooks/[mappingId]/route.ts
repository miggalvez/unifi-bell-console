import { NextResponse } from "next/server";
import { realAdapter } from "@/lib/protect/adapter";
import { dispatchFobPress } from "@/lib/fobs/dispatch";

export const dynamic = "force-dynamic";

/**
 * The NVR's Alarm Manager posts here when a keychain-remote button is pressed.
 * Auth is the per-mapping bearer token minted at provisioning time — never the
 * session cookie, and never anything read from the request body (the NVR owns
 * that format and it proves nothing).
 *
 * Everything the caller can fix gets a 4xx; everything else answers 200 fast —
 * an alarm whose webhook keeps "failing" invites the NVR to distrust it, and
 * the press itself was real even when the mapped action declines to run.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/fob-hooks/[mappingId]">) {
  const { mappingId } = await params;
  const id = Number(mappingId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

  const outcome = await dispatchFobPress(realAdapter, id, bearer);
  switch (outcome.kind) {
    case "unknown":
      return NextResponse.json({ error: "not found" }, { status: 404 });
    case "unauthorized":
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    case "disabled":
      return NextResponse.json({ status: "disabled" });
    case "duplicate":
      return NextResponse.json({ status: "duplicate" });
    case "rejected":
      return NextResponse.json({ status: "rejected", message: outcome.message });
    case "accepted":
      return NextResponse.json({ status: "accepted", action: outcome.action, note: outcome.note });
  }
}
