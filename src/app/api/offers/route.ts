import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { parseFilters, searchOffers } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    const filters = parseFilters(searchParams);
    return NextResponse.json(await searchOffers(filters));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "invalid_query_parameters",
          issues: error.issues.map((issue) => ({ field: issue.path.join(".") || "(root)", message: issue.message })),
        },
        { status: 400 },
      );
    }
    console.error("GET /api/offers failed", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
