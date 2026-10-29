import { withUserPage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { AccountPanel } from "@/components/auth/account-panel";
function AccountPage() {
  return (
    <main className="container">
      <PageHeader
        eyebrow="YOUR ACCOUNT"
        title="Account"
        description="Your profile, password and signed-in devices."
      />
      <AccountPanel />
    </main>
  );
}
export const metadata = { title: "Account" };
export default withUserPage(AccountPage, true);
