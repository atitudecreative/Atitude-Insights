import type { NextRequest } from "next/server";
import { oauthStart } from "@/server/services/oauth-routes";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return oauthStart("meta", req);
}
