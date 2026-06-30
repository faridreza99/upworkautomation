import { Router, type IRouter } from "express";
import {
  getScannerStatus,
  triggerScan,
  updateScannerConfig,
} from "../lib/scanner.js";

const router: IRouter = Router();

router.get("/scanner/status", (_req, res) => {
  res.json(getScannerStatus());
});

router.post("/scanner/trigger", (req, res) => {
  const status = getScannerStatus();
  if (status.running) {
    res.status(409).json({ error: "Scanner is already running" });
    return;
  }
  triggerScan();
  res.json({ success: true, message: "Scan triggered" });
});

router.post("/scanner/configure", (req, res) => {
  const { enabled, intervalMinutes } = req.body as {
    enabled?: boolean;
    intervalMinutes?: number;
  };
  const current = getScannerStatus();
  const newEnabled = typeof enabled === "boolean" ? enabled : current.enabled;
  const newInterval = typeof intervalMinutes === "number" ? intervalMinutes : current.intervalMinutes;

  updateScannerConfig(newEnabled, newInterval);
  res.json({ success: true });
});

export default router;
