import Image from "next/image";
import Link from "next/link";
import { SignupForm } from "@/components/signup-form";
import { FieldDescription } from "@/components/ui/field";

export default function SignupPage() {
  return (
    <div className="grid min-h-svh bg-background text-foreground lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link href="/" className="flex items-center gap-2 font-medium">
            <span className="flex size-7 items-center justify-center rounded-lg border border-sky-300/40 bg-sky-400/10 text-xs font-semibold text-sky-200">
              C
            </span>
            <span className="text-slate-100">Cupboard</span>
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <SignupForm />
            <div className="mt-6">
              <FieldDescription className="text-center">
                Already have an account? <Link href="/login">Sign in</Link>
              </FieldDescription>
            </div>
          </div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-slate-950 lg:block">
        <Image
          src="/placeholder.svg"
          alt=""
          fill
          priority
          className="object-cover opacity-35"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900/70 via-slate-950/65 to-blue-950/90" />
      </div>
    </div>
  );
}
