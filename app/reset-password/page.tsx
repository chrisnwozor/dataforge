import { publicPage } from "@/lib/auth/guards";
import { AuthForm } from "@/components/auth/auth-form";
export const metadata = { title: "Reset Password" };
async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthForm
      mode="reset-password"
      token={typeof params.token === "string" ? params.token : ""}
    />
  );
}
export default publicPage(Page);
