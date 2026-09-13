import { describe, expect, it } from "vitest";
import {
  createDevServerConfig,
  createNextDevArgs,
  findNetBirdAddress,
} from "./dev.mjs";

const address = (value) => ({
  address: value,
  family: "IPv4",
  internal: false,
  netmask: "255.255.255.0",
  cidr: `${value}/24`,
  mac: "00:00:00:00:00:00",
});

describe("development server configuration", () => {
  it("binds Next.js to every interface on the default port", () => {
    const config = createDevServerConfig({});

    expect(config).toMatchObject({
      hostname: "0.0.0.0",
      port: "5173",
      localUrl: "http://localhost:5173",
      netbirdUrl: undefined,
    });
    expect(createNextDevArgs(config)).toEqual([
      "./node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "0.0.0.0",
      "--port",
      "5173",
    ]);
  });

  it("prints the named NetBird interface URL with a custom port", () => {
    const config = createDevServerConfig(
      {
        eth0: [address("100.64.0.2")],
        wt0: [address("100.107.41.153")],
      },
      "6000",
    );

    expect(config.netbirdUrl).toBe("http://100.107.41.153:6000");
  });

  it("prefers the address reported by the NetBird daemon", () => {
    const config = createDevServerConfig(
      { wt0: [address("100.80.0.3")] },
      "5173",
      JSON.stringify({ netbirdIp: "100.107.41.153/16" }),
    );

    expect(config.netbirdUrl).toBe("http://100.107.41.153:5173");
  });

  it("does not label unrelated WireGuard or 100.x interfaces as NetBird", () => {
    const interfaces = {
      wg0: [address("100.64.0.1")],
      eth0: [address("100.107.41.153")],
    };

    expect(findNetBirdAddress(interfaces)).toBeUndefined();
  });
});
