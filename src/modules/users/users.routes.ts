import { Router } from 'express';
import { usersController } from './users.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { updateProfileSchema } from './users.schema';

const router = Router();

// All user routes require authentication
router.use(authenticate);

/** GET /users/me */
router.get('/me', usersController.getMe.bind(usersController));

/** PUT /users/me */
router.put('/me', validate(updateProfileSchema), usersController.updateMe.bind(usersController));

/** GET /users/:id — Admin only */
router.get('/:id', requireAdmin, usersController.getUser.bind(usersController));

/** GET /users — Admin only (list all users with pagination) */
router.get('/', requireAdmin, usersController.listUsers.bind(usersController));

export default router;
