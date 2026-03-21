import { describe, expect, it } from "@jest/globals";
import {
  getAutomationSupportReason,
  getDerivedTimeMode,
  isManualAutomationMode,
  isReactiveSupported,
  normalizeAutomationMode,
} from "../admin/automation.js";

describe("automation support policy", () => {
  it("normalizes automation mode safely", () => {
    expect(normalizeAutomationMode(undefined)).toBe("MANUAL");
    expect(normalizeAutomationMode("cron")).toBe("CRON");
    expect(normalizeAutomationMode("REACTIVE")).toBe("REACTIVE");
    expect(normalizeAutomationMode("unknown")).toBe("MANUAL");
  });

  it("supports reactive on supported evm testnet id", () => {
    expect(isReactiveSupported({ chainType: "evm", chainId: 11155111, chainKey: "evm_testnet" })).toBe(true);
    expect(getAutomationSupportReason({ chainType: "evm", chainId: 11155111, chainKey: "evm_testnet" })).toContain("supported");
  });

  it("rejects reactive on unsupported evm testnets", () => {
    expect(isReactiveSupported({ chainType: "evm", chainId: 43113, chainKey: "other_testnet" })).toBe(false);
    expect(getAutomationSupportReason({ chainType: "evm", chainId: 43113, chainKey: "other_testnet" })).toContain("limited");
  });

  it("rejects reactive on non-evm chains", () => {
    expect(isReactiveSupported({ chainType: "altvm", chainId: 1, chainKey: "altvm_testnet" })).toBe(false);
    expect(getAutomationSupportReason({ chainType: "altvm", chainId: 1, chainKey: "altvm_testnet" })).toContain("unsupported");
  });

  it("derives contract mode from automation mode", () => {
    expect(getDerivedTimeMode("MANUAL")).toBe("MANUAL");
    expect(getDerivedTimeMode("CRON")).toBe("NORMAL");
    expect(getDerivedTimeMode("REACTIVE")).toBe("NORMAL");
    expect(isManualAutomationMode("MANUAL")).toBe(true);
    expect(isManualAutomationMode("CRON")).toBe(false);
  });
});
