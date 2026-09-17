import { NextResponse } from "next/server";
import { getMeta } from "@/lib/offers";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getMeta());
  } catch (error) {
    console.error("GET /api/meta failed", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
