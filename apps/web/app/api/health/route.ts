import { app } from "@/lib/server";

export const dynamic = "force-dynamic";

/** For the host's health check (Railway): the app is up and can reach its database. Says nothing else. */
export async function GET(): Promise<Response> {
  try {
    await app().pool.query("SELECT 1");
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
