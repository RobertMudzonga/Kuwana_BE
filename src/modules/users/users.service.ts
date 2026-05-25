import { usersRepository } from './users.repository';
import { UpdateProfileDto } from './users.schema';
import { NotFoundError } from '../../middleware/error.middleware';

export class UsersService {
  async getProfile(userId: string) {
    const user = await usersRepository.findByIdSafe(userId);
    if (!user) throw new NotFoundError('User');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundError('User');
    await usersRepository.updateProfile(userId, dto);
    return usersRepository.findByIdSafe(userId);
  }

  async getUser(id: string) {
    const user = await usersRepository.findByIdSafe(id);
    if (!user) throw new NotFoundError('User');
    return user;
  }

  async listUsers(opts: { page: number; limit: number; role?: string; status?: string; search?: string }) {
    const skip = (opts.page - 1) * opts.limit;
    return usersRepository.findMany({ skip, take: opts.limit, ...opts });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    const user = await usersRepository.findById(id);
    if (!user) throw new NotFoundError('User');
    return usersRepository.updateStatus(id, status);
  }
}

export const usersService = new UsersService();
