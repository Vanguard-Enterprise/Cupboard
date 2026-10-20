"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Server, Activity, Folder, X, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
} from "@/components/ui/navigation-menu";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";

const productLinks = [
  {
    title: "Server management",
    description: "Keep your Rust servers together.",
    href: "/#servers",
    icon: Server,
  },
  {
    title: "Machine monitoring",
    description: "See the state of your infrastructure.",
    href: "/#machines",
    icon: Activity,
  },
  {
    title: "File library",
    description: "Organize and share your server files.",
    href: "/#files",
    icon: Folder,
  },
];
const docs = [
  {
    title: "Getting started",
    description: "Set up your organization and first server.",
    href: "/#docs-getting-started",
  },
  {
    title: "Integrations",
    description: "Connect the services you use.",
    href: "/#docs-integrations",
  },
  {
    title: "User management",
    description: "Manage members, roles, and permissions.",
    href: "/#docs-user-management",
  },
  {
    title: "Identity providers",
    description: "Configure sign-in for your organization.",
    href: "/#docs-identity-providers",
  },
  {
    title: "Servers and machines",
    description: "Connect servers and monitor your hosts.",
    href: "/#docs-servers-machines",
  },
];
const resources = [
  {
    title: "Guides",
    description: "Practical help for server operators.",
    href: "/#guides",
  },
  {
    title: "Changelog",
    description: "See what's new in Cupboard.",
    href: "/#changelog",
  },
  {
    title: "Support",
    description: "Get help with your setup.",
    href: "/#support",
  },
];
const linkStyle =
  "inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-surface-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

export function MarketingNavbar() {
  const pathname = usePathname();
  const [announcementOpen, setAnnouncementOpen] = useState(true);
  if (
    pathname === "/join" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/dashboard" ||
    pathname?.startsWith("/dashboard/")
  )
    return null;
  return (
    <>
      {announcementOpen && (
        <div className="relative flex min-h-11 items-center justify-center border-b border-border/50 bg-black px-14 py-2 text-center text-xs">
          <Link
            href="/#changelog"
            className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>
              Cupboard 5 is here. Your servers, a little more together.
            </span>
            <span className="inline-flex items-center gap-1 underline">
              Explore what&apos;s new{" "}
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </span>
          </Link>
          <button
            type="button"
            aria-label="Dismiss announcement"
            onClick={() => setAnnouncementOpen(false)}
            className="absolute right-2 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <header className="sticky top-0 z-40 bg-background/95 text-foreground backdrop-blur-xl">
        <div className="relative mx-auto flex min-h-24 max-w-[1600px] items-center justify-between gap-3 px-[4.5%]">
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="inline-flex min-h-11 w-fit items-center gap-2.5 rounded-lg px-2 text-base font-medium tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Cupboard home"
            >
              <Image
                src="/images/cupboard-logo.png"
                loading="eager"
                alt=""
                width={32}
                height={32}
              />
            </Link>
            <NavigationMenu
              aria-label="Marketing"
              viewport={false}
              className="absolute left-1/2 hidden -translate-x-1/2 lg:flex"
            >
              <NavigationMenuList className="gap-3">
                <NavigationMenuItem>
                  <NavigationMenuTrigger className={linkStyle}>
                    Product
                  </NavigationMenuTrigger>
                  <NavigationMenuContent className="left-1/2 grid -translate-x-1/2 md:w-[720px] grid-cols-3 gap-3 border border-border/50 bg-background/95 p-6 backdrop-blur-xl motion-reduce:animate-none">
                    {productLinks.map(
                      ({ title, description, href, icon: Icon }) => (
                        <NavigationMenuLink asChild key={href}>
                          <Link
                            href={href}
                            className="group flex min-h-28 flex-col items-start gap-3 p-3"
                          >
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated">
                              <Icon aria-hidden="true" className="size-4" />
                            </span>
                            <span>
                              <span className="block font-medium">{title}</span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {description}
                              </span>
                            </span>
                          </Link>
                        </NavigationMenuLink>
                      ),
                    )}
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger className={linkStyle}>
                    Docs
                  </NavigationMenuTrigger>
                  <NavigationMenuContent className="left-1/2 grid -translate-x-1/2 md:w-[720px] grid-cols-3 gap-3 border border-border/50 bg-background/95 p-6 backdrop-blur-xl motion-reduce:animate-none">
                    {docs.map(({ title, description, href }) => (
                      <NavigationMenuLink asChild key={href}>
                        <Link
                          href={href}
                          className="min-h-11 flex-col items-start gap-1 p-3"
                        >
                          <span className="font-medium">{title}</span>
                          <span className="text-xs text-muted-foreground">
                            {description}
                          </span>
                        </Link>
                      </NavigationMenuLink>
                    ))}
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger className={linkStyle}>
                    Resources
                  </NavigationMenuTrigger>
                  <NavigationMenuContent className="left-1/2 grid -translate-x-1/2 md:w-[600px] grid-cols-3 gap-2 border border-border/50 bg-background/95 p-6 backdrop-blur-xl motion-reduce:animate-none">
                    {resources.map(({ title, description, href }) => (
                      <NavigationMenuLink asChild key={href}>
                        <Link
                          href={href}
                          className="min-h-11 flex-col items-start gap-1 p-3"
                        >
                          <span className="block font-medium">{title}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {description}
                          </span>
                        </Link>
                      </NavigationMenuLink>
                    ))}
                  </NavigationMenuContent>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          </div>
          <div className="hidden items-center gap-3 lg:flex">
            <Link href="/#pricing" className={linkStyle}>
              Pricing
            </Link>
            <Link
              href="/login"
              className="inline-flex h-11 items-center rounded-full px-4 text-sm outline-none transition-colors hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign in
            </Link>
            <Button
              asChild
              className="h-11 rounded-full bg-foreground px-6 text-background hover:bg-foreground/90"
            >
              <Link href="/signup">Get started</Link>
            </Button>
          </div>
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                className="h-11 gap-2 rounded-full px-4 lg:hidden"
              >
                <Menu aria-hidden="true" />
                Menu
              </Button>
            </SheetTrigger>
            <SheetContent
              className="overflow-y-auto bg-background p-6 motion-reduce:animate-none"
              closeButtonClassName="size-11"
            >
              <SheetTitle>Cupboard</SheetTitle>
              <SheetDescription>
                Explore Cupboard and access your account.
              </SheetDescription>
              <nav
                aria-label="Mobile marketing"
                className="flex flex-col gap-1"
              >
                <p className="px-3 pt-4 pb-2 text-xs text-muted-foreground">
                  Product
                </p>
                {productLinks.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <Link href={link.href} className={linkStyle}>
                      {link.title}
                    </Link>
                  </SheetClose>
                ))}
                <SheetClose asChild>
                  <Link href="/#pricing" className={linkStyle}>
                    Pricing
                  </Link>
                </SheetClose>
                <p className="px-3 pt-4 pb-2 text-xs text-muted-foreground">
                  Docs
                </p>
                {docs.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <Link
                      href={link.href}
                      className={`${linkStyle} flex-col items-start gap-1 py-3`}
                    >
                      <span className="text-foreground">{link.title}</span>
                      <span className="text-xs">{link.description}</span>
                    </Link>
                  </SheetClose>
                ))}
                <p className="px-3 pt-4 pb-2 text-xs text-muted-foreground">
                  Resources
                </p>
                {resources.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <Link
                      href={link.href}
                      className={`${linkStyle} flex-col items-start gap-1 py-3`}
                    >
                      <span className="text-foreground">{link.title}</span>
                      <span className="text-xs">{link.description}</span>
                    </Link>
                  </SheetClose>
                ))}
                <div className="mt-5 flex flex-col gap-2 border-t border-border pt-5">
                  <SheetClose asChild>
                    <Button asChild variant="outline" className="h-11">
                      <Link href="/login">Sign in</Link>
                    </Button>
                  </SheetClose>
                  <SheetClose asChild>
                    <Button asChild className="h-11">
                      <Link href="/signup">Get started</Link>
                    </Button>
                  </SheetClose>
                </div>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>
    </>
  );
}
