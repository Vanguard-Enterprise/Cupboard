import { expect, it } from "vitest";
import { validMachineIp } from "./machines";
it.each([
  "192.0.2.1",
  "10.1.1.30",
  " 10.1.1.30 ",
  "2001:db8::1",
  "::1",
  "::ffff:192.0.2.1",
])("accepts IP %s", (address) => {
  expect(validMachineIp(address)).toBe(true);
});
it.each([
  "10.1.1.30.50",
  "256.1.2.3",
  "1.2.3",
  "01.2.3.4",
  "host.example.com",
  "https://10.1.1.1",
  "10.1.1.1:80",
  "[::1]",
  "2001:::1",
  "fe80::1%eth0",
  "",
])("rejects address %s", (address) => {
  expect(validMachineIp(address)).toBe(false);
});
