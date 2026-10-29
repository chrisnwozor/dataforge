import { withUserRoute } from "@/lib/auth/guards";
import { authEndpoint } from "@/lib/auth/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withUserRoute(authEndpoint("sign-out-everywhere"), true);
