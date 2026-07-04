import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import triggerRouter from './routes/trigger.js';
import digestRouter from './routes/digest.js';
import adminRouter from './routes/admin.js';
import approveRouter from './routes/approve.js';

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/trigger', triggerRouter);
app.use('/api/digest', digestRouter);
app.use('/api/admin', adminRouter);
app.use('/api/approve', approveRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Strikemap Platform server listening on port ${PORT}`);
});
