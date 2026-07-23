import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import meRouter from './routes/me.js';
import triggerRouter from './routes/trigger.js';
import digestRouter from './routes/digest.js';
import adminRouter from './routes/admin.js';
import approveRouter from './routes/approve.js';
import rejectRouter from './routes/reject.js';
import pipelineRouter from './routes/pipeline.js';
import linkedinAcceptedRouter from './routes/linkedinAccepted.js';
import enrichmentRouter from './routes/enrichment.js';
import meetingBookedRouter from './routes/meetingBooked.js';
import sequencingRouter from './routes/sequencing.js';
import instantlyReplyRouter from './routes/webhooks/instantlyReply.js';
import connectSafelyMessageRouter from './routes/webhooks/connectSafelyMessage.js';
import clayEnrichmentCallbackRouter from './routes/webhooks/clayEnrichmentCallback.js';
import { startLinkedInAcceptancePolling } from './jobs/linkedinAcceptancePoller.js';
import { startDeliverabilityPolling } from './jobs/deliverabilityPoller.js';
import { startSequenceCompletionPolling } from './jobs/sequenceCompletionPoller.js';

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/me', meRouter);
app.use('/api/trigger', triggerRouter);
app.use('/api/digest', digestRouter);
app.use('/api/admin', adminRouter);
app.use('/api/approve', approveRouter);
app.use('/api/reject', rejectRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/linkedin/accepted', linkedinAcceptedRouter);
app.use('/api/enrichment', enrichmentRouter);
app.use('/api/meeting-booked', meetingBookedRouter);
app.use('/api/sequencing', sequencingRouter);
app.use('/api/webhooks/instantly/reply', instantlyReplyRouter);
app.use('/api/webhooks/connectsafely/message', connectSafelyMessageRouter);
app.use('/api/webhooks/clay/enrichment', clayEnrichmentCallbackRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Strikemap Platform server listening on port ${PORT}`);
});

startLinkedInAcceptancePolling();
startDeliverabilityPolling();
startSequenceCompletionPolling();
