export function validateWebhook(req, res, next) {
  const { token } = req.body;

  if (!token || token !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }

  next();
}
