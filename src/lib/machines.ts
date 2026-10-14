export type MachineHealth = {
  hostname: string;
  os: string;
  agentVersion: string;
  cpuCount: number;
  loadOne: number;
  cpuUsagePercent?: number | null;
  networkReceiveBytesPerSecond?: number | null;
  networkSendBytesPerSecond?: number | null;
  geolocation?: { publicIp: string; countryCode: string } | null;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
  uptimeSeconds: number;
};
export type MachineTag = { id: string; name: string };
export type Machine = {
  id: string;
  name: string;
  address: string;
  provider: string;
  notes: string;
  tags?: string[];
  revision: number;
  enrolled: boolean;
  enrolledAt: number | null;
  enrollmentExpiresAt: number | null;
  lastSeenAt: number | null;
  health: MachineHealth | null;
};
export function machineStatus(machine: Machine, now: number) {
  if (!machine.enrolled) return "Not enrolled";
  if (!machine.lastSeenAt) return "Awaiting report";
  return now - machine.lastSeenAt > 90_000 ? "Stale" : "Connected";
}

export function bytes(value: number) {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
export function observed(value: number | null) {
  return value ? new Date(value).toLocaleString() : "No report received";
}

export type MachineSample = {
  at: number;
  cpu: number | null;
  networkReceiveBytesPerSecond?: number | null;
  networkSendBytesPerSecond?: number | null;
  memoryUsed: number;
  memoryTotal: number;
  storageUsed: number;
  storageTotal: number;
};
export type MachineHistory = { samples: MachineSample[]; windowEnd: number };

export function machineLocation(machine: Machine) {
  const code = machine.health?.geolocation?.countryCode;
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? null;
}

export function validMachineIp(input: string) {
  const value = input.trim();
  if (!value.includes(":")) {
    const parts = value.split(".");
    return (
      parts.length === 4 &&
      parts.every(
        (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
      )
    );
  }
  if (!/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
