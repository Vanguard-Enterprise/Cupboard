"use client";

import { useId, useRef, useState } from "react";
import Image from "next/image";
import {
  Activity,
  ArrowUpRight,
  Bell,
  ChevronRight,
  Folder,
  LayoutDashboard,
  Network,
  PanelLeft,
  Server,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import styles from "./marketing-showcase.module.css";
import { Switch } from "@/components/ui/switch";

const ranges = ["1W", "4W", "3M", "12M"] as const;
const readings = {
  "1W": [198, 194, 188, 181, 176, 178, 184, 194, 208, 202, 219, 216, 238, 248],
  "4W": [172, 184, 179, 195, 188, 202, 210, 207, 216, 225, 219, 236, 243, 254],
  "3M": [148, 157, 166, 162, 174, 186, 181, 196, 208, 202, 223, 237, 249, 267],
  "12M": [121, 138, 152, 146, 169, 183, 177, 198, 211, 226, 218, 245, 268, 289],
};
const navigation = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Servers", icon: Server },
  { label: "Machines", icon: Network },
  { label: "Performance", icon: Activity },
  { label: "Files", icon: Folder },
  { label: "Alerts", icon: Bell },
];

function chartPath(values: number[]) {
  const points = values.map((value, index) => ({
    x: 18 + (index * 864) / (values.length - 1),
    y: 485 - value * 1.4,
  }));
  return points.reduce((path, point, index) => {
    if (!index) return `M${point.x} ${point.y}`;
    const previous = points[index - 1];
    const middle = (previous.x + point.x) / 2;
    return `${path} C${middle} ${previous.y} ${middle} ${point.y} ${point.x} ${point.y}`;
  }, "");
}

export function MarketingShowcase() {
  const id = useId();
  const [range, setRange] = useState<(typeof ranges)[number]>("1W");
  const [selected, setSelected] = useState<number | null>(null);
  const [monitoring, setMonitoring] = useState(true);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const trace = useRef<SVGPathElement>(null);
  const values = readings[range];
  const index = selected ?? values.length - 1;
  const x = cursor?.x ?? 18 + (index * 864) / (values.length - 1);
  const y = cursor?.y ?? 485 - values[index] * 1.4;
  const inspectedValue = cursor ? Math.round((485 - y) / 1.4) : values[index];
  const path = chartPath(values);
  function inspectPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (event.type === "pointerdown")
      event.currentTarget.focus({ preventScroll: true });
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = Math.max(
      18,
      Math.min(882, ((event.clientX - bounds.left) / bounds.width) * 900),
    );
    if (trace.current && typeof trace.current.getTotalLength === "function") {
      let low = 0,
        high = trace.current.getTotalLength();
      for (let attempt = 0; attempt < 14; attempt++) {
        const middle = (low + high) / 2;
        if (trace.current.getPointAtLength(middle).x < localX) low = middle;
        else high = middle;
      }
      const point = trace.current.getPointAtLength((low + high) / 2);
      setCursor({ x: point.x, y: point.y });
    }
    setSelected(
      Math.max(
        0,
        Math.min(
          values.length - 1,
          Math.round(
            ((event.clientX - bounds.left) / bounds.width) *
              (values.length - 1),
          ),
        ),
      ),
    );
  }
  return (
    <div className={styles.showcase}>
      <div className={styles.window}>
        <div className={styles.topbar}>
          <div className={styles.workspace}>
            <PanelLeft />
            <Image
              src="/images/cupboard-logo.png"
              alt=""
              width={16}
              height={16}
            />
            <strong>Cupboard</strong>
            <span>/</span> Operations{" "}
            <span className={styles.environment}>
              <i /> Main server
            </span>
          </div>
          <Image
            className={styles.brand}
            src="/images/cupboard-logo.png"
            alt=""
            width={25}
            height={25}
          />
          <span className={styles.workspaceAction}>
            Your infrastructure <ChevronRight />
            <PanelLeft />
          </span>
        </div>
        <div className={styles.body}>
          <aside
            className={styles.sidebar}
            aria-label="Illustrated workspace navigation"
          >
            <div className={styles.console}>
              <span>
                <Terminal /> Console
              </span>
              <span>Overview</span>
            </div>
            {navigation.map(({ label, icon: Icon }) => (
              <div
                key={label}
                className={label === "Performance" ? styles.active : undefined}
              >
                <Icon />
                {label}
              </div>
            ))}
            <p>Organization</p>
            <div>
              <Users /> Team
            </div>
            <div>
              <ShieldCheck /> Security
            </div>
            <p>Your servers</p>
            <div>
              <span className={styles.plus}>+</span> Main server
            </div>
            <div>
              <span className={styles.plus}>+</span> Community
            </div>
            <div>
              <span className={styles.plus}>+</span> Build server
            </div>
          </aside>
          <div className={styles.main}>
            <div className={styles.toolbar}>
              <span>
                Operations <ChevronRight /> Performance
              </span>
              <div
                className={styles.ranges}
                role="group"
                aria-label="Performance time range"
              >
                {ranges.map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={range === value}
                    onClick={() => {
                      setRange(value);
                      setSelected(null);
                      setCursor(null);
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.report}>
              <div className={styles.reportTitle}>
                <h3>Server performance</h3>
                <span>
                  <ArrowUpRight /> Running smoothly
                </span>
              </div>
              <p className={styles.metadata}>
                Main server <span>Rust dedicated server</span>
                <span>14 readings</span>
              </p>
              <div className={styles.summary}>
                <div className={styles.metrics}>
                  <div>
                    <span>CURRENT</span>
                    <strong>
                      {values.at(-1)}
                      <small> FPS</small>
                    </strong>
                    <em>
                      <ArrowUpRight /> 15.8%
                    </em>
                  </div>
                  <div>
                    <span>TARGET</span>
                    <strong>
                      300<small> FPS</small>
                    </strong>
                    <em>Stable tick rate</em>
                  </div>
                </div>
                <div className={styles.monitor}>
                  <div>
                    <Switch
                      size="sm"
                      className={styles.monitorSwitch}
                      checked={monitoring}
                      onCheckedChange={setMonitoring}
                      aria-label="Machine monitoring"
                    />
                    <strong>Machine monitoring</strong>
                    <span>{monitoring ? "Connected" : "Paused"}</span>
                  </div>
                  <p>
                    {monitoring
                      ? "Server health and machine load, together."
                      : "Resume to follow server health and machine load."}
                  </p>
                </div>
              </div>
              <div
                className={styles.chart}
                role="slider"
                tabIndex={0}
                aria-label="Inspect server performance"
                aria-valuemin={1}
                aria-valuemax={values.length}
                aria-valuenow={index + 1}
                aria-valuetext={`Reading ${index + 1}: ${inspectedValue} frames per second`}
                onPointerMove={inspectPointer}
                onPointerDown={inspectPointer}
                onPointerLeave={() => {
                  setSelected(null);
                  setCursor(null);
                }}
                onFocus={() => {
                  setSelected(values.length - 1);
                  setCursor(null);
                }}
                onBlur={() => {
                  setSelected(null);
                  setCursor(null);
                }}
                onKeyDown={(event) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowDown",
                      "ArrowRight",
                      "ArrowUp",
                      "Home",
                      "End",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    setCursor(null);
                    setSelected(
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? values.length - 1
                          : Math.max(
                              0,
                              Math.min(
                                values.length - 1,
                                index +
                                  (["ArrowLeft", "ArrowDown"].includes(
                                    event.key,
                                  )
                                    ? -1
                                    : 1),
                              ),
                            ),
                    );
                  }
                }}
              >
                <svg
                  viewBox="0 0 900 350"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient
                      id={`${id}-area`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop stopColor="var(--primary)" stopOpacity=".07" />
                      <stop
                        offset="1"
                        stopColor="var(--primary)"
                        stopOpacity="0"
                      />
                    </linearGradient>
                  </defs>
                  <path d="M0 65 H900" className={styles.goalLine} />
                  <path
                    key={`${range}-area`}
                    d={`${path} L882 350 L18 350 Z`}
                    fill={`url(#${id}-area)`}
                  />
                  <path
                    key={range}
                    ref={trace}
                    d={path}
                    className={styles.line}
                    pathLength="1"
                  />
                  <circle
                    cx="882"
                    cy={485 - values[values.length - 1] * 1.4}
                    r="2.6"
                    className={styles.endpoint}
                  />
                  {selected !== null && (
                    <g
                      className={styles.inspection}
                      style={{ transform: `translateX(${x}px)` }}
                    >
                      <path d="M0 65 V350" />
                      <circle cx="0" cy={y} r="4" />
                    </g>
                  )}
                </svg>
                <span className={styles.target}>TARGET &nbsp; 300 FPS</span>
                {selected !== null && (
                  <div
                    className={styles.tooltip}
                    style={{
                      left: `${Math.max(9, Math.min(89, x / 9))}%`,
                      top: `${y / 3.5}%`,
                    }}
                  >
                    <strong>{inspectedValue} FPS</strong>
                    <span>Reading {index + 1} of 14</span>
                  </div>
                )}
                <div className={styles.axis}>
                  <span>MON</span>
                  <span>TUE</span>
                  <span>WED</span>
                  <span>THU</span>
                  <span>FRI</span>
                  <span>SAT</span>
                  <span>SUN</span>
                </div>
              </div>
              <div className={styles.details}>
                <span>All servers</span>
                <span>Machine load</span>
                <span>Player activity</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.fade} aria-hidden="true" />
      <div className={styles.blur} aria-hidden="true" />
    </div>
  );
}
