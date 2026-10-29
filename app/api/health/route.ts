import { publicRoute } from "@/lib/auth/guards";
export const GET = publicRoute(async () => Response.json({ status: "ok" }));
