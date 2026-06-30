import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jobsRouter from "./jobs";
import proposalsRouter from "./proposals";
import settingsRouter from "./settings";
import notificationsRouter from "./notifications";
import statsRouter from "./stats";
import scrapeRouter from "./scrape";
import scannerRouter from "./scanner";
import eventsRouter from "./events";
import monitorRouter from "./monitor";
import telegramWebhookRouter from "./telegram-webhook";
import applyTriggerRouter from "./apply-trigger";

const router: IRouter = Router();

router.use(healthRouter);
router.use(eventsRouter);
router.use(jobsRouter);
router.use(proposalsRouter);
router.use(settingsRouter);
router.use(notificationsRouter);
router.use(statsRouter);
router.use(scrapeRouter);
router.use(scannerRouter);
router.use(monitorRouter);
router.use(telegramWebhookRouter);
router.use(applyTriggerRouter);

export default router;
