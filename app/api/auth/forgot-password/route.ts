import { publicRoute } from "@/lib/auth/guards";
import { authEndpoint } from "@/lib/auth/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = publicRoute(authEndpoint("forgot-password"));
