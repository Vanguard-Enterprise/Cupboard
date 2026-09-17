import Link from "next/link";
import { SignupForm } from "@/components/signup-form";
import { FieldDescription } from "@/components/ui/field";

export default function SignupPage() {
  return (
    <>
      <SignupForm />
      <div className="mt-6">
        <FieldDescription className="text-center">
          Already have an account? <Link href="/login">Sign in</Link>
        </FieldDescription>
      </div>
    </>
  );
}
