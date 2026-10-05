import { AuthLayout } from "@/components/auth-layout";
import { SignupForm } from "@/components/signup-form";

export default function SignupPage() {
  return (
    <AuthLayout>
      <SignupForm />
    </AuthLayout>
  );
}
