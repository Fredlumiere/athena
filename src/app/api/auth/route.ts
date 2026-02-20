import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { pin } = await req.json();
  const correctPin = process.env.ATHENA_PIN || "athena2026";

  if (pin === correctPin) {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "Incorrect code" }, { status: 401 });
}
