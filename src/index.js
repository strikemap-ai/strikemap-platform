import 'dotenv/config';
import express from 'express';
import healthRouter from './routes/health.js';
import triggerRouter from './routes/trigger.js';
import digestRouter from './routes/digest.js';
import adminRouter from './routes/admin.js';

const app = express();
app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/trigger', triggerRouter);
app.use('/api/digest', digestRouter);
app.use('/api/admin', adminRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Strikemap Platform server listening on port ${PORT}`);
});
