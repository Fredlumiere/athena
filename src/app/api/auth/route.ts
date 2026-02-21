import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

const correctPin = process.env.ATHENA_PIN || "athena2026";
// Derive a token from the PIN so we can verify remember-me without storing secrets client-side
const sessionToken = createHash("sha256").update(`athena:${correctPin}`).digest("hex").slice(0, 32);

export async function POST(req: NextRequest) {
  const { pin, token } = await req.json();

  // Remember-me: verify stored token
  if (token && token === sessionToken) {
    return NextResponse.json({ ok: true, token: sessionToken });
  }

  // PIN login
  if (pin === correctPin) {
    return NextResponse.json({ ok: true, token: sessionToken });
  }

  return NextResponse.json({ ok: false, error: "Incorrect code" }, { status: 401 });
}
