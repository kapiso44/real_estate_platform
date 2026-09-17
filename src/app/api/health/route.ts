import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ db: "ok" });
  } catch (error) {
    return NextResponse.json(
      { db: "error", message: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
