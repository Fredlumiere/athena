import { NextResponse } from "next/server";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:8013";

export async function GET() {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/sessions`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Bridge error" }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Bridge unavailable", sessions: [] },
      { status: 502 }
    );
  }
}
