import { NextResponse } from "next/server";
import { getOfferById } from "@/lib/offers";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const offerId = Number(id);
  if (!Number.isInteger(offerId) || offerId <= 0) {
    return NextResponse.json({ error: "invalid_offer_id", message: `"${id}" is not an offer id` }, { status: 400 });
  }

  try {
    const offer = await getOfferById(offerId);
    if (!offer) return NextResponse.json({ error: "not_found", message: `offer ${offerId} does not exist` }, { status: 404 });
    return NextResponse.json(offer);
  } catch (error) {
    console.error(`GET /api/offers/${offerId} failed`, error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
