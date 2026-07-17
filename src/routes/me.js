import { Router } from 'express';
import { requireAuth, listUserAccess } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const clients = await listUserAccess(req.user.id);
    return res.status(200).json({ clients });
  } catch (err) {
    console.error('Error fetching user access:', {
      user_id: req.user.id,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
