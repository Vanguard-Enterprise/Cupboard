import Image from "next/image";
import Link from "next/link";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(400px,38fr)_62fr]">
      <div className="flex items-center justify-center px-6 py-12 sm:px-10 lg:px-12 xl:px-16">
        <div className="w-full max-w-[380px]">
          <Link
            href="/"
            className="mb-8 inline-flex min-h-11 items-center gap-2.5 rounded-lg font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Image
              src="/images/cupboard-logo.png"
              alt=""
              width={36}
              height={36}
              className="size-9"
            />
            <span>Cupboard</span>
          </Link>
          <LoginForm />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-card lg:block"
      >
        <Image
          src="/images/cupboard-coastal-operations.webp"
          alt=""
          fill
          fetchPriority="high"
          sizes="(min-width: 1053px) 62vw, (min-width: 1024px) calc(100vw - 400px), 1px"
          className="object-cover object-[50%_45%]"
        />
        <div className="absolute inset-0 bg-background/10" />
      </div>
    </main>
  );
}
