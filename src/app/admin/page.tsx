import { redirect } from "next/navigation";
import { computeLiabilities } from "@/lib/admin";
import { isAdmin } from "@/lib/auth";
import { AdminDashboard } from "@/components/admin-dashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) redirect("/admin/login");
  const data = await computeLiabilities();
  // Server component -> client component boundary: bigints become strings.
  const json = JSON.parse(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  return <AdminDashboard data={json} />;
}
