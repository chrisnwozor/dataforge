import { publicRoute } from "@/lib/auth/guards";
import { publicIdentity } from "@/lib/auth/http";
export const dynamic = "force-dynamic";
export const GET = publicRoute(publicIdentity);
