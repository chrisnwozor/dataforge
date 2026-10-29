import { publicPage } from "@/lib/auth/guards";
import { AuthForm } from "@/components/auth/auth-form";
export const metadata = { title: "Verify" };
async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthForm
      mode="verify"
      token={typeof params.token === "string" ? params.token : ""}
    />
  );
}
export default publicPage(Page);
