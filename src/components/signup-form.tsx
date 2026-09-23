import { AccountForm } from "./account-form";
export function SignupForm({ className }: React.ComponentProps<"form">) {
  return <AccountForm signup className={className} />;
}
