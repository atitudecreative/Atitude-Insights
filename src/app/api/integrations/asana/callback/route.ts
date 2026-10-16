import type { NextRequest } from "next/server";
import { oauthCallback } from "@/server/services/oauth-routes";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return oauthCallback("asana", req);
}
