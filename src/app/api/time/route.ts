import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { server_ts: Date.now() },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}
