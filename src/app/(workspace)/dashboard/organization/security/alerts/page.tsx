import { SecurityAlerts } from "@/components/security-alerts";

export const metadata = { title: "Security alerts | Cupboard" };

export default function SecurityAlertsPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1400px] py-6 md:w-[calc(100%-4rem)] md:py-8">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">
        Security alerts
      </h1>
      <SecurityAlerts />
    </div>
  );
}
