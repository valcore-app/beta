import { AdminHeader } from "../../components/admin/admin-header";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen arena-shell">
      <AdminHeader />
      <main className="w-full px-6 py-10 lg:px-10">{children}</main>
    </div>
  );
}
