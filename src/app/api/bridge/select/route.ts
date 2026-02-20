import { NextRequest, NextResponse } from "next/server";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:8013";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${BRIDGE_URL}/v1/session/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Bridge error" }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Bridge unavailable" }, { status: 502 });
  }
}
