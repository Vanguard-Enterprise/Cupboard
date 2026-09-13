import { describe, expect, it } from "vitest";
import { createDevServerConfig, createNextDevArgs } from "./dev.mjs";

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

  it("falls back to an address in NetBird's carrier-grade NAT range", () => {
    const config = createDevServerConfig({ eth0: [address("100.90.0.4")] });

    expect(config.netbirdUrl).toBe("http://100.90.0.4:5173");
  });
});
