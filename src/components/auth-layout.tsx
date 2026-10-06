import Image, { getImageProps } from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  const artwork = {
    src: "/images/cupboard-coastal-operations.webp",
    alt: "",
    fill: true,
    sizes:
      "(min-width: 1053px) 62vw, (min-width: 1024px) calc(100vw - 400px), 1px",
  };
  const { props: artworkProps } = getImageProps(artwork);

  return (
    <main className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(400px,38fr)_62fr]">
      {/* Discover desktop artwork early without fetching the hidden mobile panel. */}
      <link
        rel="preload"
        as="image"
        href={artworkProps.src}
        imageSrcSet={artworkProps.srcSet}
        imageSizes={artworkProps.sizes}
        media="(min-width: 1024px)"
        fetchPriority="high"
      />
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
          {children}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-card lg:block"
      >
        <Image
          {...artwork}
          alt=""
          fetchPriority="high"
          className="object-cover object-[50%_45%]"
        />
        <div className="absolute inset-0 bg-background/10" />
      </div>
    </main>
  );
}
