"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Activity,
  Server,
  Folder,
  Users,
  ShieldCheck,
  Check,
  Plus,
  Search,
  ChevronRight,
  LockKeyhole,
  Network,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import styles from "./marketing-landing.module.css";
import { MarketingShowcase } from "./marketing-showcase";

const communityLogos = [
  {
    name: "Vital",
    href: "https://vitalrust.com/",
    asset: "vital.png",
    width: 317,
    height: 76,
  },
  {
    name: "Wicked",
    href: "https://wickedrust.net/",
    asset: "wicked.png",
    width: 786,
    height: 786,
  },
  {
    name: "Vitality",
    href: "https://vitalityrust.com/",
    asset: "vitality.png",
    width: 1686,
    height: 1562,
  },
  {
    name: "Atlas",
    href: "https://atlasrust.com/",
    asset: "atlas.svg",
    width: 1500,
    height: 600,
  },
  {
    name: "Physgun",
    href: "https://physgun.com/",
    asset: "physgun.png",
    width: 1703,
    height: 500,
  },
  {
    name: "GameServerKings",
    href: "https://www.gameserverkings.com/",
    asset: "gsk.svg",
    width: 162,
    height: 30,
  },
];

function HeroGraph() {
  const id = useId();
  const curve =
    "M-20 145 C85 158 155 182 250 190 C295 190 325 190 350 179 C380 166 394 153 430 153 C461 153 478 161 510 157 C545 157 560 126 590 118 C620 110 650 122 680 117 C720 114 734 82 770 76 C800 70 824 83 855 77 C890 70 920 40 1020 25";
  const fullCurve = `M-2020 110 C-700 110 -200 122 -20 145 ${curve.replace("M-20 145", "")} C1150 5.5 1450 -5 3020 -5`;
  const checkpoints = [
    { x: 250, y: 190, label: "SERVER HEALTH" },
    { x: 510, y: 157, label: "TICK RATE" },
    { x: 680, y: 117, label: "PLAYER ACTIVITY" },
    { x: 855, y: 77, label: "MACHINE LOAD" },
  ];
  return (
    <div className={styles.heroGraph} aria-hidden="true">
      <div className={styles.heroGraphCore}>
        <svg
          className={styles.heroSignal}
          viewBox="0 0 1000 260"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient
              id={`${id}-glow`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="-250"
              x2="0"
              y2="190"
            >
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity=".2" />
            </linearGradient>
            <filter
              id={`${id}-soften`}
              x="-20%"
              y="-100%"
              width="140%"
              height="300%"
            >
              <feGaussianBlur stdDeviation="18" />
            </filter>
            <mask
              id={`${id}-band`}
              maskUnits="userSpaceOnUse"
              x="-2220"
              y="-250"
              width="5440"
              height="750"
            >
              <path
                d={fullCurve}
                fill="none"
                stroke="white"
                strokeWidth="150"
                filter={`url(#${id}-soften)`}
              />
            </mask>
          </defs>
          <path
            d={`${fullCurve} L3020 -250 L-2020 -250 Z`}
            fill={`url(#${id}-glow)`}
            mask={`url(#${id}-band)`}
          />
          <path d={fullCurve} fill="none" className={styles.heroCurve} />
          {checkpoints.map(({ x, y, label }) => (
            <g key={label}>
              <path
                d={`M${x} ${y - 10} V${y + 10}`}
                className={styles.checkpointTick}
              />
            </g>
          ))}
        </svg>
        {checkpoints.map(({ x, y, label }) => (
          <span
            key={`dot-${label}`}
            className={styles.graphDot}
            style={{ left: `${x / 10}%`, top: `${y / 2.6}%` }}
          />
        ))}
        {checkpoints.map(({ x, y, label }) => (
          <span
            key={label}
            className={styles.graphLabel}
            style={{ left: `${x / 10}%`, top: `${y / 2.6}%` }}
          >
            {label}
            <span className={styles.checkpointStatus}>CONNECTED</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const steps = [
  {
    id: "organization",
    title: "Make a place for your team",
    description:
      "Create an organization. Invite your operators and give each role the permissions it needs.",
  },
  {
    id: "server",
    title: "Connect your Rust server",
    description:
      "Save your server's connection details, then test the connection. Cupboard keeps the credential encrypted.",
  },
  {
    id: "monitor",
    title: "See what needs your attention",
    description:
      "Check server health and player counts. Enroll a machine to see CPU, memory, storage, and network activity.",
  },
];
const faqs = [
  {
    question: "What is Cupboard?",
    answer:
      "Cupboard is a workspace for Rust server operators. It brings server connection details, health readings, machine monitoring, files, and organization access into one place.",
  },
  {
    question: "Does Cupboard host my game servers?",
    answer:
      "Your servers stay on your infrastructure. Cupboard connects to them so you can inspect their state and manage your organization around them.",
  },
  {
    question: "Can I use Cupboard with a team?",
    answer:
      "Yes. Create an organization, invite members, and assign roles. Permissions control what members can view and manage, and each organization's data stays separate.",
  },
  {
    question: "How are server credentials handled?",
    answer:
      "Saved server credentials are encrypted and tied to the server record. Connection checks use those credentials without returning the raw secret to the browser.",
  },
  {
    question: "How do I get started?",
    answer:
      "Create an account, create or join an organization, and add a Rust server. Test the connection to verify the setup. Machine monitoring uses a separately enrolled agent.",
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className={styles.eyebrow}>
      <span />
      {children}
    </p>
  );
}
function Action({ children = "Get started" }: { children?: React.ReactNode }) {
  return (
    <Button asChild className="h-11 gap-3 rounded-full px-5">
      <Link href="/signup">
        {children}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </Button>
  );
}
function SignalGraph({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`${styles.signalGraph} ${className}`}
      viewBox="0 0 1000 220"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path
        className={styles.graphBase}
        d="M0 145C80 145 95 180 160 160S250 165 310 125S390 130 450 100S510 125 580 75S650 90 720 55S810 85 890 35S960 50 1000 15"
      />
      <path
        className={styles.graphLine}
        d="M0 145C80 145 95 180 160 160S250 165 310 125S390 130 450 100S510 125 580 75S650 90 720 55S810 85 890 35S960 50 1000 15"
        pathLength="1"
      />
      <circle cx="1000" cy="15" r="4" fill="currentColor" />
    </svg>
  );
}
function ServerScene({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`${styles.serverScene} ${compact ? styles.compactScene : ""}`}
      role="img"
      aria-label="Illustration of Cupboard server management and machine monitoring"
    >
      <div className={styles.sceneSidebar}>
        <Image src="/images/cupboard-logo.png" alt="" width={24} height={24} />
        <span>Operations</span>
        <div>
          <Activity />
          Dashboard
        </div>
        <div className={styles.sceneSelected}>
          <Server />
          Servers
        </div>
        <div>
          <Network />
          Machines
        </div>
        <div>
          <Folder />
          Files
        </div>
        <span>Organization</span>
        <div>
          <Users />
          Team
        </div>
        <div>
          <ShieldCheck />
          Security
        </div>
      </div>
      <div className={styles.sceneMain}>
        <div className={styles.sceneBreadcrumb}>
          Cupboard <ChevronRight /> Operations
        </div>
        <div className={styles.sceneHeading}>
          <div>
            <p>Server overview</p>
            <h3>Your servers, together.</h3>
          </div>
          <span className={styles.sceneAdd}>
            <Plus />
            Add server
          </span>
        </div>
        <div className={styles.sceneSearch}>
          <Search />
          Search your servers
        </div>
        <div className={styles.sceneTable}>
          {["Main server", "Community server", "Build server"].map(
            (name, i) => (
              <div className={styles.sceneRow} key={name}>
                <span className={styles.serverIcon}>
                  <Server />
                </span>
                <div>
                  <strong>{name}</strong>
                  <span>Rust dedicated server</span>
                </div>
                <span className={styles.sceneStatus}>
                  <span />
                  {i === 2 ? "Ready to connect" : "Connection checked"}
                </span>
                <ChevronRight />
              </div>
            ),
          )}
        </div>
        <div className={styles.sceneMetrics}>
          <div>
            <span>Machine monitoring</span>
            <h4>Know your host.</h4>
            <SignalGraph />
          </div>
          <div>
            <span>Organization access</span>
            <h4>The right permissions.</h4>
            <div className={styles.permissionDots}>
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function WorldMap() {
  // A stylized dotted world silhouette, decorative rather than a location dataset.
  const continents = [
    "60,48 94,24 135,20 183,35 210,60 192,80 156,77 133,110 108,98 87,75 61,72",
    "160,112 184,122 199,155 186,187 174,213 158,177 145,140",
    "262,49 287,35 310,42 314,70 289,83 270,67",
    "281,84 324,83 350,111 328,156 306,177 287,146 271,108",
    "317,41 357,25 408,35 455,25 496,52 482,78 445,91 420,119 393,105 375,82 346,74",
    "437,156 469,143 503,163 494,186 463,185 439,176",
    "227,21 247,13 253,40 239,49",
  ];
  return (
    <svg
      viewBox="0 0 560 240"
      className={styles.worldMap}
      role="img"
      aria-label="Decorative dotted world map"
    >
      <defs>
        <pattern
          id="cupboard-map-dots"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r="1" fill="currentColor" />
        </pattern>
      </defs>
      <g fill="url(#cupboard-map-dots)">
        {continents.map((points, i) => (
          <polygon points={points} key={i} />
        ))}
      </g>
      <g className={styles.mapConnections} fill="none">
        <path d="M120 62Q270 -10 290 59Q405 10 464 68M120 62Q285 194 464 68" />
      </g>
      {[
        [120, 62],
        [290, 59],
        [464, 68],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="9" className={styles.mapHalo} />
          <circle cx={cx} cy={cy} r="3" className={styles.mapPoint} />
        </g>
      ))}
    </svg>
  );
}

function ScrambleHeadline() {
  const phrase = "Life's too short to babysit your servers.";
  const [display, setDisplay] = useState(phrase);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    let frame = 0;
    let start: number | undefined;
    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const tick = (time: number) => {
      start ??= time;
      const progress = Math.min((time - start) / 1400, 1);
      setDisplay(
        [...phrase]
          .map((letter, index) => {
            if (letter === " " || index < progress * phrase.length)
              return letter;
            return glyphs[(index * 7 + Math.floor(time / 65)) % glyphs.length];
          })
          .join(""),
      );
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      setDisplay(phrase);
    };
    preference.addEventListener("change", stop);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", stop);
    };
  }, []);
  return (
    <h1 id="hero-title" className={styles.dotTitle} aria-label={phrase}>
      <span aria-hidden="true">
        {display.slice(0, 20)}
        <br className="hidden sm:block" />
        {display.slice(20)}
      </span>
    </h1>
  );
}

export function MarketingLanding() {
  const root = useRef<HTMLElement>(null);
  const [step, setStep] = useState("organization");
  useEffect(() => {
    const page = root.current;
    if (
      !page ||
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-revealed", "true");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.08 },
    );
    for (const element of page.querySelectorAll("[data-reveal]")) {
      element.setAttribute("data-revealed", "false");
      observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <main ref={root} id="main-content" className={styles.landing}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroLight} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className={styles.heroCopy}>
          <ScrambleHeadline />
          <h2>
            Rust server operations.
            <br />
            <span className="sr-only">
              Your servers, machines, files, and team together.
            </span>
            <span className={styles.rotatingCopy} aria-hidden="true">
              <span>Your servers, together.</span>
              <span>Your machines, in view.</span>
              <span>Your files, in one place.</span>
              <span>Your team, connected.</span>
            </span>
          </h2>
          <p>
            Bring your servers, machines, files, and team into Cupboard. Know
            what&apos;s running, see what needs attention, and keep the details
            together.
          </p>
          <Action />
        </div>
        <HeroGraph />
        <div
          className={styles.logoViewport}
          aria-label="Rust communities and hosting providers"
        >
          <div className={styles.logoMarquee}>
            {[0, 1].map((copy) => (
              <div
                className={styles.logoGroup}
                key={copy}
                aria-hidden={copy === 1 ? true : undefined}
              >
                {communityLogos.map((logo) => (
                  <a
                    key={logo.name}
                    href={logo.href}
                    tabIndex={copy === 1 ? -1 : undefined}
                    className={styles.communityLogo}
                  >
                    <Image
                      src={`/images/marketing-logos/${logo.asset}`}
                      alt={copy === 1 ? "" : logo.name}
                      width={logo.width}
                      height={logo.height}
                      unoptimized
                      loading="eager"
                    />
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="overview"
        className={`${styles.section} ${styles.overviewSection}`}
        data-reveal
      >
        <div className={styles.sectionHeading}>
          <div>
            <h2 className={styles.overviewHeading}>
              Everything that runs your servers. In one place.
            </h2>
          </div>
        </div>
        <MarketingShowcase />
      </section>

      <section
        id="servers"
        className={`${styles.section} ${styles.setupSection}`}
        data-reveal
      >
        <div className={styles.setupCopy}>
          <Eyebrow>Connect</Eyebrow>
          <h2>
            From your first server
            <br />
            to your whole operation.
          </h2>
          <p>You bring the infrastructure. Cupboard brings the workspace.</p>
          <Accordion
            type="single"
            value={step}
            onValueChange={(value) => {
              if (value) setStep(value);
            }}
            className={styles.steps}
          >
            {steps.map((item, i) => (
              <AccordionItem value={item.id} key={item.id}>
                <AccordionTrigger className="min-h-16 py-5 hover:no-underline">
                  <span className={styles.stepTitle}>
                    <span>0{i + 1}</span>
                    {item.title}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-5 pl-8 text-muted-foreground leading-6">
                  {item.description}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
        <div className={styles.setupVisual}>
          <div className={styles.setupCard}>
            <Image
              src="/images/cupboard-logo.png"
              alt=""
              width={32}
              height={32}
            />
            <span className={styles.setupCardLabel}>Your next step</span>
            <h3>
              {step === "organization"
                ? "A home for your team."
                : step === "server"
                  ? "Connect with confidence."
                  : "Keep an eye on the details."}
            </h3>
            <div className={styles.setupFields}>
              {(step === "organization"
                ? ["Organization", "Members and roles", "Permissions"]
                : step === "server"
                  ? [
                      "Server address",
                      "Encrypted credential",
                      "Test connection",
                    ]
                  : ["Server health", "Player count", "Machine resources"]
              ).map((text, i) => (
                <div key={text}>
                  <span>{text}</span>
                  {i === 2 ? (
                    <CircleCheck />
                  ) : (
                    <span className={styles.fieldLine} />
                  )}
                </div>
              ))}
            </div>
            <Link href="/signup" className={styles.setupCardAction}>
              Create your account
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <section
        id="machines"
        className={`${styles.section} ${styles.mapSection}`}
        data-reveal
      >
        <div className={styles.sectionHeading}>
          <div>
            <Eyebrow>Your infrastructure, connected</Eyebrow>
            <h2 className={styles.dotHeading}>
              Wherever your servers run,
              <br />
              keep the same view.
            </h2>
            <p>
              Enroll your machines and bring their reports into the same
              organization as your Rust servers.
            </p>
          </div>
          <div className={styles.mapAside}>
            <Network className="size-8" />
            <span>
              Your hosts.
              <br />
              Your infrastructure.
            </span>
          </div>
        </div>
        <WorldMap />
        <div className={styles.mapLegend}>
          <span />
          Connected through your enrolled agents
        </div>
      </section>

      <section className={styles.section} data-reveal>
        <div className={styles.centerHeading}>
          <Eyebrow>See the whole picture</Eyebrow>
          <h2 className={styles.dotHeading}>
            Know the state.
            <br />
            Choose the next step.
          </h2>
        </div>
        <div className={styles.featureColumns}>
          {[
            {
              icon: Activity,
              title: "Inspect your servers",
              text: "See saved health readings and player counts, with clear report times and stale states.",
            },
            {
              icon: Network,
              title: "Understand your machines",
              text: "CPU, memory, disk, uptime, and network activity sit alongside the hosts they belong to.",
            },
            {
              icon: Users,
              title: "Work with your team",
              text: "Keep memberships, roles, and organization permissions in the same workspace.",
            },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon className="size-5 text-primary" />
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <div className={styles.landscapeShowcase}>
          <Image
            src="/images/cupboard-coastal-operations.webp"
            alt=""
            fill
            sizes="(max-width: 768px) 100vw, 1200px"
            className="object-cover"
          />
          <div className={styles.landscapeOverlay} />
          <div className={styles.landscapeWindow}>
            <ServerScene compact />
          </div>
        </div>
      </section>

      <section className={styles.section} data-reveal>
        <div className={styles.centerHeading}>
          <Eyebrow>Built for the details</Eyebrow>
          <h2 className={styles.dotHeading}>
            A workspace you can
            <br />
            keep coming back to.
          </h2>
        </div>
        <div className={styles.proofCards}>
          <article>
            <Eyebrow>Credentials</Eyebrow>
            <h3>Encrypted, at rest.</h3>
            <p>
              Connection secrets are tied to their server records and kept out
              of browser responses.
            </p>
            <div className={styles.lockVisual} aria-hidden="true">
              <LockKeyhole />
              <div className={styles.permissionDots}>
                {Array.from({ length: 40 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            </div>
          </article>
          <article>
            <Eyebrow>Health</Eyebrow>
            <h3>Freshness is visible.</h3>
            <p>
              Report times and explicit stale readings help you distinguish
              known state from old information.
            </p>
            <div className={styles.healthVisual} aria-hidden="true">
              <span>Report received</span>
              <SignalGraph />
              <span>
                <CircleCheck />
                Know when it was checked
              </span>
            </div>
          </article>
          <article>
            <Eyebrow>Organizations</Eyebrow>
            <h3>Access has boundaries.</h3>
            <p>
              Memberships and permissions keep each organization&apos;s servers
              and files separate.
            </p>
            <div className={styles.accessVisual} aria-hidden="true">
              {["Owner", "Administrator", "Custom roles"].map((t) => (
                <div key={t}>
                  <Users />
                  <span>{t}</span>
                  <Check />
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section id="files" className={styles.section} data-reveal>
        <div className={styles.sectionHeading}>
          <div>
            <Eyebrow>One workspace, different tasks</Eyebrow>
            <h2 className={styles.dotHeading}>
              Your operation doesn&apos;t
              <br />
              stop at the server.
            </h2>
          </div>
          <p>
            Move between the state of your servers, the health of your hosts,
            and the files your organization uses.
          </p>
        </div>
        <Tabs defaultValue="servers" className={styles.productTabs}>
          <TabsList className="h-auto flex-wrap bg-transparent p-0">
            <TabsTrigger value="servers" className="min-h-11 px-5">
              Servers
            </TabsTrigger>
            <TabsTrigger value="machines" className="min-h-11 px-5">
              Machines
            </TabsTrigger>
            <TabsTrigger value="files" className="min-h-11 px-5">
              Files
            </TabsTrigger>
          </TabsList>
          <TabsContent value="servers">
            <div className={styles.tabFeature}>
              <div>
                <Server />
                <h3>Start with the connection.</h3>
                <p>
                  Save server details and test connectivity. Keep credentials
                  protected and health readings close to hand.
                </p>
                <Action>Connect your servers</Action>
              </div>
              <ServerScene compact />
            </div>
          </TabsContent>
          <TabsContent value="machines">
            <div className={styles.tabFeature}>
              <div>
                <Activity />
                <h3>Look beneath the game.</h3>
                <p>
                  Enroll your hosts to inspect resource use, uptime, and network
                  activity. Open a machine to explore its recent reports.
                </p>
                <Action>Bring your machines</Action>
              </div>
              <div className={styles.machinePanel}>
                <span>Machine monitoring</span>
                <h3>CPU · Memory · Storage</h3>
                <SignalGraph />
                <div>
                  <span>Resource history</span>
                  <span>Report timestamps</span>
                </div>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="files">
            <div className={styles.tabFeature}>
              <div>
                <Folder />
                <h3>A place for the files.</h3>
                <p>
                  Organize folders, upload files, and share access. Your library
                  stays scoped to your organization.
                </p>
                <Action>Organize your workspace</Action>
              </div>
              <div className={styles.filePanel}>
                {[
                  "Server configuration",
                  "Team documents",
                  "Shared assets",
                ].map((t) => (
                  <div key={t}>
                    <Folder />
                    <span>{t}</span>
                    <ChevronRight />
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </section>

      <section id="team" className={styles.section} data-reveal>
        <Eyebrow>For the people behind the servers</Eyebrow>
        <h2 className={styles.dotHeading}>
          Different roles.
          <br />
          The same control room.
        </h2>
        <div className={styles.storyPanel}>
          <div className={styles.storyArt}>
            <Image
              src="/images/cupboard-coastal-operations.webp"
              alt="Pixel art of a coastal Rust base and an operator's desk"
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
            />
            <span>Built around your operation.</span>
          </div>
          <div className={styles.storyCopy}>
            <Image
              src="/images/cupboard-logo.png"
              alt=""
              width={32}
              height={32}
            />
            <h3>
              Keep the handoff
              <br />
              inside the workspace.
            </h3>
            <p>
              A solo operator needs context. A team needs context and clear
              access. Cupboard keeps the organization, its servers, and its
              members together.
            </p>
            <ul>
              <li>
                <Check />
                Create and join organizations
              </li>
              <li>
                <Check />
                Invite members and assign roles
              </li>
              <li>
                <Check />
                Manage access with scoped permissions
              </li>
            </ul>
            <Action>Make room for your team</Action>
          </div>
        </div>
      </section>

      <section
        id="faq"
        className={`${styles.section} ${styles.faqSection}`}
        data-reveal
      >
        <div>
          <Eyebrow>A few useful answers</Eyebrow>
          <h2 className={styles.dotHeading}>
            Before you
            <br />
            get started.
          </h2>
        </div>
        <Accordion type="single" collapsible>
          {faqs.map((faq, i) => (
            <AccordionItem value={`faq-${i}`} key={faq.question}>
              <AccordionTrigger className="min-h-16 py-5 text-base">
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="max-w-xl pb-5 text-sm leading-7 text-muted-foreground">
                {faq.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      <section id="pricing" className={styles.closing} data-reveal>
        <div className={styles.closingGrid} aria-hidden="true" />
        <Eyebrow>Your next server starts here</Eyebrow>
        <h2 className={styles.dotHeading}>
          Less chasing details.
          <br />
          More running your servers.
        </h2>
        <p>Create your Cupboard account and bring your operation together.</p>
        <Action>Create an account</Action>
      </section>
      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <div>
            <Link href="/" className={styles.footerBrand}>
              <Image
                src="/images/cupboard-logo.png"
                alt=""
                width={32}
                height={32}
              />
              Cupboard
            </Link>
            <p>
              Rust server operations,
              <br />
              with the details together.
            </p>
          </div>
          <nav aria-label="Footer product">
            <h3>Product</h3>
            <Link href="#servers">Server management</Link>
            <Link href="#machines">Machine monitoring</Link>
            <Link href="#files">File library</Link>
            <Link href="#team">Organization and team</Link>
          </nav>
          <nav aria-label="Footer documentation">
            <h3>Docs</h3>
            <Link href="/#docs-getting-started">Getting started</Link>
            <Link href="/#docs-integrations">Integrations</Link>
            <Link href="/#docs-user-management">User management</Link>
            <Link href="/#docs-identity-providers">Identity providers</Link>
          </nav>
          <nav aria-label="Footer resources">
            <h3>Resources</h3>
            <Link href="/#guides">Guides</Link>
            <Link href="/#changelog">Changelog</Link>
            <Link href="#faq">Questions and answers</Link>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <span>© {new Date().getFullYear()} Cupboard</span>
          <a href="#main-content">
            Back to top
            <ArrowRight className="size-3 -rotate-90" />
          </a>
        </div>
      </footer>
    </main>
  );
}
