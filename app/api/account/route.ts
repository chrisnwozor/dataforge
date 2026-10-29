import { withUserRoute } from "@/lib/auth/guards";
import { accountDetails } from "@/lib/auth/accounts";
import { authEndpoint } from "@/lib/auth/http";
export const GET = withUserRoute(
  async () => Response.json(accountDetails()),
  true,
);
export const PUT = withUserRoute(authEndpoint("profile"), true);
export const DELETE = withUserRoute(authEndpoint("delete-account"), true);
