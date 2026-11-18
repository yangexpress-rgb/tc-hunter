import { relayTodo } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** The Workday sites to read in this browser, and the roles to search them for (Yong, 2026-11-18). */
export async function GET(req: Request): Promise<Response> {
  return extCall(req, (owner) => relayTodo(app().pool, owner));
}
